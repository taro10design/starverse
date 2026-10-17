// 「空」＝1つの部屋。Durable Object として動き、接続・配信・永続化を受け持つ。
// 世界のルールは World、メッセージごとの処理は handlers.ts にあり、ここは入出力だけ。

import type { LinkData, PeerDot, PresenceTuple, ServerMessage, StarData } from "../../shared/protocol";
import { COST, LIMITS, RATE, sendMsFor } from "./config";
import type { Env } from "./env";
import { dispatch, type Conn, type RoomApi } from "./handlers";
import { TokenBucket } from "./rate-limit";
import { inView } from "./spatial";
import { parseClientMessage } from "./validate";
import { World } from "./world";

// ハイバネートを越えて残す接続ごとの最小情報
interface Session {
  id: string;
  x: number;
  y: number;
  c: number;
}

const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

// 位置の配信用グリッド。1 セル = ワールド座標 1（おおよそ 1 画面）
const CELL = 1;
const cellKey = (x: number, y: number) => Math.floor(x / CELL) * 1_000_000 + Math.floor(y / CELL);

// 人数が増えるほど配信の間隔を広げる
function tickMsFor(n: number): number {
  for (const [upTo, ms] of LIMITS.tickMsByConnections) if (n <= upTo) return ms;
  return LIMITS.tickMs;
}

export class Universe implements RoomApi, DurableObject {
  readonly world = new World();
  private conns = new Map<WebSocket, Conn>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private quietTicks = 0;
  private tickMs: number = LIMITS.tickMs;
  private sendMs: number = LIMITS.sendMsMin; // クライアントに指示している位置の送信間隔

  constructor(
    private ctx: DurableObjectState,
    _env: Env,
  ) {
    // アプリ層の ping には、Durable Object を起こさずに pong を返す（死活監視用）
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.ctx.blockConcurrencyWhile(async () => {
      await this.migrateLegacy();
      const stars = await this.ctx.storage.list<StarData>({ prefix: "s:" });
      const links = await this.ctx.storage.list<LinkData>({ prefix: "l:" });
      this.world.load(stars.values(), links.values());
      // ハイバネートから起きた場合、生きている接続を取り込み直す
      for (const ws of this.ctx.getWebSockets()) this.connOf(ws);
    });
  }

  // --- 入口 ---

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/stats") return Response.json(this.stats());

    // 満員なら Worker に次の空を探させる
    if (this.conns.size >= LIMITS.roomCapacity) {
      return new Response("room full", { status: 503, headers: { "x-room-full": "1" } });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    const id = crypto.randomUUID().slice(0, 8);
    const session: Session = { id, x: 0.5, y: 0.5, c: 0 };
    server.serializeAttachment(session);
    const conn = this.makeConn(server, session);
    this.conns.set(server, conn);

    this.prune();
    const dots: PeerDot[] = [];
    for (const o of this.conns.values()) {
      if (o === conn) continue;
      dots.push({ id: o.id, x: round4(o.x), y: round4(o.y), c: o.c });
      if (dots.length >= LIMITS.maxWelcomePeers) break;
    }
    this.updateRate();
    this.send(conn, { t: "welcome", id, sendMs: this.sendMs, dots, stars: [...this.world.stars.values()], links: [...this.world.links.values()] });
    this.markDirty(conn); // 他の人に新しい光を知らせる
    await this.ensureAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const conn = this.connOf(ws);
    if (!conn || typeof message !== "string" || message.length > LIMITS.maxMessageBytes) return;

    const msg = parseClientMessage(message);
    if (!msg) return;

    const now = Date.now();
    if (!conn.bucket.take(COST[msg.t], now)) {
      if (conn.bucket.consecutiveDrops > RATE.closeAfterDrops) ws.close(1008, "rate limit");
      return;
    }
    try {
      dispatch(this, conn, msg);
    } catch (err) {
      console.error("handler failed", msg.t, err); // 1 つの異常で部屋全体を落とさない
    }

    // 位置は頻繁に変わるので、永続属性への書き込みは間引く
    if (msg.t === "p" && now - conn.attachedAt > 2000) {
      ws.serializeAttachment({ id: conn.id, x: conn.x, y: conn.y, c: conn.c } satisfies Session);
      conn.attachedAt = now;
    }
  }

  webSocketClose(ws: WebSocket) {
    this.drop(ws);
  }

  webSocketError(ws: WebSocket) {
    this.drop(ws);
  }

  // 定期的な後片付け。接続が残っている間だけ繰り返す
  async alarm() {
    try {
      this.prune(true);
    } catch (err) {
      console.error("alarm failed", err);
    }
    if (this.conns.size > 0) await this.ctx.storage.setAlarm(Date.now() + LIMITS.pruneIntervalMs);
  }

  // 観測用の数値（Worker の /stats がまとめて返す）
  private stats() {
    return {
      connections: this.conns.size,
      capacity: LIMITS.roomCapacity,
      stars: this.world.stars.size,
      links: this.world.links.size,
      sendMs: this.sendMs, // クライアントに指示している位置の送信間隔
    };
  }

  // --- RoomApi（handlers から使われる） ---

  now() {
    return Date.now();
  }

  broadcast(msg: ServerMessage, except?: Conn) {
    const out = JSON.stringify(msg);
    for (const c of this.conns.values()) if (c !== except) this.sendRaw(c, out);
  }

  // 視界に入っている人にだけ送る（波紋のような「その場所」の出来事用）
  broadcastNear(msg: ServerMessage, x: number, y: number, except?: Conn) {
    const out = JSON.stringify(msg);
    for (const c of this.conns.values()) {
      if (c !== except && inView(c.view, x, y, LIMITS.viewMargin)) this.sendRaw(c, out);
    }
  }

  markDirty(conn: Conn) {
    conn.dirty = true;
    this.quietTicks = 0;
    this.ensureTicker();
  }

  // 前回から変わった分だけを書く。変更が無ければ何もしない
  persist() {
    const { put, del } = this.world.drainChanges();
    const keys = Object.keys(put);
    for (let i = 0; i < keys.length; i += 128) {
      const chunk: Record<string, unknown> = {};
      for (const k of keys.slice(i, i + 128)) chunk[k] = put[k];
      this.ctx.waitUntil(this.ctx.storage.put(chunk));
    }
    for (let i = 0; i < del.length; i += 128) this.ctx.waitUntil(this.ctx.storage.delete(del.slice(i, i + 128)));
  }

  // 寿命切れを消して、全員に知らせる
  prune(force = false) {
    const r = this.world.prune(Date.now(), force);
    if (!r.stars.length && !r.links.length) return;
    for (const id of r.stars) this.broadcast({ t: "unstar", id });
    for (const id of r.links) this.broadcast({ t: "unlink", id });
    this.persist();
  }

  // --- 位置のまとめ配信 ---

  // 位置は「動いた人」を視界内の相手にだけ、一定間隔で 1 通へまとめて送る。
  // 一定間隔で、視界外も含めた粗い一覧も送る（ミニマップ用）。
  // 誰も動かない間はタイマーを止めて、Durable Object がハイバネートできるようにする。
  private tick() {
    try {
      this.tickOnce();
    } catch (err) {
      console.error("tick failed", err);
    }
  }

  private tickOnce() {
    this.tickCount++;
    const coarse = this.tickCount % LIMITS.coarseEveryTicks === 0;
    const all = [...this.conns.values()];
    const moved = all.filter((c) => c.dirty);

    // 人数が増えたらタイマーの間隔を広げる（1 回の処理が間に合わなくなるのを防ぐ）
    if (this.tickMs !== tickMsFor(all.length)) this.restartTicker();

    if (!moved.length && !coarse) {
      if (++this.quietTicks > LIMITS.idleTicksBeforeSleep) this.stopTicker();
      return;
    }

    const max = LIMITS.maxPeersPerMessage;
    if (coarse) {
      // 粗い一覧は全員に同じ内容なので 1 回だけ作る。受け取った側は自分の id を無視する。
      // 人数が多いときは、回ごとに窓をずらして全員が順に載るようにする
      const offset = ((this.tickCount / LIMITS.coarseEveryTicks) * max) % Math.max(1, all.length);
      const d: PresenceTuple[] = [];
      for (let k = 0; k < all.length && d.length < max; k++) {
        const o = all[(offset + k) % all.length];
        d.push([o.id, round4(o.x), round4(o.y), o.c]);
      }
      const out = JSON.stringify({ t: "ps", d } satisfies ServerMessage);
      for (const me of all) this.sendRaw(me, out);
    } else {
      // 動いた人をグリッドに入れて、各受信者は視界に重なるセルだけを見る
      const grid = new Map<number, { c: Conn; tuple: PresenceTuple }[]>();
      for (const o of moved) {
        const key = cellKey(o.x, o.y);
        const entry = { c: o, tuple: [o.id, round4(o.x), round4(o.y), o.c] as PresenceTuple };
        const bucket = grid.get(key);
        if (bucket) bucket.push(entry);
        else grid.set(key, [entry]);
      }
      const entries = [...grid.values()].flat();

      for (const me of all) {
        const d: PresenceTuple[] = [];
        for (const e of this.candidates(me, grid, entries)) {
          if (e.c === me || !inView(me.view, e.c.x, e.c.y, LIMITS.viewMargin)) continue;
          d.push(e.tuple);
          if (d.length >= max) break;
        }
        if (d.length) this.send(me, { t: "ps", d });
      }
    }
    for (const c of moved) c.dirty = false;
  }

  // 受信者の視界に重なるセルにいる人だけを返す。視界が広すぎるときは全員を調べるほうが速い
  private candidates<T extends { c: Conn }>(me: Conn, grid: Map<number, T[]>, all: T[]): T[] {
    const v = me.view;
    if (!v) return all;
    const mx = (v[2] - v[0]) * LIMITS.viewMargin;
    const my = (v[3] - v[1]) * LIMITS.viewMargin;
    const cx0 = Math.floor((v[0] - mx) / CELL), cx1 = Math.floor((v[2] + mx) / CELL);
    const cy0 = Math.floor((v[1] - my) / CELL), cy1 = Math.floor((v[3] + my) / CELL);
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > grid.size) return all;
    const out: T[] = [];
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const bucket = grid.get(cx * 1_000_000 + cy);
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  }

  private ensureTicker() {
    if (this.ticker) return;
    this.tickMs = tickMsFor(this.conns.size);
    this.ticker = setInterval(() => this.tick(), this.tickMs);
  }

  private restartTicker() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.ensureTicker();
  }

  // 人数に応じた送信間隔が変わったら、全員に知らせる
  private updateRate() {
    const next = sendMsFor(this.conns.size);
    if (next === this.sendMs) return;
    this.sendMs = next;
    this.broadcast({ t: "rate", sendMs: next });
  }

  private stopTicker() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.quietTicks = 0;
  }

  // --- 内部 ---

  private connOf(ws: WebSocket): Conn | null {
    const known = this.conns.get(ws);
    if (known) return known;
    const s = ws.deserializeAttachment() as Session | null;
    if (!s) return null;
    const conn = this.makeConn(ws, s);
    this.conns.set(ws, conn);
    return conn;
  }

  private makeConn(ws: WebSocket, s: Session): Conn {
    const now = Date.now();
    return { ws, id: s.id, x: s.x, y: s.y, c: s.c, view: null, dirty: false, bucket: new TokenBucket(RATE.capacity, RATE.refillPerSec, now), attachedAt: now };
  }

  private drop(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn) return;
    this.conns.delete(ws);
    this.broadcast({ t: "leave", id: conn.id });
    this.updateRate();
    if (this.conns.size === 0) this.stopTicker();
  }

  private send(conn: Conn, msg: ServerMessage) {
    this.sendRaw(conn, JSON.stringify(msg));
  }

  private sendRaw(conn: Conn, out: string) {
    try {
      conn.ws.send(out);
    } catch {}
  }

  private async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + LIMITS.pruneIntervalMs);
  }

  // 旧形式（星・線を1つの配列で保存）から、1件1キーの形式へ移す
  private async migrateLegacy() {
    const stars = await this.ctx.storage.get<StarData[]>("stars");
    const links = await this.ctx.storage.get<LinkData[]>("links");
    if (!stars && !links) return;
    const entries: Record<string, unknown> = {};
    for (const s of stars ?? []) entries[`s:${s.id}`] = s;
    for (const l of links ?? []) entries[`l:${l.id}`] = l;
    const keys = Object.keys(entries);
    for (let i = 0; i < keys.length; i += 128) {
      const chunk: Record<string, unknown> = {};
      for (const k of keys.slice(i, i + 128)) chunk[k] = entries[k];
      await this.ctx.storage.put(chunk);
    }
    await this.ctx.storage.delete(["stars", "links"]);
  }
}
