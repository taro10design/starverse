// 少数の接続で部屋の容量・枠を使い切る攻撃への備え（4 回目のレビュー）。黒箱テスト。
// - hello 前の接続は別枠（maxPendingConnections = 20）。超えたら次の空に回す（1 つの空の別枠で、サイト全体を止めさせない）
// - 満員の判定・送信間隔は hello 済みの人だけで数える
// - 同じ接続元（IP）の同時接続数は空ごとに 32 まで（429。学校や会社の NAT の内側の人数を見込む）
// - 部屋全体の新しい星の作成速度（1 分に 120 個）を超えたら reject
// - レート制限で読まずに捨てた星にも reject が返る
// - hello 済みの接続の、読めない JSON・知らない t は違反として数える
//
// 道具は helpers.ts に頼らず、このファイルに置く（接続元の IP と、Upgrade の応答そのものを確かめるため）。

import { SELF, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "../../../shared/protocol";

// サーバーの設定（server/src/config.ts）と同じ値。実装には依存しない
const MAX_PENDING = 20;
const MAX_CONNS_PER_IP = 32;
const MAX_NEW_STARS_PER_MINUTE = 120;
const MAX_STARS_PER_USER = 64;
const MAX_VIOLATIONS = 20;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until<T>(probe: () => T | undefined | null | false, ms = 3000, what = "条件"): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = probe();
    if (v !== undefined && v !== null && v !== false) return v;
    if (performance.now() - t0 > ms) throw new Error(`${what} が ${ms}ms 以内に成り立たなかった`);
    await sleep(10);
  }
}

// テストごとに別の IP（接続頻度の制限は Durable Object の reset で消えないので、毎回新しい値にする）
let ipSeq = 0;
const runTag = Math.floor(Math.random() * 200) + 1;
const freshIp = () => `198.51.${runTag}.${(ipSeq++ % 250) + 1}`;

interface Client {
  ws: WebSocket;
  got: ServerMessage[];
  closed: boolean;
  closeCode: number | null;
  send(m: unknown): void;
  of<T extends ServerMessage["t"]>(t: T): Extract<ServerMessage, { t: T }>[];
}

const opened = new Set<Client>();

afterEach(async () => {
  for (const c of opened) if (!c.closed) c.ws.close(1000, "test done");
  opened.clear();
  await sleep(50);
  await reset();
});

// /ws に Upgrade を送る。応答そのものを返す（101 でなくても例外にしない）
function upgrade(ip: string | null): Promise<Response> {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (ip !== null) headers["CF-Connecting-IP"] = ip;
  return SELF.fetch("http://uchu.test/ws", { headers });
}

async function open(ip: string | null = freshIp()): Promise<Client> {
  const res = await upgrade(ip);
  const ws = res.webSocket;
  if (res.status !== 101 || ws === null) throw new Error(`Upgrade に失敗した: ${res.status} ${await res.text()}`);
  ws.accept();
  const c: Client = {
    ws,
    got: [],
    closed: false,
    closeCode: null,
    send(m) {
      ws.send(typeof m === "string" ? m : JSON.stringify(m));
    },
    of<T extends ServerMessage["t"]>(t: T) {
      return c.got.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
    },
  };
  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string" || !e.data.startsWith("{")) return;
    c.got.push(JSON.parse(e.data) as ServerMessage);
  });
  ws.addEventListener("close", (e) => {
    c.closed = true;
    c.closeCode = e.code;
  });
  opened.add(c);
  return c;
}

// hello して welcome まで待つ
async function member(ip: string | null = freshIp()) {
  const c = await open(ip);
  c.send({ t: "hello", uid: crypto.randomUUID() });
  const w = await until(() => c.of("welcome")[0], 3000, "welcome");
  return { c, w };
}

async function roomStats(): Promise<{ connections: number; pending: number }> {
  const res = await env.UNIVERSE.getByName("space").fetch("https://room/stats");
  return (await res.json()) as { connections: number; pending: number };
}

const newId = () => "t-" + crypto.randomUUID().slice(0, 8);

describe("hello 前の接続の別枠", () => {
  it(`hello 前の接続が ${MAX_PENDING} 本あると、次の接続は次の空に回る。1 本が hello を済ませると、また先頭の空に入れる`, async () => {
    const waiting: Client[] = [];
    for (let i = 0; i < MAX_PENDING; i++) waiting.push(await open());
    const spilled = await open();
    expect(spilled.closed).toBe(false);
    expect(await roomStats()).toMatchObject({ pending: MAX_PENDING });

    waiting[0].send({ t: "hello", uid: crypto.randomUUID() });
    await until(() => waiting[0].of("welcome")[0], 3000, "welcome");
    await open();
    expect(await roomStats()).toMatchObject({ connections: 1, pending: MAX_PENDING });
  });

  it("満員の判定と送信間隔は hello 済みの人だけで数える（hello 前の接続が何本あっても 1 人なら 1000ms）", async () => {
    for (let i = 0; i < MAX_PENDING - 1; i++) await open();
    const { w } = await member();
    expect(w.sendMs).toBe(1000);
    expect(await roomStats()).toMatchObject({ connections: 1, pending: MAX_PENDING - 1 });
    // 2 人目が入ると、hello 済みの 2 人ぶんの間隔になる
    const b = await member();
    expect(b.w.sendMs).toBe(100);
  });
});

describe("同じ接続元（IP）の同時接続数", () => {
  it(`同じ IP からは ${MAX_CONNS_PER_IP} 本まで。次は 429。1 本閉じると、また入れる`, async () => {
    const ip = freshIp();
    const conns: Client[] = [];
    for (let i = 0; i < MAX_CONNS_PER_IP; i++) conns.push((await member(ip)).c);
    const over = await upgrade(ip);
    expect(over.status).toBe(429);
    await over.body?.cancel();
    // 別の IP は入れる
    await member();

    conns[0].ws.close(1000, "bye");
    await until(() => conns[0].closed, 3000, "切断");
    // サーバー側の片付け（onClose）が済むまで待ってから入り直す
    for (let i = 0; (await roomStats()).connections !== MAX_CONNS_PER_IP; i++) {
      if (i > 100) throw new Error("サーバー側の片付けが済まない");
      await sleep(20);
    }
    const back = await member(ip);
    expect(back.c.closed).toBe(false);
  });
});

describe("部屋全体の新しい星の作成速度", () => {
  it(`1 分に ${MAX_NEW_STARS_PER_MINUTE} 個を超える新しい星は、持ち主の枠が残っていても reject される`, async () => {
    const a = await member();
    const b = await member();
    const watcher = await member();
    const aIds = Array.from({ length: MAX_STARS_PER_USER }, () => newId());
    aIds.forEach((id, i) => a.c.send({ t: "star", id, x: i, y: 0, c: 0 }));
    const rest = MAX_NEW_STARS_PER_MINUTE - MAX_STARS_PER_USER;
    const bIds = Array.from({ length: rest }, () => newId());
    bIds.forEach((id, i) => b.c.send({ t: "star", id, x: i, y: 5, c: 0 }));
    const all = [...aIds, ...bIds];
    await until(() => all.every((id) => watcher.c.of("star").some((s) => s.id === id)), 5000, "120 個の星");

    // b はまだ持ち主の枠（64 個）を使い切っていないが、部屋全体の作成速度の上限に掛かる
    const late = newId();
    b.c.send({ t: "star", id: late, x: 0, y: 9, c: 0 });
    await until(() => b.c.of("reject").find((r) => r.id === late), 3000, "reject");
    expect(watcher.c.of("star").some((s) => s.id === late)).toBe(false);

    // 自分の星の置き直し（新しい星ではない）は通る
    a.c.send({ t: "star", id: aIds[0], x: 50, y: 50, c: 1 });
    await until(() => watcher.c.of("star").find((s) => s.id === aIds[0] && s.x === 50), 3000, "置き直し");
  });
});

describe("レート制限で読まずに捨てた星", () => {
  it("トークンを使い切ったあとに送った星には reject が返り、配信されない", async () => {
    const a = await member();
    const watcher = await member();
    // 波紋（1 回 4）で、一度に使える量（200）を使い切る（あふれは切断の基準 100 通より少ない）
    for (let i = 0; i < 70; i++) a.c.send({ t: "pulse", x: 0, y: 0 });
    const ids = Array.from({ length: 5 }, () => newId());
    for (const id of ids) a.c.send({ t: "star", id, x: 1, y: 1, c: 0 });
    await until(
      () => ids.every((id) => a.c.of("reject").some((r) => r.kind === "star" && r.id === id)),
      3000,
      "reject",
    );
    expect(a.c.closed).toBe(false);
    expect(watcher.c.of("star").some((s) => ids.includes(s.id))).toBe(false);
  });
});

describe("hello 済みの接続の違反", () => {
  it(`読めない JSON・知らない t を送り続けると、${MAX_VIOLATIONS} 回目で 1008 で切断される`, async () => {
    const a = await member();
    for (let i = 0; i < MAX_VIOLATIONS / 2; i++) a.c.send("not json");
    for (let i = 0; i < MAX_VIOLATIONS / 2; i++) a.c.send({ t: "evil" });
    await until(() => a.c.closed, 3000, "切断");
    expect(a.c.closeCode).toBe(1008);
  });
});
