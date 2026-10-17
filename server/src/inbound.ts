// 受信メッセージの関門。Durable Object に依存しない純粋な部品で、room.ts が順に使う。
//
// 1. screenRaw: JSON を読む前に、1 通ごとに 1 トークン取る（大きすぎる・文字列でないものも数える）。
//    読む前に絞るので、壊れたメッセージや hello の連打でも JSON.parse の負荷を受け続けない。
//    トークンが足りずに捨てた星・線には、rejectFor で reject だけを返す（送り主の画面から取り消してもらう）。
// 2. classify: hello の前後で、持ち主の確定・処理・違反・無視に振り分ける。
// 3. extraCost: 処理する前に、COST との差だけ追加でトークンを取る（合計は COST どおり）。
// 4. PositionPace: 位置（p）を、指示した送信間隔よりずっと速く送り続ける接続を見つける。

import { ID_MAX_LENGTH } from "../../shared/limits";
import type { ServerMessage } from "../../shared/protocol";
import { COST, LIMITS, RATE } from "./config";
import type { MemberMessage } from "./handlers";
import { SlidingCount, type TokenBucket } from "./rate-limit";
import { INVALID_HELLO, parseClientMessage, readJson, UNREADABLE } from "./validate";

const BASE_COST = 1; // 読む前に取る分

const encoder = new TextEncoder();

// UTF-8 で maxMessageBytes 以下か。1 文字は最大 3 バイト（UTF-16 の 1 単位あたり）なので、
// 文字数だけで決まるときはエンコードしない
export function fitsMessageBytes(s: string): boolean {
  if (s.length > LIMITS.maxMessageBytes) return false;
  if (s.length * 3 <= LIMITS.maxMessageBytes) return true;
  return encoder.encode(s).length <= LIMITS.maxMessageBytes;
}

// accept なら読んでよい。discard は黙って捨てる（大きすぎる・文字列でない）。
// limited はトークンが足りないので読まずに捨てる（星・線なら rejectFor で reject を返す）。close はあふれ続けているので切断する
export type RawVerdict = "accept" | "discard" | "limited" | "close";

export function screenRaw(
  message: string | ArrayBuffer | ArrayBufferView,
  bucket: TokenBucket,
  now: number,
): RawVerdict {
  if (!bucket.take(BASE_COST, now)) return isFlooding(bucket, now) ? "close" : "limited";
  if (typeof message !== "string" || !fitsMessageBytes(message)) return "discard";
  return "accept";
}

// 切断するほどあふれているか。直近の窓で、あふれの割合が closeOverflowRatio 以上かつ closeMinDrops 通以上。
// 割合で見るので、許容量を大きく超えて送り続ける接続は切れ、短いバーストや通常の連打では切れない
export function isFlooding(bucket: TokenBucket, now: number): boolean {
  const { passed, dropped } = bucket.recent(now);
  return dropped >= RATE.closeMinDrops && dropped >= (passed + dropped) * RATE.closeOverflowRatio;
}

export function extraCost(t: MemberMessage["t"]): number {
  return Math.max(0, COST[t] - BASE_COST);
}

type Reject = Extract<ServerMessage, { t: "reject" }>;

// 読まずに捨てたメッセージが星・線の作成なら、その reject。t と id だけを見る（形の検証はしない）。
// JSON.parse は 1 回だけで、"star" / "link" の文字列を含まないもの・大きすぎるものは読まない。
// id は受け付けるときと同じく ID_MAX_LENGTH に切り詰める（クライアントが取り消す id と合わせる）
export function rejectFor(raw: string): Reject | null {
  if (!fitsMessageBytes(raw) || !/"(star|link)"/.test(raw)) return null;
  const json = readJson(raw);
  if (!json.ok || typeof json.value !== "object" || json.value === null) return null;
  const { t, id } = json.value as { t?: unknown; id?: unknown };
  if ((t !== "star" && t !== "link") || typeof id !== "string" || id.length === 0) return null;
  return { t: "reject", kind: t, id: id.slice(0, ID_MAX_LENGTH) };
}

export type Step =
  | { do: "identify"; uid: string } // 持ち主を確定する
  | { do: "dispatch"; msg: MemberMessage } // handlers で処理する
  | { do: "invalid-uid" } // 形式の合わない uid の hello。切り詰めずに切断する
  | { do: "violation" } // 手順の違反（hello 前の hello 以外、2 回目以降の hello、読めない JSON・知らない t）
  | { do: "ignore" }; // t は知っているが形・範囲が合わない

export function classify(isMember: boolean, raw: string): Step {
  const msg = parseClientMessage(raw);
  if (!isMember) {
    if (msg === INVALID_HELLO) return { do: "invalid-uid" };
    if (msg !== null && msg !== UNREADABLE && msg.t === "hello") return { do: "identify", uid: msg.uid };
    return { do: "violation" };
  }
  if (msg === UNREADABLE) return { do: "violation" }; // 正規のクライアントは送らない
  if (msg === null) return { do: "ignore" }; // 範囲外の座標など。トークンは screenRaw で取っている
  if (msg === INVALID_HELLO || msg.t === "hello") return { do: "violation" }; // 持ち主は接続につき 1 つに固定する
  return { do: "dispatch", msg };
}

// hello の締め切りを過ぎたか（接続した時刻 since から helloTimeoutMs）
export function helloExpired(since: number, now: number): boolean {
  return now - since >= LIMITS.helloTimeoutMs;
}

// 次の alarm の時刻。null なら張らない（休止中の Durable Object を起こさない）。
// - expiry: 次に寿命が切れる星・線の時刻（World.nextExpiryAt）。alarmMinMs〜alarmMaxMs 先に収める
// - waiting: hello を待っている接続の、接続した時刻。締め切りに合わせて早める（過ぎていても 1 秒は空ける）
export function nextAlarmAt(now: number, waiting: Iterable<number>, expiry: number | null): number | null {
  let at: number | null = null;
  if (expiry !== null) at = Math.min(now + LIMITS.alarmMaxMs, Math.max(now + LIMITS.alarmMinMs, expiry));
  for (const since of waiting) {
    const deadline = Math.max(now + 1000, since + LIMITS.helloTimeoutMs);
    at = at === null ? deadline : Math.min(at, deadline);
  }
  return at;
}

// 手順の違反を数える。通算で数え、減らさない（間に正しいメッセージがあっても）。limit 回目で true（切断する）
export class ViolationCounter {
  private n = 0;

  constructor(private limit: number) {}

  record(): boolean {
    this.n++;
    return this.n >= this.limit;
  }
}

// 位置（p）の送り過ぎ。受け取った p は課金される（20 通 = 1 リクエスト。ADR 0008）ので、受け取ったあとに
// 捨てても費用は減らない。減らせるのは、指示を守らない接続を切ることだけ。
// 前の p から「指示した送信間隔の半分」より短い間隔で届いた p を直近 rateWindowMs で数え、maxFastPositions に
// 達したら切断を指示する。速すぎる p も処理はする（位置の配信は tick でまとめるので、配信の量は増えない。
// 捨てると、止まった位置が配られないことがある）。違反（ViolationCounter）には数えない
export class PositionPace {
  private last = Number.NEGATIVE_INFINITY;
  private fast = new SlidingCount(LIMITS.rateWindowMs);

  // true なら切断する
  record(now: number, sendMs: number): boolean {
    const tooFast = now - this.last < sendMs / 2;
    this.last = now;
    if (!tooFast) return false;
    this.fast.add(now);
    return this.fast.total(now) >= LIMITS.maxFastPositions;
  }
}

// hello のハッシュ計算中に届いたメッセージ。上限を超えた分は捨てるが、星・線の作成だけは
// 送り主の画面から取り消してもらえるよう、welcome のあとに返す reject を覚えておく
export class IdentifyBacklog {
  readonly items: string[] = [];
  readonly rejects: Reject[] = [];

  constructor(
    private max: number,
    private maxRejects: number = LIMITS.maxRejectsWhileIdentifying,
  ) {}

  push(raw: string) {
    if (this.items.length < this.max) {
      this.items.push(raw);
      return;
    }
    if (this.rejects.length >= this.maxRejects) return;
    const r = rejectFor(raw);
    if (r) this.rejects.push(r);
  }
}
