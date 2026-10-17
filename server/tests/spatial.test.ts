import { describe, expect, it } from "vitest";
import { crowdCounts, inView } from "../src/spatial";

describe("crowdCounts", () => {
  it("半径内の他の点の数を数える", () => {
    const pts = [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 0.01, y: 0 },
      { id: "c", x: 0, y: 0.01 },
      { id: "far", x: 1, y: 1 },
    ];
    const c = crowdCounts(pts, 0.06);
    expect(c.get("a")).toBe(2);
    expect(c.get("b")).toBe(2);
    expect(c.get("far")).toBe(0);
  });

  it("セルの境界をまたいでも数えられる（負の座標を含む）", () => {
    const pts = [
      { id: "a", x: -0.0001, y: -0.0001 },
      { id: "b", x: 0.0001, y: 0.0001 },
    ];
    expect(crowdCounts(pts, 0.06).get("a")).toBe(1);
  });

  it("全探索と同じ結果になる", () => {
    // 種を固定した擬似乱数（mulberry32）。失敗したときに同じ点の集合で再現できるように
    let seed = 0x5eed1234;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pts = Array.from({ length: 300 }, (_, i) => ({
      id: `p${i}`,
      x: rand() * 0.5,
      y: rand() * 0.5,
    }));
    const r = 0.06;
    const fast = crowdCounts(pts, r);
    for (const p of pts) {
      let n = 0;
      for (const o of pts) if (o !== p && (o.x - p.x) ** 2 + (o.y - p.y) ** 2 < r * r) n++;
      expect(fast.get(p.id)).toBe(n);
    }
  });
});

describe("inView", () => {
  const view: [number, number, number, number] = [0, 0, 1, 1];
  it("視界内は true、遠いと false", () => {
    expect(inView(view, 0.5, 0.5, 0)).toBe(true);
    expect(inView(view, 2, 2, 0.3)).toBe(false);
  });
  it("余白ぶんは視界の外でも true", () => {
    expect(inView(view, 1.2, 0.5, 0.3)).toBe(true);
    expect(inView(view, 1.4, 0.5, 0.3)).toBe(false);
  });
  it("view が無ければ常に true", () => {
    expect(inView(null, 999, 999, 0)).toBe(true);
  });
});
