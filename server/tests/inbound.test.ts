import { describe, expect, it } from "vitest";
import { COST, LIMITS, RATE } from "../src/config";
import { IdentifyBacklog, ViolationCounter, classify, extraCost, screenRaw } from "../src/inbound";
import { TokenBucket } from "../src/rate-limit";

const UID = "abcdef12-3456-7890-abcd-ef1234567890";
const json = (o: unknown) => JSON.stringify(o);

describe("screenRaw（JSON を読む前の関門）", () => {
  it("1 通ごとに 1 トークン使う", () => {
    const b = new TokenBucket(2, 0, 0);
    expect(screenRaw("{}", b, 0)).toBe("accept");
    expect(screenRaw("{}", b, 0)).toBe("accept");
    expect(screenRaw("{}", b, 0)).toBe("discard"); // 読まずに捨てる
  });

  it("大きすぎる・文字列でないメッセージは捨てるが、トークンは使う", () => {
    const b = new TokenBucket(2, 0, 0);
    expect(screenRaw("x".repeat(LIMITS.maxMessageBytes + 1), b, 0)).toBe("discard");
    expect(screenRaw(new ArrayBuffer(4), b, 0)).toBe("discard");
    expect(screenRaw("{}", b, 0)).toBe("discard"); // 上の 2 通でトークンが尽きた
  });

  it("あふれ続けたら切断する", () => {
    const b = new TokenBucket(RATE.capacity, RATE.refillPerSec, 0);
    let verdict = "accept";
    for (let i = 0; i < RATE.capacity + RATE.closeAfterDrops + 1; i++) verdict = screenRaw("{}", b, 0);
    expect(verdict).toBe("close");
  });

  it("大きすぎるメッセージを送り続けても切断される", () => {
    const b = new TokenBucket(RATE.capacity, RATE.refillPerSec, 0);
    const big = "x".repeat(LIMITS.maxMessageBytes + 1);
    let verdict = "accept";
    for (let i = 0; i < RATE.capacity + RATE.closeAfterDrops + 1; i++) verdict = screenRaw(big, b, 0);
    expect(verdict).toBe("close");
  });
});

describe("extraCost（読んだあとに追加で取るトークン）", () => {
  it("1 通ぶんは読む前に取っているので、合計が COST になるよう残りを返す", () => {
    for (const t of Object.keys(COST) as (keyof typeof COST)[]) expect(extraCost(t) + 1).toBe(COST[t]);
  });
});

describe("classify（hello の前後での振り分け）", () => {
  it("hello 前: 正しい hello は持ち主の確定へ", () => {
    expect(classify(false, json({ t: "hello", uid: UID }))).toEqual({ do: "identify", uid: UID });
  });

  it("hello 前: 形式の合わない uid は即切断", () => {
    expect(classify(false, json({ t: "hello", uid: "short" }))).toEqual({ do: "invalid-uid" });
  });

  it("hello 前: hello 以外・読めないものは違反", () => {
    expect(classify(false, json({ t: "star", id: "s", x: 0, y: 0, c: 0 }))).toEqual({ do: "violation" });
    expect(classify(false, "not json")).toEqual({ do: "violation" });
  });

  it("hello 後: 2 回目の hello・不正な hello は違反", () => {
    expect(classify(true, json({ t: "hello", uid: UID }))).toEqual({ do: "violation" });
    expect(classify(true, json({ t: "hello", uid: "short" }))).toEqual({ do: "violation" });
  });

  it("hello 後: 他のメッセージは処理へ、読めないものは無視", () => {
    expect(classify(true, json({ t: "unstar", id: "s1" }))).toEqual({ do: "dispatch", msg: { t: "unstar", id: "s1" } });
    expect(classify(true, "not json")).toEqual({ do: "ignore" });
  });
});

describe("ViolationCounter", () => {
  it("maxProtocolViolations 回目で切断を指示する", () => {
    const v = new ViolationCounter(LIMITS.maxProtocolViolations);
    for (let i = 1; i < LIMITS.maxProtocolViolations; i++) expect(v.record()).toBe(false);
    expect(v.record()).toBe(true);
  });
});

describe("IdentifyBacklog（hello の処理中に届いたメッセージ）", () => {
  it("上限までは貯める", () => {
    const q = new IdentifyBacklog(2);
    q.push("a");
    q.push("b");
    expect(q.items).toEqual(["a", "b"]);
    expect(q.rejects).toEqual([]);
  });

  it("上限を超えた星・線は、断ったこと（reject）を返せるように覚えておく", () => {
    const q = new IdentifyBacklog(1);
    q.push(json({ t: "p", x: 0, y: 0, c: 0 }));
    q.push(json({ t: "star", id: "s1", x: 0, y: 0, c: 0 }));
    q.push(json({ t: "link", id: "l1", a: "s1", b: "s2" }));
    q.push(json({ t: "unstar", id: "s9" })); // 星・線の作成以外は黙って捨てる
    q.push("not json");
    expect(q.items).toHaveLength(1);
    expect(q.rejects).toEqual([
      { t: "reject", kind: "star", id: "s1" },
      { t: "reject", kind: "link", id: "l1" },
    ]);
  });

  it("reject の数にも上限がある", () => {
    const q = new IdentifyBacklog(0, 2);
    for (let i = 0; i < 5; i++) q.push(json({ t: "star", id: `s${i}`, x: 0, y: 0, c: 0 }));
    expect(q.rejects).toHaveLength(2);
  });
});
