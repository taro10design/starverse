// クライアントからの生メッセージを検証して ClientMessage に変換する。
// 形と範囲は shared/protocol.ts の ClientMessageSchema（Valibot）が決める。これを通らないものはサーバーの状態に一切触れない。
//
// 結果は 4 通り:
// - ClientMessage: 正しいメッセージ
// - INVALID_HELLO: uid の形式が合わない hello（切断する）
// - UNREADABLE: JSON として読めない・オブジェクトでない・知らない t（正規のクライアントは送らないので、違反として数える）
// - null: t は知っているが形・範囲が合わない（無視する）

import * as v from "valibot";
import { type ClientMessage, ClientMessageSchema } from "../../shared/protocol";

export const INVALID_HELLO = "invalid-hello";
export const UNREADABLE = "unreadable";

const HelloShape = v.object({ t: v.literal("hello") });

// スキーマが知っている t の一覧
const KNOWN_TYPES: ReadonlySet<string> = new Set(ClientMessageSchema.options.map((o) => o.entries.t.literal));

export function readJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false }; // 読めないもの。呼び出し側が「読めない」として扱う
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

export function parseClientMessage(raw: string): ClientMessage | typeof INVALID_HELLO | typeof UNREADABLE | null {
  const json = readJson(raw);
  if (!json.ok) return UNREADABLE;
  const value = json.value;
  if (!isRecord(value) || typeof value.t !== "string" || !KNOWN_TYPES.has(value.t)) return UNREADABLE;
  const result = v.safeParse(ClientMessageSchema, value);
  if (result.success) return result.output;
  // t が hello なのに形が合わない（uid が無い・形式違い）
  return v.is(HelloShape, value) ? INVALID_HELLO : null;
}
