// トークンバケットによるレート制限。時刻は引数で受け取る（テストしやすいように）。

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
      this.drops = 0;
      return true;
    }
    this.drops++;
    return false;
  }

  // 連続であふれた回数。多すぎる接続は切る判断に使う
  get consecutiveDrops(): number {
    return this.drops;
  }
}
