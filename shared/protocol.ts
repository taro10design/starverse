// クライアントとサーバーが共有する WebSocket プロトコル。Valibot のスキーマで 1 か所に定義し、型はスキーマから導出する。
// 短い名前は通信量を抑えるため（p = position, c = color index, v = view, ps = presences）。
//
// - ClientMessageSchema: サーバーが受信の検証に使う（server/src/validate.ts）。範囲外の値の扱いもここで決める
// - ServerMessageSchema: サーバーが送る形。型の導出とテストに使う
// - クライアントは型だけを import する（スキーマは読み込まない）
//
// メッセージを足すとき: ここにスキーマを足す → サーバーは server/src/handlers.ts、
// クライアントは client/src/message-handlers.ts に処理を書く（足さないと型エラーになる）。
// 詳しくは docs/extending.md。

import * as v from "valibot";
import { COORD_MAX, ID_MAX_LENGTH, PALETTE_COUNT, UID_PATTERN } from "./limits";

// --- 受信の部品（範囲を検証する） ---

// 有限で、絶対値が COORD_MAX 以下の座標
const Coord = v.pipe(v.number(), v.finite(), v.minValue(-COORD_MAX), v.maxValue(COORD_MAX));
// 光の色の番号（0..PALETTE_COUNT-1 の整数）
const Color = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(PALETTE_COUNT - 1));
// 空でない文字列。長すぎる id は切り詰める
const Id = v.pipe(
  v.string(),
  v.minLength(1),
  v.transform((s) => s.slice(0, ID_MAX_LENGTH)),
);

// 視界（ワールド座標）[x0, y0, x1, y1]。サーバーは視界の近くの人だけに位置を送る
const ViewSchema = v.pipe(
  v.strictTuple([Coord, Coord, Coord, Coord]),
  v.check(([x0, y0, x1, y1]) => x0 <= x1 && y0 <= y1),
);
export type View = v.InferOutput<typeof ViewSchema>;

// クライアント → サーバー
//
// 持ち主の鍵 uid は秘密。接続の最初に `hello` で 1 回だけ送り、サーバーは SHA-256 で
// 持ち主 ID（StarData.by / LinkData.by）に変えて保存・配信する。uid そのものは保存も配信もしない。
// hello の前に送られた他のメッセージは無視され、違反として通算で数える（減らない。2 回目以降の hello も同じ）。
// 通算 20 回目で 1008 で切断される。形式に合わない uid の hello は即 1008（切り詰めない）。
// hello の処理中（ハッシュ計算の間）に届いたものは、welcome のあとに処理される。
//
// hello 済みでも、読めない JSON・知らない t は違反として通算で数える（20 回目で 1008）。t は知っているが形が合わない
// メッセージは無視する。ただし p の色が不正なら 0、視界が不正なら視界なしとして受ける。
// 知らないキーは捨てる。
export const ClientMessageSchema = v.variant("t", [
  v.object({ t: v.literal("hello"), uid: v.pipe(v.string(), v.regex(UID_PATTERN)) }),
  v.object({
    t: v.literal("p"),
    x: Coord,
    y: Coord,
    c: v.fallback(Color, 0),
    v: v.fallback(v.optional(ViewSchema), undefined),
  }),
  v.object({ t: v.literal("pulse"), x: Coord, y: Coord }),
  v.object({ t: v.literal("star"), id: Id, x: Coord, y: Coord, c: Color }),
  v.object({ t: v.literal("unstar"), id: Id }),
  // 同じ接続から同じ星へは 5 秒に 1 回。さらに星ごとに、星の ts（作成・前回のきらめき）から 60 秒は
  // 誰のきらめきも効かない。作成から 24 時間を過ぎた星も延びない（どれも黙って捨てられる）
  v.object({ t: v.literal("admire"), id: Id }),
  v.object({ t: v.literal("link"), id: Id, a: Id, b: Id }),
  v.object({ t: v.literal("unlink"), id: Id }),
]);
export type ClientMessage = v.InferOutput<typeof ClientMessageSchema>;

// --- 送信の形（サーバーが作るので範囲は検証しない） ---

// サーバーは保存するときに born / v を足すが、配信（welcome・star）には含めない（server/src/world.ts の StoredStar）
const StarDataSchema = v.object({
  id: v.string(),
  x: v.number(),
  y: v.number(),
  c: v.number(),
  by: v.string(), // 持ち主 ID（uid の SHA-256。uid そのものではない）
  ts: v.number(),
});
export type StarData = v.InferOutput<typeof StarDataSchema>;

// 誰かが意図して引いた線。星 a と星 b を結ぶ
const LinkDataSchema = v.object({ id: v.string(), a: v.string(), b: v.string(), by: v.string(), ts: v.number() });
export type LinkData = v.InferOutput<typeof LinkDataSchema>;

const PeerDotSchema = v.object({ id: v.string(), x: v.number(), y: v.number(), c: v.number() });
export type PeerDot = v.InferOutput<typeof PeerDotSchema>;

// 他の人の位置のタプル [id, x, y, color]（JSON を小さくするためオブジェクトにしない）
const PresenceTupleSchema = v.strictTuple([v.string(), v.number(), v.number(), v.number()]);
export type PresenceTuple = v.InferOutput<typeof PresenceTupleSchema>;

// サーバー → クライアント
export const ServerMessageSchema = v.variant("t", [
  // hello への返事。me は自分の持ち主 ID（星の by と比べて「自分の星か」を判定する）
  v.object({
    t: v.literal("welcome"),
    id: v.string(),
    me: v.string(),
    sendMs: v.number(),
    dots: v.array(PeerDotSchema),
    stars: v.array(StarDataSchema),
    links: v.array(LinkDataSchema),
  }),
  // 空の人数が変わったときの、位置を送る間隔の指示（人が増えるほど間隔を広げる）
  v.object({ t: v.literal("rate"), sendMs: v.number() }),
  // 上限超過（1 人 / 全体）・他人の星の上書き・レート制限などで断った操作。
  // hello の処理中にあふれたものは welcome の直後に届く。クライアントは自分の画面の星 / 線を取り消す
  v.object({ t: v.literal("reject"), kind: v.picklist(["star", "link"]), id: v.string() }),
  v.object({ t: v.literal("ps"), d: v.array(PresenceTupleSchema) }),
  v.object({ t: v.literal("pulse"), x: v.number(), y: v.number(), c: v.number() }),
  v.object({ t: v.literal("star"), ...StarDataSchema.entries }),
  v.object({ t: v.literal("unstar"), id: v.string() }),
  // 視界に関係なく全員に届く（どの手元でも星の寿命をそろえる）
  v.object({ t: v.literal("admire"), id: v.string(), ts: v.number() }),
  v.object({ t: v.literal("link"), ...LinkDataSchema.entries }),
  v.object({ t: v.literal("unlink"), id: v.string() }),
  v.object({ t: v.literal("leave"), id: v.string() }),
]);
export type ServerMessage = v.InferOutput<typeof ServerMessageSchema>;

export type ClientMessageType = ClientMessage["t"];
export type ServerMessageType = ServerMessage["t"];
