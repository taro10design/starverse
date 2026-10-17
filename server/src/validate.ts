// クライアントからの生メッセージを検証して ClientMessage に変換する。
// 形と範囲は shared/protocol.ts の ClientMessageSchema（Valibot）が決める。合わないものは null（無視）にする。
// これを通らないものはサーバーの状態に一切触れない。

import * as v from "valibot";
import { type ClientMessage, ClientMessageSchema } from "../../shared/protocol";

// uid の形式が合わない hello。無視ではなく切断する（room.ts）ので、null と区別して返す
export const INVALID_HELLO = "invalid-hello";

const HelloShape = v.object({ t: v.literal("hello") });

function readJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false }; // 読めないものは無視する（呼び出し側で null にする）
  }
}

export function parseClientMessage(raw: string): ClientMessage | typeof INVALID_HELLO | null {
  const json = readJson(raw);
  if (!json.ok) return null;
  const result = v.safeParse(ClientMessageSchema, json.value);
  if (result.success) return result.output;
  // t が hello なのに形が合わない（uid が無い・形式違い）。未知の t は無視（新しいクライアントと古いサーバーの共存のため）
  return v.is(HelloShape, json.value) ? INVALID_HELLO : null;
}
