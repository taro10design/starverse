import { describe, expect, it } from "vitest";
import { TokenBucket } from "../src/rate-limit";

describe("TokenBucket", () => {
  it("容量まではバーストできる", () => {
    const b = new TokenBucket(5, 1, 0);
    for (let i = 0; i < 5; i++) expect(b.take(1, 0)).toBe(true);
    expect(b.take(1, 0)).toBe(false);
  });

  it("時間とともに回復する", () => {
    const b = new TokenBucket(2, 10, 0); // 毎秒10
    b.take(2, 0);
    expect(b.take(1, 0)).toBe(false);
    expect(b.take(1, 100)).toBe(true); // 100ms で 1 回復
    expect(b.take(1, 100)).toBe(false);
  });

  it("容量を超えて貯まらない", () => {
    const b = new TokenBucket(3, 100, 0);
    expect(b.take(3, 10_000)).toBe(true);
    expect(b.take(1, 10_000)).toBe(false);
  });

  it("コストの大きい操作は多くのトークンを使う", () => {
    const b = new TokenBucket(4, 0, 0);
    expect(b.take(3, 0)).toBe(true);
    expect(b.take(2, 0)).toBe(false);
  });

  it("連続であふれた回数を数え、成功でリセットする", () => {
    const b = new TokenBucket(1, 1, 0);
    b.take(1, 0);
    b.take(1, 0);
    b.take(1, 0);
    expect(b.consecutiveDrops).toBe(2);
    b.take(1, 5000);
    expect(b.consecutiveDrops).toBe(0);
  });
});
