import { beforeAll, describe, expect, it, vi } from "vitest";
import { COORD_MAX, ID_MAX_LENGTH, PALETTE_COUNT } from "../../shared/limits";
import { clampColor, isGhost, isLinkData, isStarData, validItems } from "../src/validate";

// constants.ts が読み込み時に location を使う
vi.stubGlobal("location", { search: "", hostname: "localhost", host: "localhost", port: "" });

let PALETTES: typeof import("../src/constants").PALETTES;
beforeAll(async () => {
  ({ PALETTES } = await import("../src/constants"));
});

describe("パレット", () => {
  it("PALETTES の数は shared/limits.ts の PALETTE_COUNT と同じ（サーバーの色の検証と食い違わない）", () => {
    expect(PALETTES.length).toBe(PALETTE_COUNT);
  });
});

describe("clampColor", () => {
  it("整数かつ 0..PALETTE_COUNT-1 に丸める。数でなければ 0", () => {
    expect(clampColor("3")).toBe(3);
    expect(clampColor("2.6")).toBe(3);
    expect(clampColor("-1")).toBe(0);
    expect(clampColor("999")).toBe(PALETTE_COUNT - 1);
    expect(clampColor("abc")).toBe(0);
    expect(clampColor("Infinity")).toBe(0);
    expect(clampColor(null)).toBe(0);
  });
});

describe("保存データの形の検証", () => {
  it("星: id・座標・ts と、範囲内の整数の色を持つものだけ", () => {
    expect(isStarData({ id: "s", x: 0, y: 1, c: 2, by: "u", ts: 3 })).toBe(true);
    expect(isStarData({ id: "s", x: 0, y: 1, c: 2.5, by: "u", ts: 3 })).toBe(false);
    expect(isStarData({ id: "s", x: NaN, y: 1, c: 2, by: "u", ts: 3 })).toBe(false);
    expect(isStarData({ id: "s", x: 0, y: 1, c: 2, ts: 3 })).toBe(false);
    expect(isStarData(null)).toBe(false);
  });

  it("線と幽霊", () => {
    expect(isLinkData({ id: "l", a: "x", b: "y", by: "u", ts: 1 })).toBe(true);
    expect(isLinkData({ id: "l", a: "x", b: 2, by: "u", ts: 1 })).toBe(false);
    expect(isGhost({ id: "g", x: 0, y: 0, c: 0, gone: 1 })).toBe(true);
    expect(isGhost({ id: "g", x: 0, y: 0, c: 0 })).toBe(false);
  });

  it("範囲は通信仕様にそろえる: id は 1〜ID_MAX_LENGTH 文字、座標の絶対値は COORD_MAX 以下、色は PALETTE_COUNT 未満", () => {
    const longId = "x".repeat(ID_MAX_LENGTH + 1);
    const okId = "x".repeat(ID_MAX_LENGTH);
    expect(isStarData({ id: okId, x: COORD_MAX, y: -COORD_MAX, c: PALETTE_COUNT - 1, by: "u", ts: 3 })).toBe(true);
    expect(isStarData({ id: longId, x: 0, y: 0, c: 0, by: "u", ts: 3 })).toBe(false);
    expect(isStarData({ id: "", x: 0, y: 0, c: 0, by: "u", ts: 3 })).toBe(false);
    expect(isStarData({ id: "s", x: COORD_MAX + 1, y: 0, c: 0, by: "u", ts: 3 })).toBe(false);
    expect(isStarData({ id: "s", x: 0, y: 0, c: PALETTE_COUNT, by: "u", ts: 3 })).toBe(false);
    expect(isGhost({ id: longId, x: 0, y: 0, c: 0, gone: 1 })).toBe(false);
    expect(isGhost({ id: "g", x: 0, y: -COORD_MAX - 1, c: 0, gone: 1 })).toBe(false);
    expect(isGhost({ id: "g", x: 0, y: 0, c: PALETTE_COUNT, gone: 1 })).toBe(false);
    expect(isLinkData({ id: "l", a: longId, b: "y", by: "u", ts: 1 })).toBe(false);
    expect(isLinkData({ id: "l", a: "x", b: "", by: "u", ts: 1 })).toBe(false);
  });

  it("validItems: 配列でなければ空、形が不正な要素は捨てる", () => {
    expect(validItems({ a: 1 }, isGhost)).toEqual([]);
    expect(validItems(null, isGhost)).toEqual([]);
    const g = { id: "g", x: 0, y: 0, c: 0, gone: 1 };
    expect(validItems([g, 1, { id: "bad" }], isGhost)).toEqual([g]);
  });
});
