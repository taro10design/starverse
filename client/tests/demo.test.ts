import { describe, expect, it } from "vitest";
import { DEMO_KINDS, DEMO_MS, demoFrame, type DemoFrame } from "../src/demo";

// 見本の動き（ヘルプと案内に出す小さなアニメーション）。各フレームは時刻だけから決まる純粋な関数
const sample = (step = 50) => Array.from({ length: Math.floor(DEMO_MS / step) }, (_, i) => i * step);
const pointsOf = (f: DemoFrame) => [f.light, ...f.fingers, ...f.stars, ...f.ripples];

describe("demoFrame（見本の動き）", () => {
  it.each(DEMO_KINDS)("%s: 時刻が DEMO_MS で一周する（最初に戻る）", (kind) => {
    for (const t of [0, 300, 1200, 2000]) expect(demoFrame(kind, t + DEMO_MS)).toEqual(demoFrame(kind, t));
  });

  it.each(DEMO_KINDS)("%s: 点はすべて小窓の中（0〜1）に収まる", (kind) => {
    for (const t of sample()) {
      for (const p of pointsOf(demoFrame(kind, t))) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(1);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(1);
      }
    }
  });

  it.each(DEMO_KINDS)("%s: 一周の始めは指も星も無い（繰り返しの切れ目が分かる）", (kind) => {
    const f = demoFrame(kind, 0);
    expect(f.fingers.filter((g) => g.down)).toEqual([]);
    expect(f.links).toEqual([]);
  });

  it("tap: 指で押すと波紋が出て、光がそこへ向かう", () => {
    const frames = sample().map((t) => demoFrame("tap", t));
    expect(frames.some((f) => f.ripples.length > 0)).toBe(true);
    const start = frames[0].light;
    const end = frames[Math.floor(frames.length * 0.8)].light;
    expect(Math.hypot(end.x - start.x, end.y - start.y)).toBeGreaterThan(0.2);
  });

  it("star: 押すと、押した所に星が 1 つ現れる", () => {
    const frames = sample().map((t) => demoFrame("star", t));
    expect(Math.max(...frames.map((f) => f.stars.length))).toBe(1);
  });

  it("trace: なぞると星が続けて増えていく", () => {
    const counts = sample().map((t) => demoFrame("trace", t).stars.length);
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(4);
    // 一周の中で、減らずに増えていく区間がある（なぞっている間）
    const peak = counts.indexOf(Math.max(...counts));
    expect(counts.slice(0, peak + 1)).toEqual([...counts.slice(0, peak + 1)].sort((a, b) => a - b));
  });

  it("line: 星から星へなぞると、線が 1 本できる", () => {
    const frames = sample().map((t) => demoFrame("line", t));
    expect(frames.some((f) => f.links.length === 1)).toBe(true);
    expect(frames.every((f) => f.stars.length === 2)).toBe(true);
  });

  it("erase: 押した星が消える", () => {
    const counts = sample().map((t) => demoFrame("erase", t).stars.length);
    expect(Math.max(...counts)).toBeGreaterThan(Math.min(...counts));
  });

  it("revive: 幽霊の星をタップすると、普通の星に戻る", () => {
    const frames = sample().map((t) => demoFrame("revive", t));
    expect(frames.some((f) => f.stars.some((s) => s.ghost))).toBe(true);
    expect(frames.some((f) => f.stars.length > 0 && f.stars.every((s) => !s.ghost))).toBe(true);
  });

  it("pinch: 2 本の指を広げると拡大する", () => {
    const frames = sample().map((t) => demoFrame("pinch", t));
    expect(frames.some((f) => f.fingers.filter((g) => g.down).length === 2)).toBe(true);
    expect(Math.max(...frames.map((f) => f.zoom))).toBeGreaterThan(1.4);
  });
});
