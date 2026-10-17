import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/config";
import { coarseFrame, movedFrames, type Peer, TickClock, tickMsFor, welcomeDots } from "../src/presence";

const peer = (id: string, x: number, y: number, view: Peer["view"] = null, c = 0): Peer => ({ id, x, y, c, view });

describe("tickMsFor（人数に応じた配信の間隔）", () => {
  it("表のとおりに広げる", () => {
    expect(tickMsFor(1)).toBe(100);
    expect(tickMsFor(100)).toBe(100);
    expect(tickMsFor(101)).toBe(150);
    expect(tickMsFor(200)).toBe(150);
    expect(tickMsFor(10_000)).toBe(250);
  });
});

describe("TickClock（tick ごとの判定）", () => {
  it("動いた人がいれば送る。coarseEveryTicks 回ごとに粗い一覧も送る", () => {
    const clock = new TickClock();
    for (let i = 1; i < LIMITS.coarseEveryTicks; i++) expect(clock.next(true)).toEqual({ do: "send", coarse: null });
    expect(clock.next(true)).toEqual({ do: "send", coarse: 1 });
  });

  it("誰も動かない回が idleTicksBeforeSleep を超えたら止める（粗い一覧の回は数えない）", () => {
    const clock = new TickClock();
    const seen: string[] = [];
    for (let i = 0; i < 200; i++) {
      const d = clock.next(false);
      seen.push(d.do);
      if (d.do === "sleep") break;
    }
    const quiet = seen.filter((s) => s === "idle").length;
    expect(seen.at(-1)).toBe("sleep");
    expect(quiet).toBe(LIMITS.idleTicksBeforeSleep);
    expect(seen.filter((s) => s === "send")).toHaveLength(Math.floor(seen.length / LIMITS.coarseEveryTicks));
  });

  it("wake で静かな回の数え直し（動きがあれば眠らない）", () => {
    const clock = new TickClock();
    for (let i = 0; i < LIMITS.idleTicksBeforeSleep; i++) clock.next(false);
    clock.wake();
    for (let i = 0; i < LIMITS.idleTicksBeforeSleep - 2; i++) expect(clock.next(false).do).not.toBe("sleep");
  });
});

describe("welcomeDots（welcome に載せる他の人）", () => {
  it("自分を除き、座標を丸め、上限で切る", () => {
    const me = peer("me", 0, 0);
    const others = [me, peer("a", 0.123456, 0.987654, null, 3), peer("b", 1, 1), peer("c", 2, 2)];
    expect(welcomeDots(others, me, 2)).toEqual([
      { id: "a", x: 0.1235, y: 0.9877, c: 3 },
      { id: "b", x: 1, y: 1, c: 0 },
    ]);
  });
});

describe("coarseFrame（視界外も含めた粗い一覧）", () => {
  it("全員を [id, x, y, c] で並べる", () => {
    expect(coarseFrame([peer("a", 0.11111, 0), peer("b", 1, 2, null, 5)], 1, 10)).toEqual([
      ["a", 0.1111, 0, 0],
      ["b", 1, 2, 5],
    ]);
  });

  it("上限より多いときは、回ごとに窓をずらして全員が順に載る", () => {
    const all = Array.from({ length: 5 }, (_, i) => peer(`p${i}`, i, 0));
    const seen = new Set<string>();
    for (let round = 1; round <= 3; round++) for (const [id] of coarseFrame(all, round, 2)) seen.add(id);
    expect(seen.size).toBe(5);
    expect(coarseFrame(all, 1, 2)).toHaveLength(2);
  });

  it("誰もいなければ空", () => {
    expect(coarseFrame([], 1, 10)).toEqual([]);
  });
});

describe("movedFrames（動いた人を、視界に入る相手にだけ）", () => {
  it("視界（余白つき）に入る相手にだけ送り、自分自身には送らない", () => {
    const near = peer("near", 0.5, 0.5, [0, 0, 1, 1]);
    const far = peer("far", 50, 50, [49, 49, 51, 51]);
    const mover = peer("mover", 0.6, 0.6, [0, 0, 1, 1]);
    const frames = movedFrames([near, far, mover], [mover], 10);
    expect(frames.get(near)).toEqual([["mover", 0.6, 0.6, 0]]);
    expect(frames.has(far)).toBe(false);
    expect(frames.has(mover)).toBe(false);
  });

  it("視界をまだ送っていない相手には全員ぶん送る", () => {
    const blind = peer("blind", 0, 0, null);
    const a = peer("a", 10, 10);
    const b = peer("b", -10, -10);
    expect(movedFrames([blind, a, b], [a, b], 10).get(blind)).toHaveLength(2);
  });

  it("視界の余白（viewMargin）の内側は届き、外側は届かない", () => {
    const viewer = peer("v", 0, 0, [0, 0, 1, 1]);
    const inside = peer("in", 1 + LIMITS.viewMargin - 0.01, 0.5);
    const outside = peer("out", 1 + LIMITS.viewMargin + 0.01, 0.5);
    expect(movedFrames([viewer, inside, outside], [inside, outside], 10).get(viewer)).toEqual([
      ["in", 1 + LIMITS.viewMargin - 0.01, 0.5, 0],
    ]);
  });

  it("1 通に載せる数は上限まで", () => {
    const viewer = peer("v", 0, 0, null);
    const movers = Array.from({ length: 5 }, (_, i) => peer(`m${i}`, i, 0));
    expect(movedFrames([viewer, ...movers], movers, 3).get(viewer)).toHaveLength(3);
  });

  it("広い視界でも狭い視界でも、同じ相手が選ばれる（グリッドの近道で取りこぼさない）", () => {
    const movers = Array.from({ length: 30 }, (_, i) => peer(`m${i}`, (i % 6) * 0.7, Math.floor(i / 6) * 0.7));
    const narrow = peer("n", 0, 0, [0.5, 0.5, 1.5, 1.5]);
    const wide = peer("w", 0, 0, [-100, -100, 100, 100]);
    const frames = movedFrames([narrow, wide, ...movers], movers, 100);
    const expected = movers.filter((m) => m.x >= 0.2 && m.x <= 1.8 && m.y >= 0.2 && m.y <= 1.8).map((m) => m.id);
    expect((frames.get(narrow) ?? []).map(([id]) => id).sort()).toEqual(expected.sort());
    expect(frames.get(wide)).toHaveLength(30);
  });
});
