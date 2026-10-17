// 視界ベースの位置配信と、送信間隔の指示（docs/specs/0003、ADR 0002・0003・0008）。黒箱テスト。

import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "../../../shared/protocol";
import { cleanup, join, sleep, waitFor } from "./helpers";

afterEach(cleanup);

const NEAR: [number, number, number, number] = [-10, -10, 10, 10];

describe("位置（ps）と波紋（pulse）", () => {
  it("視界内の相手に ps が届く。形は [id, x, y, color] で、自分の位置は返らない", async () => {
    const a = await join();
    const b = await join();
    a.c.send({ t: "p", x: 0.5, y: 0.5, c: 1, v: NEAR });
    b.c.send({ t: "p", x: 0.52, y: 0.5, c: 2, v: NEAR });
    const seen = await a.c.waitFor("ps", (m) => m.d.some((p) => p[0] === b.w.id));
    expect(seen.d.find((p) => p[0] === b.w.id)).toEqual([b.w.id, 0.52, 0.5, 2]);
    await b.c.waitFor("ps", (m) => m.d.some((p) => p[0] === a.w.id));
    for (const m of a.c.of("ps")) expect(m.d.some((p) => p[0] === a.w.id)).toBe(false);
  });

  it("視界の遠い相手には、近くの波紋が届かない（近くの相手には届く）", async () => {
    const a = await join();
    const near = await join();
    const far = await join();
    a.c.send({ t: "p", x: 0, y: 0, c: 0, v: NEAR });
    near.c.send({ t: "p", x: 1, y: 1, c: 0, v: NEAR });
    far.c.send({ t: "p", x: 5000, y: 5000, c: 0, v: [4990, 4990, 5010, 5010] });
    // 3 人の視界がサーバーに届いたこと（near が a の位置を受け取る）を確かめてから波紋を出す
    await near.c.waitFor("ps", (m) => m.d.some((p) => p[0] === a.w.id));
    await a.c.waitFor("ps", (m) => m.d.some((p) => p[0] === near.w.id));
    a.c.send({ t: "pulse", x: 0, y: 0 });
    const got = await near.c.waitFor("pulse");
    expect(got).toMatchObject({ x: 0, y: 0 });
    // near に届いた時点で配信は済んでいる。far にはそのあと少し待っても届かない
    await sleep(300);
    expect(far.c.of("pulse")).toEqual([]);
  });

  it("視界を送っていない接続には pulse が届かない", async () => {
    const a = await join();
    const near = await join();
    const blind = await join(); // p を一度も送らない
    a.c.send({ t: "p", x: 0, y: 0, c: 0, v: NEAR });
    near.c.send({ t: "p", x: 1, y: 1, c: 0, v: NEAR });
    await near.c.waitFor("ps", (m) => m.d.some((p) => p[0] === a.w.id));
    a.c.send({ t: "pulse", x: 0, y: 0 });
    await near.c.waitFor("pulse");
    await sleep(300);
    expect(blind.c.of("pulse")).toEqual([]);
  });

  it("誰も動かない間は、位置のメッセージが飛び続けない", { timeout: 15_000 }, async () => {
    const a = await join();
    const b = await join();
    a.c.send({ t: "p", x: 0, y: 0, c: 0, v: NEAR });
    b.c.send({ t: "p", x: 1, y: 1, c: 0, v: NEAR });
    await a.c.waitFor("ps", (m) => m.d.some((p) => p[0] === b.w.id));
    // 動きが 30 tick（100 人までは 1 tick = 100ms）無ければ配信タイマーは止まる。
    // 粗い一覧（2 秒ごと）を含めて落ち着くのを待ってから、静かな間に何も届かないことを確かめる
    const quietMs = 2500;
    const settled = (c: { got: ServerMessage[] }) => {
      let last = c.got.length;
      let since = performance.now();
      return () => {
        if (c.got.length !== last) {
          last = c.got.length;
          since = performance.now();
        }
        return performance.now() - since >= quietMs;
      };
    };
    const quietA = settled(a.c);
    const quietB = settled(b.c);
    await waitFor(() => quietA() && quietB(), 12_000, `${quietMs}ms の静けさ`);
  });
});

describe("送信間隔の指示（rate）", () => {
  it("空に 1 人のときは welcome.sendMs が 1000。2 人目が入ると 100 に、1 人に戻ると 1000 に戻る", async () => {
    const a = await join();
    expect(a.w.sendMs).toBe(1000);
    const b = await join();
    await a.c.waitFor("rate", (m) => m.sendMs === 100);
    // 2 人目は welcome で 100 を受け取るか、直後の rate で 100 を受け取る（最後の指示が 100 であればよい）
    const lastB = () => {
      const r = b.c.of("rate").at(-1);
      return r === undefined ? b.w.sendMs : r.sendMs;
    };
    await waitFor(() => lastB() === 100, 3000, "2 人目の送信間隔が 100");
    await b.c.close();
    await a.c.waitFor("rate", (m) => m.sendMs === 1000);
  });
});
