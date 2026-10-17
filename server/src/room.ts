// 「空」＝1つの部屋。Durable Object として動き、接続・配信・永続化を受け持つ。
// 世界のルールは World、メッセージごとの処理は handlers.ts にあり、ここは入出力だけ。
//
// 接続の流れ: WebSocket を受け付ける → クライアントの最初の `hello {uid}` で持ち主 ID（uid のハッシュ）を
// 接続に固定する → `welcome` を返す。hello の前に来た他のメッセージは無視し（違反として数える）、
// helloTimeoutMs 以内に hello が来ない接続は alarm で切る。uid そのものは保存も配信もしない。
//
// 受信は 1 通ごとに inbound.ts の関門を通す（読む前のトークン → hello 前後の振り分け → 追加のトークン）。
// 接続元は CF-Connecting-IP の HMAC（秘密は storage の `ipkey`）で数え、生の IP は持たない。

import type { PeerDot, PresenceTuple, ServerMessage } from "../../shared/protocol";
import { LIMITS, RATE, sendMsFor } from "./config";
import type { Env } from "./env";
import { dispatch, type BroadcastOptions, type Conn, type Member, type RoomApi } from "./handlers";
import { importIpSecret, ipKey, isLoopback, newIpSecret, ownerFromUid, storedIpSecret } from "./identity";
import { classify, extraCost, IdentifyBacklog, isFlooding, screenRaw, ViolationCounter } from "./inbound";
import { Cooldown, TokenBucket, WindowCounter } from "./rate-limit";
import { inView } from "./spatial";
import { World } from "./world";

const IP_SECRET_KEY = "ipkey"; // storage のキー。星・線（s: / l:）とは重ならない

// ハイバネートを越えて残す接続ごとの最小情報（uid は持たない）
interface Session {
  id: string;
  owner: string | null;
  ip: string | null;
  since: number;
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

const isMember = (c: Conn): c is Member => c.owner !== null;

export class Universe implements RoomApi, DurableObject {
  readonly world = new World();
  private conns = new Map<WebSocket, Conn>();
  // hello のハッシュ計算中の接続と、その間に届いたメッセージ（計算が済んだら順に処理する）
  private identifying = new Map<Conn, IdentifyBacklog>();
  // 接続元ごとの、直近 60 秒の接続の回数（メモリ上の近似。ハイバネートで失われてよい）
  private connectRate = new WindowCounter(60_000, LIMITS.maxConnectsPerIpPerMinute, LIMITS.maxTrackedIps);
  private ipSecret: CryptoKey | null = null; // 接続元の鍵（HMAC）の秘密。起動時に storage から読む
  // 片付け済みの接続。あとから届く close で、永続属性から接続を作り直して leave を二重に送らないため
  private gone = new WeakSet<WebSocket>();
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
      this.ipSecret = await importIpSecret(await this.loadIpSecret());
      // 値は旧形式・壊れたものを含みうるので unknown として読み、World.load が検証する
      const stars = await this.ctx.storage.list<unknown>({ prefix: "s:" });
      const links = await this.ctx.storage.list<unknown>({ prefix: "l:" });
      this.world.load(stars.entries(), links.entries());
      this.persist(); // load で捨てた星・線（旧形式・持ち主が uid・端の無い線）を、読んだ鍵のまま保存先からも消す
      // ハイバネートから起きた場合、生きている接続を取り込み直す
      for (const ws of this.ctx.getWebSockets()) this.connOf(ws);
      this.sendMs = sendMsFor(this.conns.size);
    });
  }

  // --- 入口 ---

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/stats") return Response.json(this.stats());

    // 接続元は Worker が転送する CF-Connecting-IP。生の IP は持たず HMAC にする（IPv6 は /64 単位）。
    // ローカル開発（wrangler dev）の接続元は制限しない（負荷試験で同じ接続元から多数つなぐため）
    const rawIp = request.headers.get("CF-Connecting-IP");
    let ip: string | null = null;
    if (rawIp && !isLoopback(rawIp)) {
      if (!this.ipSecret) return new Response("not ready", { status: 503 }); // 起動処理が失敗している
      ip = await ipKey(rawIp, this.ipSecret);
    }

    // 満員なら Worker に次の空を探させる
    if (this.conns.size >= LIMITS.roomCapacity) {
      return new Response("room full", { status: 503, headers: { "x-room-full": "1" } });
    }
    // 同じ接続元からの多重接続・つなぎ直しの連打は断る。次の空には回さない（空を渡り歩いて上限を増やせないように）
    if (ip !== null && this.countIp(ip) >= LIMITS.maxConnsPerIp) {
      return new Response("too many connections", { status: 503 });
    }
    const now = Date.now();
    if (ip !== null && !this.connectRate.allow(ip, now)) {
      return new Response("too many connection attempts", { status: 503 });
    }

    // hello が来なければ切るための alarm を、ソケットを受け入れる前に用意する
    // （受け入れてから失敗すると、締め切りの無い接続が残る）
    await this.ensureAlarm(now + LIMITS.helloTimeoutMs);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const session: Session = { id: crypto.randomUUID().slice(0, 8), owner: null, ip, since: now, x: 0.5, y: 0.5, c: 0 };
    server.serializeAttachment(session);
    this.conns.set(server, this.makeConn(server, session));

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const conn = this.connOf(ws);
    if (!conn) return;
    // JSON を読む前に 1 通ぶんのトークンを取る（大きすぎる・文字列でないものも数える）
    const verdict = screenRaw(message, conn.bucket, Date.now());
    if (verdict === "close") this.close(conn, 1008, "rate limit");
    if (verdict !== "accept" || typeof message !== "string") return;
    this.handleText(conn, message);
  }

  // 関門を通ったメッセージを処理する。hello の処理中に貯めた分も、ここから処理する（トークンは取り済み）
  private handleText(conn: Conn, message: string) {
    // hello の処理中に届いたものは、持ち主が決まってから処理する
    const backlog = this.identifying.get(conn);
    if (backlog) {
      backlog.push(message);
      return;
    }

    const step = classify(isMember(conn), message);
    if (step.do === "identify") return this.identify(conn, step.uid);
    if (step.do === "invalid-uid") return this.close(conn, 1008, "invalid uid"); // 切り詰めて受け入れることはしない
    if (step.do === "violation") {
      if (conn.violations.record()) this.close(conn, 1008, "protocol violation");
      return;
    }
    if (step.do === "ignore" || !isMember(conn)) return;

    const msg = step.msg;
    const now = Date.now();
    const extra = extraCost(msg.t);
    if (extra > 0 && !conn.bucket.take(extra, now)) {
      // 置いたつもりの星・線を、送り主の画面から取り消してもらう
      if (msg.t === "star" || msg.t === "link") this.send(conn, { t: "reject", kind: msg.t, id: msg.id });
      if (isFlooding(conn.bucket, now)) this.close(conn, 1008, "rate limit");
      return;
    }
    try {
      dispatch(this, conn, msg);
    } catch (err) {
      console.error("handler failed", msg.t, err); // 1 つの異常で部屋全体を落とさない
    }

    // 位置は頻繁に変わるので、永続属性への書き込みは間引く
    if (msg.t === "p" && now - conn.attachedAt > 2000) this.attach(conn, now);
  }

  webSocketClose(ws: WebSocket) {
    this.drop(ws);
  }

  webSocketError(ws: WebSocket) {
    this.drop(ws);
  }

  // 定期的な後片付けと、hello が来ない接続の切断。接続が残っている間だけ繰り返す
  async alarm() {
    const now = Date.now();
    try {
      this.prune(true);
      for (const c of [...this.conns.values()]) {
        if (!isMember(c) && !this.identifying.has(c) && now - c.since >= LIMITS.helloTimeoutMs) {
          this.close(c, 1008, "hello timeout");
        }
      }
    } catch (err) {
      console.error("alarm failed", err);
    }
    if (this.conns.size > 0) await this.ctx.storage.setAlarm(this.nextAlarm(now));
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

  send(conn: Conn, msg: ServerMessage) {
    this.sendRaw(conn, JSON.stringify(msg));
  }

  // hello を済ませた全員に送る（welcome 前の接続には何も送らない）
  broadcast(msg: ServerMessage, except?: Conn) {
    const out = JSON.stringify(msg);
    for (const c of this.members()) if (c !== except) this.sendRaw(c, out);
  }

  // 視界に入っている人にだけ送る（波紋のような「その場所」の出来事用）
  broadcastNear(msg: ServerMessage, x: number, y: number, opts: BroadcastOptions = {}) {
    const out = JSON.stringify(msg);
    for (const c of this.members()) {
      if (c === opts.except || (opts.requireView && !c.view)) continue;
      if (inView(c.view, x, y, LIMITS.viewMargin)) this.sendRaw(c, out);
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

  // --- 持ち主の確定（hello） ---

  // ハッシュの計算は非同期なので、その間に届いたメッセージは identifying に貯めておく
  private identify(conn: Conn, uid: string) {
    const backlog = new IdentifyBacklog(LIMITS.maxBacklogWhileIdentifying);
    this.identifying.set(conn, backlog);
    this.ctx.waitUntil(this.admit(conn, uid, backlog));
  }

  private async admit(conn: Conn, uid: string, backlog: IdentifyBacklog) {
    let owner: string;
    try {
      owner = await ownerFromUid(uid);
    } catch (err) {
      console.error("identify failed", err);
      this.identifying.delete(conn);
      this.close(conn, 1011, "identify failed");
      return;
    }
    this.identifying.delete(conn);
    if (this.conns.get(conn.ws) !== conn) return; // 計算の間に切れた

    this.updateRate(); // 既にいる人へ（新しい人には welcome で伝える）
    conn.owner = owner;
    const now = Date.now();
    this.attach(conn, now);

    this.prune();
    const dots: PeerDot[] = [];
    for (const o of this.members()) {
      if (o === conn) continue;
      dots.push({ id: o.id, x: round4(o.x), y: round4(o.y), c: o.c });
      if (dots.length >= LIMITS.maxWelcomePeers) break;
    }
    const { stars, links } = this.world.snapshot(); // 保存専用の born / origin / v は配らない
    this.send(conn, { t: "welcome", id: conn.id, me: owner, sendMs: this.sendMs, dots, stars, links });
    this.markDirty(conn); // 他の人に新しい光を知らせる

    // 貯めきれなかった星・線は断ったことを伝え（welcome のあとなので、クライアントは取り消せる）、残りを順に処理する
    for (const r of backlog.rejects) this.send(conn, r);
    for (const raw of backlog.items) {
      if (this.conns.get(conn.ws) !== conn) return; // 処理の途中で切った
      this.handleText(conn, raw);
    }
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
    const all = [...this.members()];
    const moved = all.filter((c) => c.dirty);

    // 人数が増えたらタイマーの間隔を広げる（1 回の処理が間に合わなくなるのを防ぐ）
    if (this.tickMs !== tickMsFor(this.conns.size)) this.restartTicker();

    if (!moved.length && !coarse) {
      if (++this.quietTicks > LIMITS.idleTicksBeforeSleep) this.stopTicker();
      return;
    }

    if (coarse) this.sendCoarse(all);
    // 粗い一覧の回でも、動いた人の更新は落とさない（粗い一覧は窓をずらすので、載らない人がいる）
    if (moved.length) this.sendMoved(all, moved);
    for (const c of moved) c.dirty = false;
  }

  // 粗い一覧は全員に同じ内容なので 1 回だけ作る。受け取った側は自分の id を無視する。
  // 人数が多いときは、回ごとに窓をずらして全員が順に載るようにする
  private sendCoarse(all: Member[]) {
    const max = LIMITS.maxPeersPerMessage;
    const offset = ((this.tickCount / LIMITS.coarseEveryTicks) * max) % Math.max(1, all.length);
    const d: PresenceTuple[] = [];
    for (let k = 0; k < all.length && d.length < max; k++) {
      const o = all[(offset + k) % all.length];
      d.push([o.id, round4(o.x), round4(o.y), o.c]);
    }
    const out = JSON.stringify({ t: "ps", d } satisfies ServerMessage);
    for (const me of all) this.sendRaw(me, out);
  }

  // 動いた人をグリッドに入れて、各受信者は視界に重なるセルだけを見る
  private sendMoved(all: Member[], moved: Member[]) {
    const max = LIMITS.maxPeersPerMessage;
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

  // 受信者の視界に重なるセルにいる人だけを返す。視界が広すぎるときは全員を調べるほうが速い
  private candidates<T extends { c: Conn }>(me: Conn, grid: Map<number, T[]>, all: T[]): T[] {
    const v = me.view;
    if (!v) return all;
    const mx = (v[2] - v[0]) * LIMITS.viewMargin;
    const my = (v[3] - v[1]) * LIMITS.viewMargin;
    const cx0 = Math.floor((v[0] - mx) / CELL),
      cx1 = Math.floor((v[2] + mx) / CELL);
    const cy0 = Math.floor((v[1] - my) / CELL),
      cy1 = Math.floor((v[3] + my) / CELL);
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

  private *members(): Generator<Member> {
    for (const c of this.conns.values()) if (isMember(c)) yield c;
  }

  private countIp(ip: string): number {
    let n = 0;
    for (const c of this.conns.values()) if (c.ip === ip) n++;
    return n;
  }

  private connOf(ws: WebSocket): Conn | null {
    const known = this.conns.get(ws);
    if (known) return known;
    if (this.gone.has(ws)) return null;
    const s = ws.deserializeAttachment() as Session | null;
    if (!s) return null;
    const conn = this.makeConn(ws, s);
    this.conns.set(ws, conn);
    return conn;
  }

  private makeConn(ws: WebSocket, s: Session): Conn {
    const now = Date.now();
    return {
      ws,
      id: s.id,
      owner: s.owner,
      ip: s.ip,
      since: s.since,
      x: s.x,
      y: s.y,
      c: s.c,
      view: null,
      dirty: false,
      bucket: new TokenBucket(RATE.capacity, RATE.refillPerSec, now, LIMITS.rateWindowMs),
      violations: new ViolationCounter(LIMITS.maxProtocolViolations),
      admired: new Cooldown(LIMITS.admireCooldownMs, LIMITS.admireCooldownEntries),
      attachedAt: now,
    };
  }

  private attach(conn: Conn, now: number) {
    const { id, owner, ip, since, x, y, c } = conn;
    conn.ws.serializeAttachment({ id, owner, ip, since, x, y, c } satisfies Session);
    conn.attachedAt = now;
  }

  // 休止から起きた直後の close でも、永続属性から接続を取り出して leave を配信する
  private drop(ws: WebSocket) {
    const conn = this.connOf(ws);
    if (!conn) return;
    this.conns.delete(ws);
    this.gone.add(ws);
    this.identifying.delete(conn);
    if (isMember(conn)) this.broadcast({ t: "leave", id: conn.id }); // welcome 前の接続は誰にも見えていない
    this.updateRate();
    if (this.conns.size === 0) this.stopTicker();
  }

  // こちらから切る。close イベントを待たずに片付ける
  private close(conn: Conn, code: number, reason: string) {
    try {
      conn.ws.close(code, reason);
    } catch (err) {
      console.warn("close failed", reason, err); // 既に閉じている。片付けだけ行う
    }
    this.drop(conn.ws);
  }

  // 閉じかけの接続には送らない（close イベントで片付く）
  private sendRaw(conn: Conn, out: string) {
    if (conn.ws.readyState !== WebSocket.READY_STATE_OPEN) return;
    try {
      conn.ws.send(out);
    } catch (err) {
      console.warn("send failed", err); // 判定と送信の間に閉じた。close イベントで片付く
    }
  }

  // 次の alarm の時刻。hello を待っている接続があれば、その締め切りに合わせて早める
  private nextAlarm(now: number): number {
    let at = now + LIMITS.pruneIntervalMs;
    for (const c of this.conns.values()) {
      if (!isMember(c)) at = Math.min(at, Math.max(now + 1000, c.since + LIMITS.helloTimeoutMs));
    }
    return at;
  }

  // IP の鍵の秘密。無ければ（初回起動・壊れた値）作って保存する。環境変数やシークレットは使わない
  private async loadIpSecret(): Promise<Uint8Array> {
    const stored = storedIpSecret(await this.ctx.storage.get(IP_SECRET_KEY));
    if (stored) return stored;
    const fresh = newIpSecret();
    await this.ctx.storage.put(IP_SECRET_KEY, fresh);
    return fresh;
  }

  private async ensureAlarm(at: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }
}
