// 星・線・きらめきの配信と、持ち主・上限のルール（docs/specs/0003、ADR 0007）。黒箱テスト。

import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_STARS_PER_USER } from "../../../shared/limits";
import { evictDurableObject } from "cloudflare:test";
import { HEX32, cleanup, join, newId, roomStub, snapshot, waitFor } from "./helpers";

afterEach(async () => {
  vi.useRealTimers();
  await cleanup();
});

describe("星", () => {
  it("星の配置が他の接続に届く。持ち主は me で、uid やサーバー専用の項目を含まない", async () => {
    const a = await join();
    const b = await join();
    const id = newId();
    b.c.send({ t: "star", id, x: 1.5, y: -2, c: 3 });
    const star = await a.c.waitFor("star", (s) => s.id === id);
    expect(star).toMatchObject({ id, x: 1.5, y: -2, c: 3, by: b.w.me });
    expect(star.by).toMatch(HEX32);
    expect(star.by).not.toBe(b.c.uid);
    expect(typeof star.ts).toBe("number");
    // 配信される項目は仕様（shared/protocol.ts の star）のものだけ。born / v / uid などは無い
    // （すべての受信フレームの厳密な検証と uid の漏れの確認は、helpers の cleanup が各テストのあとに行う）
    expect(Object.keys(star).sort()).toEqual(["by", "c", "id", "t", "ts", "x", "y"]);
  });

  it("星の消去が他の接続に届く（星は誰でも消せる。docs/specs/0001 #5）", async () => {
    const a = await join();
    const b = await join();
    const id = newId();
    b.c.send({ t: "star", id, x: 0, y: 0, c: 0 });
    await a.c.waitFor("star", (s) => s.id === id);
    a.c.send({ t: "unstar", id });
    await b.c.waitFor("unstar", (m) => m.id === id);
    expect((await join()).w.stars.some((s) => s.id === id)).toBe(false);
  });

  it("消された星は、持ち主が同じ id で置き直せる（復活。docs/specs/0001 #9）", async () => {
    const a = await join();
    const b = await join();
    const id = newId();
    b.c.send({ t: "star", id, x: 0, y: 0, c: 4 });
    await a.c.waitFor("star", (s) => s.id === id);
    a.c.send({ t: "unstar", id });
    await b.c.waitFor("unstar", (m) => m.id === id);
    b.c.send({ t: "star", id, x: 0, y: 0, c: 4 });
    const back = await waitFor(() => a.c.of("star").filter((s) => s.id === id)[1], 3000, "復活した星");
    expect(back.by).toBe(b.w.me);
    expect(b.c.of("reject")).toEqual([]);
  });

  it("きらめき（admire）が全員に届く", async () => {
    const owner = await join();
    const fan = await join();
    const far = await join();
    // far は視界を遠くに置く（admire は視界に関係なく届く）
    far.c.send({ t: "p", x: 5000, y: 5000, c: 0, v: [4990, 4990, 5010, 5010] });
    const id = newId();
    owner.c.send({ t: "star", id, x: 0, y: 0, c: 2 });
    const star = await fan.c.waitFor("star", (s) => s.id === id);
    await far.c.waitFor("star", (s) => s.id === id);
    // 星の ts から 60 秒はきらめきが効かない（protocol.ts）。Worker はテストと同じ isolate で動くので、
    // Date だけを偽物にして 61 秒進める（タイマーは本物のまま）
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    fan.c.send({ t: "admire", id });
    const got = await Promise.all([owner, fan, far].map((p) => p.c.waitFor("admire", (m) => m.id === id)));
    for (const m of got) expect(m.ts).toBeGreaterThan(star.ts);
    expect(new Set(got.map((m) => m.ts)).size).toBe(1);
  });

  it("他人の星は上書きできず、reject が返る", async () => {
    const a = await join();
    const b = await join();
    const id = newId();
    b.c.send({ t: "star", id, x: 0.1, y: 0.1, c: 3 });
    await a.c.waitFor("star", (s) => s.id === id);
    a.c.send({ t: "star", id, x: 9, y: 9, c: 1 });
    await a.c.waitFor("reject", (m) => m.kind === "star" && m.id === id);
    const s = (await join()).w.stars.find((x) => x.id === id);
    expect(s).toMatchObject({ x: 0.1, y: 0.1, c: 3, by: b.w.me });
  });

  it(`1 人 ${MAX_STARS_PER_USER} 個を超える星は reject され、保存も ${MAX_STARS_PER_USER} 個まで`, async () => {
    const a = await join();
    const ids: string[] = [];
    // 2 トークン × 70 = 140 は、一度に使える量（200）に収まる
    for (let i = 0; i < MAX_STARS_PER_USER + 6; i++) {
      const id = newId();
      ids.push(id);
      a.c.send({ t: "star", id, x: i, y: 0, c: i % 8 });
    }
    await waitFor(() => a.c.of("reject").filter((m) => m.kind === "star").length >= 6, 3000, "6 件の reject");
    const rejected = new Set(a.c.of("reject").map((m) => m.id));
    expect(rejected.size).toBe(6);
    // 「保存も」を確かめるため、接続を閉じて Durable Object を退避し（メモリを捨て）、保存先から読み直させてから数える
    await a.c.close();
    await evictDurableObject(roomStub(), { webSockets: "close" });
    const kept = (await snapshot()).stars.filter((s) => ids.includes(s.id));
    expect(kept).toHaveLength(MAX_STARS_PER_USER);
    expect(kept.some((s) => rejected.has(s.id))).toBe(false);
  });
});

describe("線", () => {
  async function twoStars() {
    const a = await join();
    const b = await join();
    const s1 = newId();
    const s2 = newId();
    b.c.send({ t: "star", id: s1, x: 0, y: 0, c: 1 });
    b.c.send({ t: "star", id: s2, x: 3, y: 0, c: 1 });
    await a.c.waitFor("star", (s) => s.id === s2);
    return { a, b, s1, s2 };
  }

  it("線の作成が他の接続に届く。持ち主は me で、サーバー専用の項目を含まない", async () => {
    const { a, b, s1, s2 } = await twoStars();
    const id = newId();
    b.c.send({ t: "link", id, a: s1, b: s2 });
    const link = await a.c.waitFor("link", (l) => l.id === id);
    expect(link).toMatchObject({ id, a: s1, b: s2, by: b.w.me });
    expect(typeof link.ts).toBe("number");
    expect(Object.keys(link).sort()).toEqual(["a", "b", "by", "id", "t", "ts"]);
  });

  it("同じ 2 点の線の重複は reject される（向きが逆でも）", async () => {
    const { a, b, s1, s2 } = await twoStars();
    const id = newId();
    b.c.send({ t: "link", id, a: s1, b: s2 });
    await a.c.waitFor("link", (l) => l.id === id);
    const dup = newId();
    a.c.send({ t: "link", id: dup, a: s2, b: s1 });
    await a.c.waitFor("reject", (m) => m.kind === "link" && m.id === dup);
    const dup2 = newId();
    b.c.send({ t: "link", id: dup2, a: s1, b: s2 });
    await b.c.waitFor("reject", (m) => m.kind === "link" && m.id === dup2);
    expect((await join()).w.links.filter((l) => l.id === dup || l.id === dup2)).toEqual([]);
  });

  it("線の削除は持ち主だけができ、他の接続に届く", async () => {
    const { a, b, s1, s2 } = await twoStars();
    const id = newId();
    b.c.send({ t: "link", id, a: s1, b: s2 });
    await a.c.waitFor("link", (l) => l.id === id);
    a.c.send({ t: "unlink", id });
    const marker = newId();
    a.c.send({ t: "star", id: marker, x: 7, y: 7, c: 0 });
    await b.c.waitFor("star", (s) => s.id === marker);
    expect(b.c.of("unlink")).toEqual([]);
    expect((await join()).w.links.some((l) => l.id === id)).toBe(true);
    b.c.send({ t: "unlink", id });
    await a.c.waitFor("unlink", (m) => m.id === id);
    expect((await join()).w.links.some((l) => l.id === id)).toBe(false);
  });

  it("星を消すと、その星につながる線も消える", async () => {
    const { a, b, s1, s2 } = await twoStars();
    const id = newId();
    b.c.send({ t: "link", id, a: s1, b: s2 });
    await a.c.waitFor("link", (l) => l.id === id);
    b.c.send({ t: "unstar", id: s1 });
    await a.c.waitFor("unstar", (m) => m.id === s1);
    const w = (await join()).w;
    expect(w.links.some((l) => l.id === id)).toBe(false);
    expect(w.stars.some((s) => s.id === s2)).toBe(true);
  });
});
