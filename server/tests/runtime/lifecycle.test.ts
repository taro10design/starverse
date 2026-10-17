// 永続化・退出・ハイバネートからの復帰・旧形式の保存データ（docs/specs/0003、ADR 0006・0007）。黒箱テスト。
//
// Durable Object の退避（evictDurableObject）とストレージへの書き込み（runInDurableObject）だけは
// @cloudflare/vitest-plugin の道具を使う。ストレージの鍵は ADR 0006 に書かれた旧形式（`stars` / `links`）だけを使う。

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, connect, join, newId, newUid, roomStub, snapshot } from "./helpers";

afterEach(cleanup);

const NEAR: [number, number, number, number] = [-10, -10, 10, 10];

describe("永続化と再接続", () => {
  it("星と線を置いて全員が切断しても、新しく接続した人の welcome に残っている", async () => {
    // 反映は別の接続で確かめてから切る（自分の操作が自分に返るかどうかには依存しない）
    const watcher = await join();
    const { c, w } = await join();
    const s1 = newId();
    const s2 = newId();
    const l1 = newId();
    c.send({ t: "star", id: s1, x: 0, y: 0, c: 3 });
    c.send({ t: "star", id: s2, x: 2, y: 0, c: 5 });
    c.send({ t: "link", id: l1, a: s1, b: s2 });
    await watcher.c.waitFor("link", (l) => l.id === l1);
    await c.close();
    await watcher.c.close();

    const later = await snapshot();
    expect(later.stars.find((s) => s.id === s1)).toMatchObject({ x: 0, y: 0, c: 3, by: w.me });
    expect(later.stars.find((s) => s.id === s2)).toMatchObject({ x: 2, y: 0, c: 5, by: w.me });
    expect(later.links.find((l) => l.id === l1)).toMatchObject({ a: s1, b: s2, by: w.me });
  });

  it("Durable Object が退避されても（メモリが消えても）、保存された星と線は残る", async () => {
    const watcher = await join();
    const { c, w } = await join();
    const s1 = newId();
    const s2 = newId();
    const l1 = newId();
    c.send({ t: "star", id: s1, x: 0, y: 0, c: 1 });
    c.send({ t: "star", id: s2, x: 2, y: 0, c: 1 });
    c.send({ t: "link", id: l1, a: s1, b: s2 });
    await watcher.c.waitFor("link", (l) => l.id === l1);
    await c.close();
    await watcher.c.close();
    // 接続を閉じたうえで、インスタンスを壊す（ストレージは残る）
    await evictDurableObject(roomStub(), { webSockets: "close" });

    const later = await snapshot();
    expect(later.stars.filter((s) => s.id === s1 || s.id === s2)).toHaveLength(2);
    expect(later.links.find((l) => l.id === l1)?.by).toBe(w.me);
  });

  it("複数回の接続・切断をまたいで、そのたびに leave が配信される", async () => {
    const stay = await join();
    for (let i = 0; i < 3; i++) {
      const visitor = await join();
      await visitor.c.close();
      await stay.c.waitFor("leave", (m) => m.id === visitor.w.id);
    }
    expect(stay.c.of("leave")).toHaveLength(3);
    // 同じ uid での出入りでも同じ
    const uid = newUid();
    for (let i = 0; i < 2; i++) {
      const visitor = await join({ uid });
      await visitor.c.close();
      await stay.c.waitFor("leave", (m) => m.id === visitor.w.id);
    }
  });

  it("入ってきた人の welcome の dots に、今いる人が入っている", async () => {
    const a = await join();
    a.c.send({ t: "p", x: 3, y: 4, c: 5, v: NEAR });
    // a の位置がサーバーに届いたことを、別の人の ps で確かめる
    const b = await join();
    b.c.send({ t: "p", x: 0, y: 0, c: 0, v: NEAR });
    await b.c.waitFor("ps", (m) => m.d.some((p) => p[0] === a.w.id));
    const later = await join();
    expect(later.w.dots).toEqual(expect.arrayContaining([{ id: a.w.id, x: 3, y: 4, c: 5 }]));
    expect(later.w.dots.some((d) => d.id === later.w.id)).toBe(false);
  });
});

describe("ハイバネートからの復帰", () => {
  it("接続が生きたまま退避されても、持ち主・位置の配信・星・leave が保たれる", async () => {
    const a = await join();
    const b = await join();
    const sid = newId();
    a.c.send({ t: "star", id: sid, x: 0, y: 0, c: 2 });
    await b.c.waitFor("star", (s) => s.id === sid);
    a.c.send({ t: "p", x: 0, y: 0, c: 1, v: NEAR });
    b.c.send({ t: "p", x: 1, y: 1, c: 2, v: NEAR });
    await a.c.waitFor("ps", (m) => m.d.some((p) => p[0] === b.w.id));

    // WebSocket はハイバネートさせたまま、インスタンス（メモリ）だけを壊す。
    // 実装がハイバネート API を使っていなければ、ここで接続が閉じる（＝ハイバネートできないことの検出）
    await evictDurableObject(roomStub(), { webSockets: "hibernate" });
    expect(a.c.closed).toBe(false);
    expect(b.c.closed).toBe(false);

    // 起こしたあと: 持ち主は接続に残っている（置いた星の by が同じ me）
    const sid2 = newId();
    a.c.send({ t: "star", id: sid2, x: 3, y: 3, c: 2 });
    const star = await b.c.waitFor("star", (s) => s.id === sid2);
    expect(star.by).toBe(a.w.me);
    // 他人の星の上書きは、復帰後も断られる
    b.c.send({ t: "star", id: sid, x: 9, y: 9, c: 0 });
    await b.c.waitFor("reject", (m) => m.kind === "star" && m.id === sid);
    // 位置の配信が再開する
    const before = a.c.of("ps").length;
    b.c.send({ t: "p", x: 1.5, y: 1.5, c: 2, v: NEAR });
    const ps = await a.c.waitFor("ps", (m) => a.c.of("ps").indexOf(m) >= before && m.d.some((p) => p[0] === b.w.id));
    expect(ps.d.find((p) => p[0] === b.w.id)).toEqual([b.w.id, 1.5, 1.5, 2]);
    // 新しく入った人の welcome に、星と、退避の前からいる人が入っている
    const later = await join();
    expect(later.w.stars.some((s) => s.id === sid)).toBe(true);
    expect(later.w.dots.map((d) => d.id)).toEqual(expect.arrayContaining([a.w.id, b.w.id]));
    // 退避の前からいた人が抜けると leave が届く
    await b.c.close();
    await a.c.waitFor("leave", (m) => m.id === b.w.id);
    await later.c.waitFor("leave", (m) => m.id === b.w.id);
  });

  it("2 回目の hello は、復帰後も無視される（持ち主が変わらない）", async () => {
    const a = await join();
    const watcher = await join();
    await evictDurableObject(roomStub(), { webSockets: "hibernate" });
    a.c.send({ t: "hello", uid: newUid() });
    const sid = newId();
    a.c.send({ t: "star", id: sid, x: 0, y: 0, c: 0 });
    const star = await watcher.c.waitFor("star", (s) => s.id === sid);
    expect(star.by).toBe(a.w.me);
    expect(a.c.of("welcome")).toHaveLength(1);
  });

  it("hello の前に退避された接続も、復帰後に hello すれば welcome が返る", async () => {
    const watcher = await join();
    const c = await connect({ hello: false });
    await evictDurableObject(roomStub(), { webSockets: "hibernate" });
    c.hello();
    const w = await c.welcome();
    expect(c.got[0]?.t).toBe("welcome");
    expect(w.id).not.toBe(watcher.w.id);
    // 復帰後の接続も、ふつうに星を置ける
    const sid = newId();
    c.send({ t: "star", id: sid, x: 0, y: 0, c: 0 });
    expect((await watcher.c.waitFor("star", (s) => s.id === sid)).by).toBe(w.me);
  });
});

describe("旧形式の保存データ（ADR 0006・0007）", () => {
  it("旧キー stars / links の配列と、by に生の uid が入った星は、起動時に捨てられて welcome に出ない", async () => {
    const rawUid = newUid();
    const oldStar = { id: "old-star-1", x: 0, y: 0, c: 1, by: rawUid, ts: Date.now() };
    const oldStar2 = { id: "old-star-2", x: 2, y: 0, c: 1, by: rawUid, ts: Date.now() };
    const oldLink = { id: "old-link-1", a: "old-star-1", b: "old-star-2", by: rawUid, ts: Date.now() };
    // 最初の接続より前に、旧形式のデータを書く
    await runInDurableObject(roomStub(), async (_instance, state) => {
      await state.storage.put("stars", [oldStar, oldStar2]);
      await state.storage.put("links", [oldLink]);
    });
    // runInDurableObject で起きたインスタンスを壊し、次の接続で起動し直させる
    await evictDurableObject(roomStub(), { webSockets: "close" });

    const { w } = await join();
    expect(w.stars.some((s) => s.id.startsWith("old-"))).toBe(false);
    expect(w.links.some((l) => l.id.startsWith("old-"))).toBe(false);
    expect(JSON.stringify(w)).not.toContain(rawUid);
  });
});
