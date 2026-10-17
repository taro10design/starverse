import { describe, expect, it } from "vitest";
import { COST, LIMITS, RATE } from "../src/config";
import { IdentifyBacklog, ViolationCounter, classify, extraCost, screenRaw } from "../src/inbound";
import { TokenBucket } from "../src/rate-limit";

const UID = "abcdef12-3456-7890-abcd-ef1234567890";
const json = (o: unknown) => JSON.stringify(o);

describe("screenRaw（JSON を読む前の関門）", () => {
  it("1 通ごとに 1 トークン使う", () => {
    const b = new TokenBucket(2, 0, 0, LIMITS.rateWindowMs);
    expect(screenRaw("{}", b, 0)).toBe("accept");
    expect(screenRaw("{}", b, 0)).toBe("accept");
    expect(screenRaw("{}", b, 0)).toBe("discard"); // 読まずに捨てる
  });

  it("大きすぎる・文字列でないメッセージは捨てるが、トークンは使う", () => {
    const b = new TokenBucket(2, 0, 0, LIMITS.rateWindowMs);
    expect(screenRaw("x".repeat(LIMITS.maxMessageBytes + 1), b, 0)).toBe("discard");
    expect(screenRaw(new ArrayBuffer(4), b, 0)).toBe("discard");
    expect(screenRaw("{}", b, 0)).toBe("discard"); // 上の 2 通でトークンが尽きた
  });

  it("大きすぎるメッセージを送り続けても切断される", () => {
    const b = newBucket();
    const big = "x".repeat(LIMITS.maxMessageBytes + 1);
    expect(send(b, 1000, 20_000, big)).toBe(true);
  });
});

// 実際の設定のバケット
const newBucket = () => new TokenBucket(RATE.capacity, RATE.refillPerSec, 0, LIMITS.rateWindowMs);

// 毎秒 perSec 通を durationMs の間、等間隔に送る。途中で切断（close）になったら true
function send(b: TokenBucket, perSec: number, durationMs: number, msg = "{}", from = 0): boolean {
  const n = Math.floor((perSec * durationMs) / 1000);
  for (let i = 0; i < n; i++) {
    if (screenRaw(msg, b, from + Math.floor((i * 1000) / perSec)) === "close") return true;
  }
  return false;
}

describe("screenRaw の切断条件（直近の窓で、あふれの割合と数）", () => {
  it("許容量の 2 倍（毎秒 80 通）を 20 秒送り続けると切断される", () => {
    expect(RATE.refillPerSec).toBe(40);
    expect(send(newBucket(), 80, 20_000)).toBe(true);
  });

  it("許容量の数倍を送り続けると、もっと早く切断される", () => {
    expect(send(newBucket(), 400, 3_000)).toBe(true);
  });

  it("許容量より少ない送信（毎秒 20 通）は、いつまでも切断されない", () => {
    expect(send(newBucket(), 20, 120_000)).toBe(false);
  });

  it("許容量ちょうど（毎秒 40 通）でも切断されない", () => {
    expect(send(newBucket(), 40, 60_000)).toBe(false);
  });

  it("短いバースト（一度に使える量を少し超える）では切断されない", () => {
    const b = newBucket();
    let closed = false;
    for (let i = 0; i < RATE.capacity + 150; i++) closed ||= screenRaw("{}", b, 0) === "close"; // 150 通あふれる
    closed ||= send(b, 20, 60_000, "{}", 1);
    expect(closed).toBe(false);
  });

  it("あふれが closeMinDrops 未満なら、割合が高くても切断しない", () => {
    const b = new TokenBucket(1, 0, 0, LIMITS.rateWindowMs);
    let closed = false;
    for (let i = 0; i < RATE.closeMinDrops; i++) closed ||= screenRaw("{}", b, 0) === "close"; // あふれは 99
    expect(closed).toBe(false);
    expect(screenRaw("{}", b, 0)).toBe("close"); // 100 通目のあふれ
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
  it("通算で数え、maxProtocolViolations 回目で切断を指示する（間に正しいメッセージがあっても減らない）", () => {
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
