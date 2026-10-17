// localStorage から読んだ値の形の検証。
// 保存データは古い版・手での編集・容量切れの書きかけで壊れていることがあるので、
// 使う前に 1 要素ずつ確かめ、形が不正なものは捨てる。
// 範囲は通信仕様（shared/limits.ts。サーバーの検証と同じ値）にそろえる。ここで通したものは
// そのまま star として送り直す（幽霊の復活・アンドゥ）ので、サーバーが受け付けない値を残さない。

import { COORD_MAX, ID_MAX_LENGTH, PALETTE_COUNT } from "../../shared/limits";
import type { LinkData, StarData } from "../../shared/protocol";
import type { Ghost } from "./universe";

type Fields = Record<string, unknown>;

const isObject = (v: unknown): v is Fields => typeof v === "object" && v !== null;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
// 星・線の id（1〜ID_MAX_LENGTH 文字。サーバーは長い id を切り詰めるので、保存された id はこの長さに収まる）
const isId = (v: unknown): v is string => isStr(v) && v.length >= 1 && v.length <= ID_MAX_LENGTH;
// ワールド座標（絶対値が COORD_MAX 以下）
const isCoord = (v: unknown): v is number => isNum(v) && Math.abs(v) <= COORD_MAX;
const isColor = (v: unknown): v is number => Number.isInteger(v) && isNum(v) && v >= 0 && v < PALETTE_COUNT;

export function isStarData(v: unknown): v is StarData {
  return isObject(v) && isId(v.id) && isCoord(v.x) && isCoord(v.y) && isColor(v.c) && isStr(v.by) && isNum(v.ts);
}

export function isLinkData(v: unknown): v is LinkData {
  return isObject(v) && isId(v.id) && isId(v.a) && isId(v.b) && isStr(v.by) && isNum(v.ts);
}

export function isGhost(v: unknown): v is Ghost {
  return isObject(v) && isId(v.id) && isCoord(v.x) && isCoord(v.y) && isColor(v.c) && isNum(v.gone);
}

// 配列でなければ空。形の正しい要素だけを残す
export function validItems<T>(v: unknown, guard: (item: unknown) => item is T): T[] {
  return Array.isArray(v) ? v.filter(guard) : [];
}

// 保存された色の番号を、整数かつパレットの範囲に丸める。数でなければ最初の色
export function clampColor(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.round(n), 0), PALETTE_COUNT - 1);
}
