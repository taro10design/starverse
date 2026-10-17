// レート制限の部品。時刻は引数で受け取る（テストしやすいように）。どれもメモリ上だけで持ち、
// ハイバネートで失われてよい近似として使う。

// トークンバケット。接続ごとの受信量を制限する。
// 直近 windowMs の中で、通した数とあふれた数を 1 秒刻みのリングで数える（切断の判定に使う。inbound.ts）
export class TokenBucket {
  private tokens: number;
  private last: number;
  private ring: { sec: number; passed: number; dropped: number }[];

  constructor(
    private capacity: number,
    private refillPerSec: number,
    now: number,
    windowMs: number,
  ) {
    this.tokens = capacity;
    this.last = now;
    const slots = Math.max(1, Math.ceil(windowMs / 1000));
    this.ring = Array.from({ length: slots }, () => ({ sec: Number.NEGATIVE_INFINITY, passed: 0, dropped: 0 }));
  }

  // cost ぶん使えるなら true。足りなければ false（その操作は捨てる）
  take(cost: number, now: number): boolean {
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.refillPerSec);
    const slot = this.slotAt(now);
    if (this.tokens >= cost) {
      this.tokens -= cost;
      slot.passed++;
      return true;
    }
    slot.dropped++;
    return false;
  }

  // 直近の窓（今の 1 秒を含む）で、通した数とあふれた数
  recent(now: number): { passed: number; dropped: number } {
    const sec = Math.floor(now / 1000);
    let passed = 0;
    let dropped = 0;
    for (const s of this.ring) {
      if (sec - s.sec >= this.ring.length) continue; // 窓より古い
      passed += s.passed;
      dropped += s.dropped;
    }
    return { passed, dropped };
  }

  private slotAt(now: number) {
    const sec = Math.floor(now / 1000);
    const slot = this.ring[((sec % this.ring.length) + this.ring.length) % this.ring.length];
    if (slot.sec !== sec) {
      slot.sec = sec;
      slot.passed = 0;
      slot.dropped = 0;
    }
    return slot;
  }
}

// 同じ鍵の操作を、一定の間隔に 1 回だけ通す（例: 同じ星へのきらめき）。覚える鍵の数に上限を持つ
export class Cooldown {
  private last = new Map<string, number>(); // 挿入順 = 古い順

  constructor(
    private intervalMs: number,
    private maxEntries: number,
  ) {}

  allow(key: string, now: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < this.intervalMs) return false;
    this.last.delete(key); // 入れ直して、新しい側に並べる
    this.makeRoom(now);
    this.last.set(key, now);
    return true;
  }

  get size(): number {
    return this.last.size;
  }

  private makeRoom(now: number) {
    if (this.last.size < this.maxEntries) return;
    for (const [k, t] of this.last) if (now - t >= this.intervalMs) this.last.delete(k);
    while (this.last.size >= this.maxEntries) {
      const oldest = this.last.keys().next();
      if (oldest.done) break;
      this.last.delete(oldest.value);
    }
  }
}

// 直近 windowMs の中で起きた数（1 秒刻みのリング）。例: 部屋全体で新しく作った星の数
export class SlidingCount {
  private ring: { sec: number; n: number }[];

  constructor(windowMs: number) {
    const slots = Math.max(1, Math.ceil(windowMs / 1000));
    this.ring = Array.from({ length: slots }, () => ({ sec: Number.NEGATIVE_INFINITY, n: 0 }));
  }

  add(now: number, n = 1) {
    const sec = Math.floor(now / 1000);
    const slot = this.ring[((sec % this.ring.length) + this.ring.length) % this.ring.length];
    if (slot.sec !== sec) {
      slot.sec = sec;
      slot.n = 0;
    }
    slot.n += n;
  }

  // 直近の窓（今の 1 秒を含む）の合計
  total(now: number): number {
    const sec = Math.floor(now / 1000);
    let n = 0;
    for (const s of this.ring) if (sec - s.sec < this.ring.length) n += s.n;
    return n;
  }
}

// 鍵ごとの「今いくつあるか」を、上限つきで数える。例: 同じ接続元（IP）からの同時接続数。
// 数が 0 になった鍵は忘れる（覚える鍵の数は、今ある接続の数を超えない）
export class KeyedCounter {
  private counts = new Map<string, number>();

  constructor(private max: number) {}

  // 上限に達していなければ 1 増やして true
  tryAdd(key: string): boolean {
    const n = this.counts.get(key) ?? 0;
    if (n >= this.max) return false;
    this.counts.set(key, n + 1);
    return true;
  }

  remove(key: string) {
    const n = (this.counts.get(key) ?? 0) - 1;
    if (n > 0) this.counts.set(key, n);
    else this.counts.delete(key);
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  get size(): number {
    return this.counts.size;
  }
}
