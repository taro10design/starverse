// 受信メッセージの関門。Durable Object に依存しない純粋な部品で、room.ts が順に使う。
//
// 1. screenRaw: JSON を読む前に、1 通ごとに 1 トークン取る（大きすぎる・文字列でないものも数える）。
//    読む前に絞るので、壊れたメッセージや hello の連打でも JSON.parse の負荷を受け続けない。
// 2. classify: hello の前後で、持ち主の確定・処理・違反・無視に振り分ける。
// 3. extraCost: 処理する前に、COST との差だけ追加でトークンを取る（合計は COST どおり）。

import type { ServerMessage } from "../../shared/protocol";
import { COST, LIMITS, RATE } from "./config";
import type { MemberMessage } from "./handlers";
import type { TokenBucket } from "./rate-limit";
import { INVALID_HELLO, parseClientMessage } from "./validate";

const BASE_COST = 1; // 読む前に取る分

export type RawVerdict = "accept" | "discard" | "close";

// accept なら読んでよい。discard は黙って捨てる。close はあふれ続けているので切断する
export function screenRaw(message: string | ArrayBuffer, bucket: TokenBucket, now: number): RawVerdict {
  if (!bucket.take(BASE_COST, now)) return isFlooding(bucket, now) ? "close" : "discard";
  if (typeof message !== "string" || message.length > LIMITS.maxMessageBytes) return "discard";
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

export type Step =
  | { do: "identify"; uid: string } // 持ち主を確定する
  | { do: "dispatch"; msg: MemberMessage } // handlers で処理する
  | { do: "invalid-uid" } // 形式の合わない uid の hello。切り詰めずに切断する
  | { do: "violation" } // 手順の違反（hello 前の hello 以外、2 回目以降の hello）
  | { do: "ignore" };

export function classify(isMember: boolean, raw: string): Step {
  const msg = parseClientMessage(raw);
  if (!isMember) {
    if (msg === INVALID_HELLO) return { do: "invalid-uid" };
    if (msg !== null && msg.t === "hello") return { do: "identify", uid: msg.uid };
    return { do: "violation" };
  }
  if (msg === null) return { do: "ignore" }; // 読めないもの。トークンは screenRaw で取っている
  if (msg === INVALID_HELLO || msg.t === "hello") return { do: "violation" }; // 持ち主は接続につき 1 つに固定する
  return { do: "dispatch", msg };
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

type Reject = Extract<ServerMessage, { t: "reject" }>;

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
    const msg = parseClientMessage(raw);
    if (msg !== null && msg !== INVALID_HELLO && (msg.t === "star" || msg.t === "link")) {
      this.rejects.push({ t: "reject", kind: msg.t, id: msg.id });
    }
  }
}
