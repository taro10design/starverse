// クライアントからの生メッセージを検証して ClientMessage に変換する。
// 型が合わないもの・範囲外の数値・長すぎる文字列は null（無視）にする。
// これを通らないものはサーバーの状態に一切触れない。

import { PALETTE_COUNT, UID_PATTERN } from "../../shared/limits";
import type { ClientMessage, View } from "../../shared/protocol";
import { LIMITS } from "./config";

// uid の形式が合わない hello。無視ではなく切断する（room.ts）ので、null と区別して返す
export const INVALID_HELLO = "invalid-hello";

const coord = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= LIMITS.coordMax ? v : null;

// 空でない文字列。長すぎる id は切り詰める（uid には使わない。uid は形式で検証する）
const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;

const color = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v < PALETTE_COUNT ? v : null;

function view(v: unknown): View | undefined {
  if (!Array.isArray(v) || v.length !== 4) return undefined;
  const [x0, y0, x1, y1] = v.map(coord);
  if (x0 === null || y0 === null || x1 === null || y1 === null || x1 < x0 || y1 < y0) return undefined;
  return [x0, y0, x1, y1];
}

export function parseClientMessage(raw: string): ClientMessage | typeof INVALID_HELLO | null {
  let m: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    m = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  switch (m.t) {
    case "hello": {
      const uid = m.uid;
      return typeof uid === "string" && UID_PATTERN.test(uid) ? { t: "hello", uid } : INVALID_HELLO;
    }
    case "p": {
      const x = coord(m.x),
        y = coord(m.y),
        c = color(m.c);
      if (x === null || y === null) return null;
      return { t: "p", x, y, c: c ?? 0, v: view(m.v) };
    }
    case "pulse": {
      const x = coord(m.x),
        y = coord(m.y);
      if (x === null || y === null) return null;
      return { t: "pulse", x, y };
    }
    case "star": {
      const id = str(m.id, 24),
        x = coord(m.x),
        y = coord(m.y),
        c = color(m.c);
      if (id === null || x === null || y === null || c === null) return null;
      return { t: "star", id, x, y, c };
    }
    case "unstar": {
      const id = str(m.id, 24);
      return id === null ? null : { t: "unstar", id };
    }
    case "admire": {
      const id = str(m.id, 24);
      return id === null ? null : { t: "admire", id };
    }
    case "link": {
      const id = str(m.id, 24),
        a = str(m.a, 24),
        b = str(m.b, 24);
      if (id === null || a === null || b === null) return null;
      return { t: "link", id, a, b };
    }
    case "unlink": {
      const id = str(m.id, 24);
      return id === null ? null : { t: "unlink", id };
    }
    default:
      return null; // 未知のメッセージは無視（新しいクライアントと古いサーバーの共存のため）
  }
}
