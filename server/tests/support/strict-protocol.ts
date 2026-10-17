// テスト専用の、サーバー → クライアントの厳密なスキーマ。
// shared/protocol.ts の ServerMessageSchema は型の導出用で、知らないキーを許し、持ち主 ID の形式も見ない。
// テストでは、配信に出てはいけないもの（uid・保存専用の born / v・origin など）が混ざっていないことまで確かめたいので、
// 仕様（shared/protocol.ts・docs/specs/0003・ADR 0007）の形をここで厳密に書き直す:
// - どのオブジェクトも v.strictObject（知らないキーがあれば不一致。born / v / uid / origin も知らないキー）
// - by / me は持ち主 ID（OWNER_ID_PATTERN）
// - 数値は有限（NaN / Infinity は JSON にすると null になるので、v.number() がそもそも通さない）

import * as v from "valibot";
import { OWNER_ID_PATTERN } from "../../../shared/limits";

const Num = v.pipe(v.number(), v.finite());
const Owner = v.pipe(v.string(), v.regex(OWNER_ID_PATTERN));
const Id = v.pipe(v.string(), v.minLength(1));

const star = { id: Id, x: Num, y: Num, c: Num, by: Owner, ts: Num };
const link = { id: Id, a: Id, b: Id, by: Owner, ts: Num };

export const StrictServerMessageSchema = v.variant("t", [
  v.strictObject({
    t: v.literal("welcome"),
    id: Id,
    me: Owner,
    sendMs: Num,
    dots: v.array(v.strictObject({ id: Id, x: Num, y: Num, c: Num })),
    stars: v.array(v.strictObject(star)),
    links: v.array(v.strictObject(link)),
  }),
  v.strictObject({ t: v.literal("rate"), sendMs: Num }),
  v.strictObject({ t: v.literal("reject"), kind: v.picklist(["star", "link"]), id: Id }),
  v.strictObject({ t: v.literal("ps"), d: v.array(v.strictTuple([Id, Num, Num, Num])) }),
  v.strictObject({ t: v.literal("pulse"), x: Num, y: Num, c: Num }),
  v.strictObject({ t: v.literal("star"), ...star }),
  v.strictObject({ t: v.literal("unstar"), id: Id }),
  v.strictObject({ t: v.literal("admire"), id: Id, ts: Num }),
  v.strictObject({ t: v.literal("link"), ...link }),
  v.strictObject({ t: v.literal("unlink"), id: Id }),
  v.strictObject({ t: v.literal("leave"), id: Id }),
]);

// JSON でない受信フレームとして許すもの（ping への自動応答。docs/specs/0003）
export const NON_JSON_FRAMES: readonly string[] = ["pong"];

// 1 フレームを検証する。合わなければ理由の文字列、合えば null
export function strictFrameProblem(raw: string): string | null {
  if (NON_JSON_FRAMES.includes(raw)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return `JSON でないフレーム: ${raw.slice(0, 200)}`;
  }
  const r = v.safeParse(StrictServerMessageSchema, parsed);
  if (r.success) return null;
  const issues = r.issues.map((i) => `${v.getDotPath(i) ?? "(root)"}: ${i.message}`).join("; ");
  return `仕様に合わないフレーム: ${raw.slice(0, 200)} — ${issues}`;
}
