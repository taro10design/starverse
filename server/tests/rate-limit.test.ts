import { describe, expect, it } from "vitest";
import { Cooldown, TokenBucket } from "../src/rate-limit";

describe("TokenBucket", () => {
  it("容量まではバーストできる", () => {
    const b = new TokenBucket(5, 1, 0, 10_000);
    for (let i = 0; i < 5; i++) expect(b.take(1, 0)).toBe(true);
    expect(b.take(1, 0)).toBe(false);
  });

  it("時間とともに回復する", () => {
    const b = new TokenBucket(2, 10, 0, 10_000); // 毎秒10
    b.take(2, 0);
    expect(b.take(1, 0)).toBe(false);
    expect(b.take(1, 100)).toBe(true); // 100ms で 1 回復
    expect(b.take(1, 100)).toBe(false);
  });

  it("容量を超えて貯まらない", () => {
    const b = new TokenBucket(3, 100, 0, 10_000);
    expect(b.take(3, 10_000)).toBe(true);
    expect(b.take(1, 10_000)).toBe(false);
  });

  it("コストの大きい操作は多くのトークンを使う", () => {
    const b = new TokenBucket(4, 0, 0, 10_000);
    expect(b.take(3, 0)).toBe(true);
    expect(b.take(2, 0)).toBe(false);
  });

  it("直近の窓の中で、通した数とあふれた数を数える", () => {
    const b = new TokenBucket(1, 1, 0, 10_000);
    b.take(1, 0); // 通る
    b.take(1, 0); // あふれ
    b.take(1, 500); // あふれ
    expect(b.recent(500)).toEqual({ passed: 1, dropped: 2 });
    b.take(1, 2000); // 回復して通る
    expect(b.recent(2000)).toEqual({ passed: 2, dropped: 2 });
  });

  it("窓より古い分は数えない（1 秒刻み）", () => {
    const b = new TokenBucket(1, 0, 0, 10_000);
    b.take(1, 0);
    b.take(1, 0);
    expect(b.recent(9_999)).toEqual({ passed: 1, dropped: 1 });
    expect(b.recent(10_000)).toEqual({ passed: 0, dropped: 0 }); // 0 秒目の枠が窓から出た
    b.take(1, 25_000);
    expect(b.recent(25_000)).toEqual({ passed: 0, dropped: 1 }); // 何周しても古い枠を混ぜない
  });

  it("回復した分だけ時々通る大量送信でも、あふれは窓の中に貯まる", () => {
    const b = new TokenBucket(10, 40, 0, 10_000);
    // 毎秒 1000 通（1ms ごと）を 1 秒間。通るのは毎秒 40 通ほど
    for (let t = 0; t < 1000; t++) b.take(1, t);
    expect(b.recent(999).dropped).toBeGreaterThan(900);
  });
});

describe("Cooldown（同じ鍵の操作の間隔）", () => {
  it("間隔内の 2 回目は断り、間隔を過ぎれば通す", () => {
    const c = new Cooldown(5000, 10);
    expect(c.allow("s1", 0)).toBe(true);
    expect(c.allow("s1", 4999)).toBe(false);
    expect(c.allow("s2", 4999)).toBe(true); // 別の鍵は別
    expect(c.allow("s1", 5000)).toBe(true);
    expect(c.allow("s1", 5001)).toBe(false);
  });

  it("断った操作では時刻を更新しない（連打し続けても間隔ごとに 1 回は通る）", () => {
    const c = new Cooldown(5000, 10);
    c.allow("s1", 0);
    for (let t = 100; t < 5000; t += 100) c.allow("s1", t);
    expect(c.allow("s1", 5000)).toBe(true);
  });

  it("覚える鍵の数に上限がある（古いものから忘れる）", () => {
    const c = new Cooldown(5000, 3);
    for (const k of ["a", "b", "c", "d"]) c.allow(k, 0);
    expect(c.size).toBeLessThanOrEqual(3);
    expect(c.allow("a", 1)).toBe(true); // 一番古い a は忘れている
    expect(c.allow("d", 1)).toBe(false);
  });

  it("上限に達したら、期限の切れた鍵から捨てる", () => {
    const c = new Cooldown(5000, 3);
    c.allow("old", 0);
    c.allow("b", 4000);
    c.allow("c", 4000);
    c.allow("d", 6000); // old は期限切れなので捨てられる
    expect(c.allow("b", 6001)).toBe(false);
    expect(c.allow("c", 6001)).toBe(false);
    expect(c.size).toBeLessThanOrEqual(3);
  });
});
