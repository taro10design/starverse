// レート制限の部品。時刻は引数で受け取る（テストしやすいように）。どれもメモリ上だけで持ち、
// ハイバネートで失われてよい近似として使う。

// トークンバケット。接続ごとの受信量を制限する
export class TokenBucket {
  private tokens: number;
  private last: number;
  private drops = 0;

  constructor(
    private capacity: number,
    private refillPerSec: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  // cost ぶん使えるなら true。足りなければ false（その操作は捨てる）
  take(cost: number, now: number): boolean {
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.refillPerSec);
    if (this.tokens >= cost) {
      this.tokens -= cost;
      if (this.drops > 0) this.drops--;
      return true;
    }
    this.drops++;
    return false;
  }

  // あふれの数。あふれるたびに +1、通るたびに -1。
  // 「連続」で数えると、回復した分だけ時々通る大量送信がいつまでも切られないので、差し引きで数える
  get excessDrops(): number {
    return this.drops;
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

// 鍵ごとに、直近 windowMs の間に通した回数を max までに抑える（例: 同じ接続元からの接続の頻度）
export class WindowCounter {
  private hits = new Map<string, number[]>(); // 挿入順 = 古い順

  constructor(
    private windowMs: number,
    private max: number,
    private maxKeys: number,
  ) {}

  // 通すなら true（そのときだけ数える）。断った回は数えない
  allow(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.delete(key);
    this.makeRoom(now);
    this.hits.set(key, recent);
    return true;
  }

  get size(): number {
    return this.hits.size;
  }

  private makeRoom(now: number) {
    if (this.hits.size < this.maxKeys) return;
    for (const [k, ts] of this.hits) if (ts.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    while (this.hits.size >= this.maxKeys) {
      const oldest = this.hits.keys().next();
      if (oldest.done) break;
      this.hits.delete(oldest.value);
    }
  }
}
