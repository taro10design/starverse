// 不正な入力・レート制限・死活監視・/stats（docs/specs/0001 #19・#20、docs/specs/0003 #8・#11・#12）。黒箱テスト。

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fetchWorker, join, newId, waitFor } from "./helpers";

afterEach(cleanup);

// 操作が反映されたことを、別の接続に届く星で確かめる（届いた時点で、それより前の入力は処理済み）
async function roundTrip(sender: Awaited<ReturnType<typeof join>>, watcher: Awaited<ReturnType<typeof join>>) {
  const id = newId();
  sender.c.send({ t: "star", id, x: 100, y: 100, c: 0 });
  await watcher.c.waitFor("star", (s) => s.id === id);
}

describe("不正な入力", () => {
  it("壊れた JSON・未知の t・範囲外の座標・不正な型・512 バイト超のあとも接続が保たれ、操作は反映されない", async () => {
    const a = await join();
    const watcher = await join();
    const bad = { far: newId(), nan: newId(), big: newId(), color: newId() };
    a.c.send("not json at all");
    a.c.send("{");
    a.c.send({ t: "evil" });
    a.c.send({ t: "star" });
    a.c.send({ t: "star", id: bad.nan, x: "NaN", y: 0, c: 0 });
    a.c.send({ t: "star", id: bad.far, x: 1e9, y: 0, c: 0 });
    a.c.send({ t: "star", id: bad.color, x: 0, y: 0, c: 99 });
    // 512 バイトを超えるメッセージ（中身は正しい星）
    a.c.send(JSON.stringify({ t: "star", id: bad.big, x: 0, y: 0, c: 0 }) + " ".repeat(600));
    a.c.send({ t: "p", x: Infinity, y: 0, c: 0 });
    await roundTrip(a, watcher);
    expect(a.c.closed).toBe(false);
    const w = (await join()).w;
    for (const id of Object.values(bad)) expect(w.stars.some((s) => s.id === id)).toBe(false);
    expect(watcher.c.of("star").some((s) => Object.values(bad).includes(s.id))).toBe(false);
  });

  it("長すぎる星の id は切り詰めて受け付ける", async () => {
    const a = await join();
    const watcher = await join();
    const long = "x".repeat(40);
    a.c.send({ t: "star", id: long, x: 1, y: 1, c: 0 });
    const star = await watcher.c.waitFor("star", (s) => long.startsWith(s.id));
    expect(star.id.length).toBeLessThan(long.length);
  });

  it("ping に pong が返る", async () => {
    const { c } = await join();
    c.send("ping");
    await waitFor(() => c.raw.includes("pong"), 3000, "pong");
  });
});

describe("レート制限", () => {
  it("短時間に大量に送ると、超えた分は捨てられ、やがて 1008 で切断される", async () => {
    const a = await join();
    const watcher = await join();
    // 波紋が watcher に届くように、2 人とも近くに視界を置く
    const near: [number, number, number, number] = [-10, -10, 10, 10];
    a.c.send({ t: "p", x: 0, y: 0, c: 0, v: near });
    watcher.c.send({ t: "p", x: 1, y: 1, c: 0, v: near });
    await watcher.c.waitFor("ps", (m) => m.d.some((p) => p[0] === a.w.id));
    // 容量 200 のバケット（波紋は 1 回 4）を、回復（毎秒 40）よりずっと速く使い切る。
    // 数を増やしすぎると、捨てる処理だけで部屋が数秒ふさがるので 600 に留める
    const sent = 600;
    for (let i = 0; i < sent; i++) a.c.send({ t: "pulse", x: 0, y: 0 });
    expect(await a.c.waitClosed(5000)).toBe(1008);
    // 超えた分は捨てられている（届いた波紋は送った数よりずっと少ない）
    const delivered = watcher.c.of("pulse").length;
    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(sent / 4);
    // 切断されても、他の接続と部屋は動き続ける
    const b = await join();
    await roundTrip(b, watcher);
  });

  it("上限ぶんの一括操作（星 64 個の全消去）は捨てられない", async () => {
    const a = await join();
    const watcher = await join();
    const ids = Array.from({ length: 64 }, () => newId());
    ids.forEach((id, i) => a.c.send({ t: "star", id, x: i, y: 0, c: 0 }));
    await waitFor(() => ids.every((id) => watcher.c.of("star").some((s) => s.id === id)), 3000, "64 個の星");
    // 星 2×64 = 128 と消去 1×64 = 64 の合計 192 は、一度に使える量（200）に収まる
    for (const id of ids) a.c.send({ t: "unstar", id });
    await waitFor(() => ids.every((id) => watcher.c.of("unstar").some((m) => m.id === id)), 3000, "64 個の消去");
    expect(a.c.closed).toBe(false);
  });
});

describe("/stats", () => {
  it("token 無し・違う token では 404", async () => {
    const none = await fetchWorker("/stats");
    expect(none.status).toBe(404);
    await none.body?.cancel();
    const wrong = await fetchWorker("/stats", { headers: { "x-stats-token": "wrong-token" } });
    expect(wrong.status).toBe(404);
    await wrong.body?.cancel();
  });

  it("正しい token では、空ごとの接続数・星の数・送信間隔の JSON を返す", { timeout: 30_000 }, async () => {
    const a = await join();
    const b = await join();
    const id = newId();
    a.c.send({ t: "star", id, x: 0, y: 0, c: 0 });
    await b.c.waitFor("star", (s) => s.id === id);
    // vitest.config.ts の miniflare.bindings で入れたテスト専用のトークン
    const token = env.STATS_TOKEN;
    expect(token).toBeTypeOf("string");
    const res = await fetchWorker("/stats", { headers: { "x-stats-token": token ?? "" } });
    expect(res.status).toBe(200);
    const stats: unknown = await res.json();
    expect(stats).toMatchObject({ totalConnections: 2 });
    expect(stats).toHaveProperty(
      "rooms",
      expect.arrayContaining([expect.objectContaining({ room: "space", connections: 2, stars: 1, sendMs: 100 })]),
    );
  });
});
