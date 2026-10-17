// hello → welcome の握手（docs/specs/0003、ADR 0007）。本物の Workers ランタイム上で /ws を叩く黒箱テスト。

import { afterEach, describe, expect, it } from "vitest";
import { HEX32, cleanup, connect, forbidInFrames, join, newId } from "./helpers";

afterEach(cleanup);

describe("hello と welcome", () => {
  it("hello に welcome が返る（id・me・sendMs・dots・stars・links）", async () => {
    const { c, w } = await join();
    expect(typeof w.id).toBe("string");
    expect(w.id.length).toBeGreaterThan(0);
    expect(typeof w.sendMs).toBe("number");
    expect(Array.isArray(w.dots)).toBe(true);
    expect(w.stars).toEqual([]);
    expect(w.links).toEqual([]);
    // me は uid そのものではなく、32 桁の 16 進（uid のハッシュ）
    expect(w.me).toMatch(HEX32);
    expect(w.me).not.toBe(c.uid);
    expect(w.me).not.toContain(c.uid.slice(0, 8));
  });

  it("hello の前に送ったメッセージは無視され、welcome が最初に届く", async () => {
    const watcher = await join();
    const c = await connect({ hello: false });
    const early = newId();
    c.send({ t: "star", id: early, x: 1, y: 1, c: 0 });
    c.send({ t: "pulse", x: 1, y: 1 });
    c.hello();
    const w = await c.welcome();
    expect(c.got[0]?.t).toBe("welcome");
    expect(w.stars.some((s) => s.id === early)).toBe(false);
    // 後から来た人の welcome にも、見ていた人にも、その星は出てこない
    const later = await join();
    expect(later.w.stars.some((s) => s.id === early)).toBe(false);
    expect(watcher.c.of("star").some((s) => s.id === early)).toBe(false);
  });

  it("hello の前には何も届かない", async () => {
    const watcher = await join();
    const c = await connect({ hello: false });
    // 他の人が動いても、hello していない接続には届かない
    watcher.c.send({ t: "p", x: 0, y: 0, c: 1, v: [-10, -10, 10, 10] });
    watcher.c.send({ t: "pulse", x: 0, y: 0 });
    // 確かめのために別の人を入れ、その人に位置が届くまで待つ（その時点で配信は一巡している）
    const other = await join();
    other.c.send({ t: "p", x: 0, y: 0, c: 0, v: [-10, -10, 10, 10] });
    await other.c.waitFor("ps", (m) => m.d.some((p) => p[0] === watcher.w.id));
    expect(c.got).toEqual([]);
    expect(c.raw).toEqual([]);
  });

  it("形式に合わない uid の hello は 1008 で切断され、welcome は来ない", async () => {
    for (const uid of ["short", "x".repeat(65), "has space in it", ""]) {
      const c = await connect({ uid });
      expect(await c.waitClosed()).toBe(1008);
      expect(c.of("welcome")).toEqual([]);
    }
  });

  it("2 回目の hello は無視される（持ち主は最初の uid のまま。2 通目の welcome は来ない）", async () => {
    const watcher = await join();
    const { c, w } = await join();
    const second = crypto.randomUUID();
    forbidInFrames(second); // 2 回目の uid も、どこにも出てこない
    c.send({ t: "hello", uid: second });
    const id = newId();
    c.send({ t: "star", id, x: 2, y: 2, c: 1 });
    // 2 回目の hello のあとに置いた星の持ち主が、最初の hello の me のまま
    const star = await watcher.c.waitFor("star", (s) => s.id === id);
    expect(star.by).toBe(w.me);
    expect(c.of("welcome")).toHaveLength(1);
    expect(c.closed).toBe(false);
  });

  it("同じ uid なら同じ me、別の uid なら別の me", async () => {
    const uid = crypto.randomUUID();
    const a = await join({ uid });
    await a.c.close();
    const b = await join({ uid });
    expect(b.w.me).toBe(a.w.me);
    const other = await join();
    expect(other.w.me).not.toBe(a.w.me);
  });

  it("hello を繰り返す接続は 1008 で切断される（手順の違反が続く）", async () => {
    const { c } = await join();
    for (let i = 0; i < 25; i++) c.hello();
    expect(await c.waitClosed()).toBe(1008);
  });

  it("hello の前に hello 以外を送り続ける接続は 1008 で切断される", async () => {
    const c = await connect({ hello: false });
    for (let i = 0; i < 25; i++) c.send({ t: "p", x: 0, y: 0, c: 0 });
    expect(await c.waitClosed()).toBe(1008);
    expect(c.of("welcome")).toEqual([]);
  });

  it("hello を送らない接続は締め切り（10 秒）のあとに 1008 で切断される", { timeout: 20_000 }, async () => {
    const c = await connect({ hello: false });
    const t0 = Date.now();
    expect(await c.waitClosed(16_000)).toBe(1008);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(9_000);
    expect(c.got).toEqual([]);
  });
});
