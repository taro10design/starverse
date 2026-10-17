import { describe, expect, it } from "vitest";
import { COST, LIMITS, RATE } from "../src/config";
import { ID_MAX_LENGTH } from "../../shared/limits";
import {
  IdentifyBacklog,
  PositionPace,
  ViolationCounter,
  classify,
  extraCost,
  helloExpired,
  nextAlarmAt,
  rejectFor,
  screenRaw,
} from "../src/inbound";
import { TokenBucket } from "../src/rate-limit";

const UID = "abcdef12-3456-7890-abcd-ef1234567890";
const json = (o: unknown) => JSON.stringify(o);

describe("screenRaw（JSON を読む前の関門）", () => {
  it("1 通ごとに 1 トークン使う", () => {
    const b = new TokenBucket(2, 0, 0, LIMITS.rateWindowMs);
    expect(screenRaw("{}", b, 0)).toBe("accept");
    expect(screenRaw("{}", b, 0)).toBe("accept");
    expect(screenRaw("{}", b, 0)).toBe("limited"); // 読まずに捨てる（星・線なら reject だけ返す。rejectFor）
  });

  it("大きすぎる・文字列でないメッセージは捨てるが、トークンは使う", () => {
    const b = new TokenBucket(2, 0, 0, LIMITS.rateWindowMs);
    expect(screenRaw("x".repeat(LIMITS.maxMessageBytes + 1), b, 0)).toBe("discard");
    expect(screenRaw(new ArrayBuffer(4), b, 0)).toBe("discard");
    expect(screenRaw("{}", b, 0)).toBe("limited"); // 上の 2 通でトークンが尽きた
  });

  it("大きさは UTF-8 のバイト数で見る（文字数ではない）", () => {
    const b = new TokenBucket(10, 0, 0, LIMITS.rateWindowMs);
    const fits = "あ".repeat(Math.floor(LIMITS.maxMessageBytes / 3)); // 3 バイト × 170 = 510 バイト
    const over = "あ".repeat(Math.floor(LIMITS.maxMessageBytes / 3) + 1); // 513 バイト（文字数は 171）
    expect(over.length).toBeLessThan(LIMITS.maxMessageBytes);
    expect(screenRaw(fits, b, 0)).toBe("accept");
    expect(screenRaw(over, b, 0)).toBe("discard");
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

  it("hello 後: 他のメッセージは処理へ。種類は正しいが形の合わないものは無視", () => {
    expect(classify(true, json({ t: "unstar", id: "s1" }))).toEqual({ do: "dispatch", msg: { t: "unstar", id: "s1" } });
    expect(classify(true, json({ t: "star", id: "s1", x: "NaN", y: 0, c: 0 }))).toEqual({ do: "ignore" });
  });

  it("hello 後: 読めない JSON・未知の t は違反（正規のクライアントは送らない）", () => {
    expect(classify(true, "not json")).toEqual({ do: "violation" });
    expect(classify(true, json({ t: "evil" }))).toEqual({ do: "violation" });
    expect(classify(true, "123")).toEqual({ do: "violation" });
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

describe("hello の締め切り", () => {
  it("接続から helloTimeoutMs を過ぎたら締め切り", () => {
    expect(helloExpired(0, LIMITS.helloTimeoutMs - 1)).toBe(false);
    expect(helloExpired(0, LIMITS.helloTimeoutMs)).toBe(true);
  });

  it("次の alarm: hello を待つ接続も、星・線も無ければ張らない（null）", () => {
    expect(nextAlarmAt(1000, [], null)).toBeNull();
  });

  it("次の alarm: 次に寿命が切れる時刻。ただし alarmMinMs 以上・alarmMaxMs 以下に収める", () => {
    const now = 1_000_000;
    expect(nextAlarmAt(now, [], now + 120_000)).toBe(now + 120_000);
    expect(nextAlarmAt(now, [], now + 1000)).toBe(now + LIMITS.alarmMinMs); // 起き続けない
    expect(nextAlarmAt(now, [], now - 5000)).toBe(now + LIMITS.alarmMinMs); // 過ぎていても同じ
    expect(nextAlarmAt(now, [], now + 10 * LIMITS.alarmMaxMs)).toBe(now + LIMITS.alarmMaxMs);
  });

  it("次の alarm: hello を待つ接続があれば、いちばん早い締め切りに早める（ただし 1 秒より先）", () => {
    expect(nextAlarmAt(5000, [4000, 2000], null)).toBe(2000 + LIMITS.helloTimeoutMs);
    expect(nextAlarmAt(5000, [4000, 2000], 5000 + 3_600_000)).toBe(2000 + LIMITS.helloTimeoutMs);
    expect(nextAlarmAt(50_000, [0], null)).toBe(51_000); // 締め切りを過ぎていても、すぐには鳴らさない
  });
});

describe("screenRaw（バイナリ）", () => {
  it("ArrayBufferView も文字列でないので捨てる（トークンは使う）", () => {
    const b = new TokenBucket(1, 0, 0, LIMITS.rateWindowMs);
    expect(screenRaw(new Uint8Array(2), b, 0)).toBe("discard");
    expect(screenRaw("{}", b, 0)).toBe("limited");
  });
});

describe("rejectFor（レート制限で読まずに捨てた星・線への reject）", () => {
  it("星・線の作成なら、t と id だけを取り出して reject を作る", () => {
    expect(rejectFor(json({ t: "star", id: "s1", x: 0, y: 0, c: 0 }))).toEqual({ t: "reject", kind: "star", id: "s1" });
    expect(rejectFor(json({ t: "link", id: "l1", a: "x", b: "y" }))).toEqual({ t: "reject", kind: "link", id: "l1" });
  });

  it("id は受け付けるときと同じ長さに切り詰める（クライアントが取り消す id と合わせる）", () => {
    const long = "x".repeat(ID_MAX_LENGTH + 10);
    expect(rejectFor(json({ t: "star", id: long }))).toEqual({
      t: "reject",
      kind: "star",
      id: long.slice(0, ID_MAX_LENGTH),
    });
  });

  it("星・線の作成以外・読めないもの・id の無いもの・大きすぎるものは null（黙って捨てる）", () => {
    expect(rejectFor(json({ t: "unstar", id: "s1" }))).toBeNull();
    expect(rejectFor(json({ t: "p", x: 0, y: 0, c: 0 }))).toBeNull();
    expect(rejectFor("not json")).toBeNull();
    expect(rejectFor('{"t":"star"')).toBeNull();
    expect(rejectFor(json({ t: "star", id: 5 }))).toBeNull();
    expect(rejectFor(json({ t: "star", id: "" }))).toBeNull();
    expect(rejectFor(json({ t: "star", id: "s1", pad: "x".repeat(LIMITS.maxMessageBytes) }))).toBeNull();
  });
});

describe("PositionPace（位置の送り過ぎ）", () => {
  // 毎 everyMs ごとに p を n 通。途中で切断になったら true
  function run(pace: PositionPace, everyMs: number, n: number, sendMs: number, from = 0): boolean {
    for (let i = 0; i < n; i++) if (pace.record(from + i * everyMs, sendMs)) return true;
    return false;
  }

  it("指示どおりの間隔（とその半分まで）なら、いつまでも切断しない", () => {
    expect(run(new PositionPace(), 100, 1200, 100)).toBe(false);
    expect(run(new PositionPace(), 50, 2400, 100)).toBe(false); // ちょうど半分は「短い」に入らない
    expect(run(new PositionPace(), 1000, 120, 1000)).toBe(false);
  });

  it("通信の遅れでまとめて届いても（3 秒止まって 30 通）、切断しない", () => {
    const pace = new PositionPace();
    expect(run(pace, 100, 50, 100)).toBe(false);
    expect(run(pace, 0, 30, 100, 8000)).toBe(false);
    expect(run(pace, 100, 100, 100, 8100)).toBe(false);
  });

  it("指示より速く送り続ける接続は、窓の中で maxFastPositions 通に達したら切断する", () => {
    // 満員近く（指示 600ms）の空で、上限いっぱい（毎秒 40 通）で送る
    const pace = new PositionPace();
    let closedAt = -1;
    for (let i = 0; i < 400 && closedAt < 0; i++) if (pace.record(i * 25, 600)) closedAt = i;
    expect(closedAt).toBe(LIMITS.maxFastPositions); // 最初の 1 通は間隔が分からないので数えない
  });
});

describe("正規の操作はレート制限に掛からない（トークンの回復量を人数で絞らない理由）", () => {
  // 1 通ぶんを、関門（screenRaw）と追加のトークン（extraCost）に通す
  const pass = (b: TokenBucket, t: keyof typeof COST, now: number) =>
    screenRaw("{}", b, now) === "accept" && b.take(extraCost(t), now);

  it("なぞって星を毎秒 20 個（上限の 64 個）置きながら 10Hz で位置を送り、そのあと 64 個を一括で消せる", () => {
    const b = newBucket();
    const events: [number, keyof typeof COST][] = [];
    for (let i = 0; i < LIMITS.maxStarsPerUser; i++) events.push([i * 50, "star"]);
    for (let t = 0; t < LIMITS.maxStarsPerUser * 50; t += 100) events.push([t, "p"]);
    events.sort((a, b) => a[0] - b[0]);
    const end = LIMITS.maxStarsPerUser * 50;
    for (let i = 0; i < LIMITS.maxStarsPerUser; i++) events.push([end, "unstar"]);
    expect(events.every(([now, t]) => pass(b, t, now))).toBe(true);
  });
});
