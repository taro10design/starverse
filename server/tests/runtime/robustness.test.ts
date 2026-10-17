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
    await roundTrip(a, watcher);
    expect(a.c.closed).toBe(false);
    const w = (await join()).w;
    for (const id of Object.values(bad)) expect(w.stars.some((s) => s.id === id)).toBe(false);
    expect(watcher.c.of("star").some((s) => Object.values(bad).includes(s.id))).toBe(false);
  });

  // JSON.stringify は NaN / Infinity を null にしてしまうので、生の文字列で送る。
  // 1e999 は JSON.parse で Infinity になる。NaN はそもそも JSON として読めない
  const nonFinite = ["1e999", "-1e999", "NaN", "Infinity"];

  it("座標が NaN / Infinity の星は置かれない", async () => {
    const a = await join();
    const watcher = await join();
    const ids: string[] = [];
    for (const n of nonFinite) {
      for (const field of ["x", "y"] as const) {
        const id = newId();
        ids.push(id);
        const x = field === "x" ? n : "0";
        const y = field === "y" ? n : "0";
        a.c.send(`{"t":"star","id":"${id}","x":${x},"y":${y},"c":0}`);
      }
    }
    await roundTrip(a, watcher);
    expect(a.c.closed).toBe(false);
    expect(watcher.c.of("star").some((s) => ids.includes(s.id))).toBe(false);
    const w = (await join()).w;
    expect(w.stars.some((s) => ids.includes(s.id))).toBe(false);
  });

  it("座標が NaN / Infinity の位置（p）は無視され、前の位置のまま", async () => {
    const a = await join();
    const watcher = await join();
    const near: [number, number, number, number] = [-10, -10, 10, 10];
    watcher.c.send({ t: "p", x: 0, y: 0, c: 0, v: near });
    a.c.send({ t: "p", x: 1, y: 1, c: 2, v: near });
    const first = await watcher.c.waitFor("ps", (m) => m.d.some((p) => p[0] === a.w.id && p[1] === 1 && p[2] === 1));
    const start = watcher.c.of("ps").indexOf(first);
    for (const n of nonFinite) {
      a.c.send(`{"t":"p","x":${n},"y":1,"c":2}`);
      a.c.send(`{"t":"p","x":1,"y":${n},"c":2}`);
    }
    // 正しい位置を送り、それが届いたら、それより前の不正な位置は処理済み
    a.c.send({ t: "p", x: 2, y: 2, c: 2 });
    await watcher.c.waitFor("ps", (m) => m.d.some((p) => p[0] === a.w.id && p[1] === 2 && p[2] === 2));
    expect(a.c.closed).toBe(false);
    // (1, 1) が届いてから後に watcher に届いた a の位置は、正しく送った (1, 1) と (2, 2) だけ
    // （有限でない値は JSON で null になるので、helpers の厳密な検証でも落ちる）
    const seen = watcher.c
      .of("ps")
      .slice(start)
      .flatMap((m) => m.d.filter((p) => p[0] === a.w.id))
      .map((p) => `${p[1]},${p[2]}`);
    expect(new Set(seen)).toEqual(new Set(["1,1", "2,2"]));
    // 後から入った人の welcome にも、a は (2, 2) で載っている
    const later = await join();
    expect(later.w.dots.find((d) => d.id === a.w.id)).toMatchObject({ x: 2, y: 2, c: 2 });
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
