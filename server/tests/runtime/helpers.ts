// ランタイム用テストの道具。Worker の /ws に WebSocket でつなぎ、届いたメッセージを貯める小さなクライアント。
// 実装（server/src）には依存しない。使うのは shared/protocol.ts の型と、wrangler.jsonc のバインディングだけ。

import { SELF, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ClientMessage, ServerMessage } from "../../../shared/protocol";

// Worker（wrangler.jsonc の main）の既定のエクスポートに HTTP で問い合わせる。
// SELF は 1.4.4 で非推奨（exports.default を勧める）だが、exports の型付けには main の型を
// Cloudflare.GlobalProps に宣言する必要があり、その宣言が server/src の型検査に波及するため、SELF を使う
export function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://uchu.test${path}`, init);
}

// 先頭の空の名前（ADR 0001。docs/specs/0003 の「先頭の空の名前は space のまま」）
export const FIRST_ROOM = "space";

export const HEX32 = /^[0-9a-f]{32}$/;

// サーバーが保存にだけ使う項目と、配信に出てはいけない秘密（scripts/e2e.mjs と同じ観点）
export const SERVER_ONLY_KEYS = ["uid", "born", "origin", "v"] as const;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const newUid = () => crypto.randomUUID();
export const newId = () => "t-" + crypto.randomUUID().slice(0, 8);

// 条件が成り立つまで待つ（固定の sleep の代わり）。時間内に成り立たなければ例外
// 時計は performance.now() で測る（テストが Date を偽物に替えても、待ちの締め切りは本物の時間で進む）
export async function waitFor<T>(probe: () => T | undefined | null | false, ms = 3000, what = "条件"): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = probe();
    if (v !== undefined && v !== null && v !== false) return v;
    if (performance.now() - t0 > ms) throw new Error(`${what} が ${ms}ms 以内に成り立たなかった`);
    await sleep(10);
  }
}

type Welcome = Extract<ServerMessage, { t: "welcome" }>;

export interface TestClient {
  readonly uid: string;
  readonly ws: WebSocket;
  // JSON として受け取ったメッセージ（届いた順）
  readonly got: ServerMessage[];
  // 文字列のまま受け取ったもの（JSON でないものを含む）
  readonly raw: string[];
  closed: boolean;
  closeCode: number | null;
  send(m: ClientMessage | Record<string, unknown> | string): void;
  hello(): void;
  // 条件に合う最初のメッセージを待つ
  waitFor<T extends ServerMessage["t"]>(
    t: T,
    pred?: (m: Extract<ServerMessage, { t: T }>) => boolean,
    ms?: number,
  ): Promise<Extract<ServerMessage, { t: T }>>;
  welcome(ms?: number): Promise<Welcome>;
  waitClosed(ms?: number): Promise<number | null>;
  of<T extends ServerMessage["t"]>(t: T): Extract<ServerMessage, { t: T }>[];
  close(): Promise<void>;
}

const opened = new Set<TestClient>();
// 接続元の IP（テストごとに別の値）。接続元ごとの制限がある実装でも、ない実装でも同じに動くように
let ipCounter = 1;

function isServerMessage(v: unknown): v is ServerMessage {
  return typeof v === "object" && v !== null && "t" in v && typeof v.t === "string";
}

export interface ConnectOptions {
  uid?: string;
  hello?: boolean;
}

// /ws に WebSocket でつなぐ。hello: false でなければ、開いたらすぐ hello を送る
export async function connect({ uid = newUid(), hello = true }: ConnectOptions = {}): Promise<TestClient> {
  const ip = `203.0.113.${ipCounter++ % 250}`;
  const res = await fetchWorker("/ws", {
    headers: { Upgrade: "websocket", "CF-Connecting-IP": ip },
  });
  const ws = res.webSocket;
  if (res.status !== 101 || ws === null) {
    throw new Error(`WebSocket の Upgrade に失敗した: status ${res.status} ${await res.text()}`);
  }
  ws.accept();

  const c: TestClient = {
    uid,
    ws,
    got: [],
    raw: [],
    closed: false,
    closeCode: null,
    send(m) {
      ws.send(typeof m === "string" ? m : JSON.stringify(m));
    },
    hello() {
      c.send({ t: "hello", uid });
    },
    waitFor(t, pred, ms = 3000) {
      return waitFor(() => c.of(t).find((m) => pred === undefined || pred(m)), ms, `${t} の受信`);
    },
    welcome(ms = 3000) {
      return c.waitFor("welcome", undefined, ms);
    },
    async waitClosed(ms = 3000) {
      await waitFor(() => c.closed, ms, "切断");
      return c.closeCode;
    },
    of<T extends ServerMessage["t"]>(t: T) {
      return c.got.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
    },
    async close() {
      if (c.closed) return;
      ws.close(1000, "test done");
      // サーバーからの close を待つ（届かなくても先へ進む。後片付けの reset() で Durable Object ごと消す）
      await waitFor(() => c.closed, 1000, "切断").catch(() => undefined);
    },
  };
  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    c.raw.push(e.data);
    if (!e.data.startsWith("{")) return;
    const parsed: unknown = JSON.parse(e.data);
    if (isServerMessage(parsed)) c.got.push(parsed);
  });
  ws.addEventListener("close", (e) => {
    c.closed = true;
    c.closeCode = e.code;
  });
  opened.add(c);
  if (hello) c.hello();
  return c;
}

// hello して welcome まで待った接続
export async function join(opts: Omit<ConnectOptions, "hello"> = {}): Promise<{ c: TestClient; w: Welcome }> {
  const c = await connect(opts);
  const w = await c.welcome();
  return { c, w };
}

// 1 回だけつないで welcome を受け取り、閉じる（保存された状態の確認用）
export async function snapshot(): Promise<Welcome> {
  const { c, w } = await join();
  await c.close();
  return w;
}

export function roomStub(name = FIRST_ROOM): DurableObjectStub {
  return env.UNIVERSE.get(env.UNIVERSE.idFromName(name));
}

// 各テストのあと: 開いた接続をすべて閉じ、Durable Object（メモリとストレージ）をすべて消す。
// 次のテストは空の空から始まる
export async function cleanup(): Promise<void> {
  await Promise.all([...opened].map((c) => c.close()));
  opened.clear();
  await reset();
}

// 配信に出てはいけない項目を持っているか
export function leaksServerOnly(o: object): boolean {
  return SERVER_ONLY_KEYS.some((k) => Object.hasOwn(o, k));
}
