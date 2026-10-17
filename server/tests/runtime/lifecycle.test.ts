// 永続化・退出・ハイバネートからの復帰・旧形式の保存データ（docs/specs/0003、ADR 0006・0007）。黒箱テスト。
//
// Durable Object の退避（evictDurableObject）とストレージの読み書き（runInDurableObject）だけは
// @cloudflare/vitest-plugin の道具を使う。保存の形式（鍵 `s:<id>` / `l:<id>`、星の `born`、版の印 `v: 2`、
// 持ち主 ID の形式）は ADR 0007・0009 と server/src/world.ts の StoredStar / StoredLink の型を仕様として扱う。

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, connect, forbidInFrames, join, newId, newUid, roomStub, sleep, snapshot } from "./helpers";

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
    const second = newUid();
    forbidInFrames(second);
    a.c.send({ t: "hello", uid: second });
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

describe("保存データの読み込み（ADR 0006・0007）", () => {
  // サーバーが作る持ち主 ID の形（OWNER_ID_PATTERN）に合う値。uid のハッシュである必要はない
  const OWNER = "0123456789abcdef0123456789abcdef";

  // 今の形式（版 2）の星と線
  const goodStar = (id: string, x: number, now: number) => ({ id, x, y: 0, c: 1, by: OWNER, ts: now, born: now, v: 2 });
  const goodLink = (id: string, a: string, b: string, now: number) => ({ id, a, b, by: OWNER, ts: now, v: 2 });

  // 最初の接続より前に、保存先へ直接書く。そのあと runInDurableObject で起きたインスタンスを壊し、
  // 次の接続で保存先から読み直させる
  async function seed(records: Record<string, unknown>) {
    await runInDurableObject(roomStub(), async (_instance, state) => {
      await state.storage.put(records);
    });
    await evictDurableObject(roomStub(), { webSockets: "close" });
  }

  async function storedKeys(keys: string[]): Promise<string[]> {
    return runInDurableObject(roomStub(), async (_instance, state) => [...(await state.storage.get(keys)).keys()]);
  }

  it("対照: 今の形式で保存された星と線は、読み込まれて welcome に出る（保存専用の born / v は出ない）", async () => {
    const now = Date.now();
    await seed({
      "s:good-a": goodStar("good-a", 0, now),
      "s:good-b": goodStar("good-b", 2, now),
      "l:good-l": goodLink("good-l", "good-a", "good-b", now),
    });
    const { w } = await join();
    expect([...w.stars].sort((p, q) => p.id.localeCompare(q.id))).toEqual([
      { id: "good-a", x: 0, y: 0, c: 1, by: OWNER, ts: now },
      { id: "good-b", x: 2, y: 0, c: 1, by: OWNER, ts: now },
    ]);
    expect(w.links).toEqual([{ id: "good-l", a: "good-a", b: "good-b", by: OWNER, ts: now }]);
    expect(await storedKeys(["s:good-a", "s:good-b", "l:good-l"])).toHaveLength(3);
  });

  it("版の印が無い・古い、by が生の uid、端の星が無い線は、welcome に出ず、uid も漏れず、保存先から消える", async () => {
    const now = Date.now();
    const rawUid = newUid();
    forbidInFrames(rawUid); // どの接続のどの受信フレームにも出てこないことを、cleanup でも確かめる
    const bad: Record<string, unknown> = {
      // (a) 版の印が無い / 版 1（他は今の形式と同じ）
      "s:old-nov": { id: "old-nov", x: 4, y: 0, c: 1, by: OWNER, ts: now, born: now },
      "s:old-v1": { ...goodStar("old-v1", 5, now), v: 1 },
      "l:old-lnov": { id: "old-lnov", a: "good-a", b: "good-b", by: OWNER, ts: now },
      // (b) by が生の uid（持ち主 ID の形ではない）
      "s:old-uid": { ...goodStar("old-uid", 6, now), by: rawUid },
      "l:old-luid": { ...goodLink("old-luid", "good-a", "good-b", now), by: rawUid },
      // (c) 端の星が無い線（保存先に無い星 / 上で捨てられる星につながる線）
      "l:old-dangling": goodLink("old-dangling", "good-a", "no-such-star", now),
      "l:old-to-bad": goodLink("old-to-bad", "good-a", "old-uid", now),
    };
    await seed({
      ...bad,
      // 同じ回に今の形式のものも置き、読み込み自体が行われたことを確かめる
      "s:good-a": goodStar("good-a", 0, now),
      "s:good-b": goodStar("good-b", 2, now),
      "l:good-l": goodLink("good-l", "good-a", "good-b", now),
    });

    const { c, w } = await join();
    expect(w.stars.map((s) => s.id).sort()).toEqual(["good-a", "good-b"]);
    expect(w.links.map((l) => l.id)).toEqual(["good-l"]);
    // 星を置いて配信を一巡させてから、受け取った全フレームの生の文字列を見る
    const watcher = await join();
    const sid = newId();
    c.send({ t: "star", id: sid, x: 0, y: 1, c: 0 });
    await watcher.c.waitFor("star", (s) => s.id === sid);
    for (const raw of [...c.raw, ...watcher.c.raw]) expect(raw).not.toContain(rawUid);
    // 捨てたものは、読んだ鍵のまま保存先からも消える（起動のたびに読んで捨て直さない）。今の形式のものは残る
    const badKeys = Object.keys(bad);
    // 削除は非同期に書かれうるので、少しの間は待つ
    let left = await storedKeys(badKeys);
    for (let i = 0; i < 100 && left.length > 0; i++) {
      await sleep(20);
      left = await storedKeys(badKeys);
    }
    expect(left).toEqual([]);
    expect((await storedKeys(["s:good-a", "s:good-b", "l:good-l"])).sort()).toEqual([
      "l:good-l",
      "s:good-a",
      "s:good-b",
    ]);
  });
});
