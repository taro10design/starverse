// 「空」＝1つの部屋。PartyServer の Server（Durable Object）として動き、接続・配信・永続化を受け持つ。
// 接続の受け付け・ハイバネートからの復帰・接続ごとの永続状態（connection.setState）は PartyServer に任せる。
// 世界のルールは World、メッセージごとの処理は handlers.ts、配信の選び方は presence.ts にあり、ここは入出力だけ。
//
// 接続の流れ: WebSocket を受け付ける → クライアントの最初の `hello {uid}` で持ち主 ID（uid のハッシュ）を
// 接続に固定する → `welcome` を返す。hello の前に来た他のメッセージは無視し（違反として数える）、
// helloTimeoutMs 以内に hello が来ない接続は alarm で切る。uid そのものは保存も配信もしない。
//
// 受信は 1 通ごとに inbound.ts の関門を通す（読む前のトークン → hello 前後の振り分け → 追加のトークン）。
//
// 人数は hello 済みの人（member）だけで数える（満員の判定・送信間隔）。hello 前の接続は別枠（maxPendingConnections）。
// 接続の一覧はメモリ上の集合（members / pending）に持ち、配信のたびに接続の state を読み直さない。
// 集合は起動・休止からの復帰のあとに 1 回だけ getConnections() から作り直す（ensureIndexed）。
//
// 同じ接続元（IP）の同時接続数は、メモリ上だけで数える（CF-Connecting-IP。保存も、接続の state への書き込みもしない）。
// 休止から起きると数は 0 からになる（休止前の接続は数えない）。休止するのは誰も動いていないときなので、
// 接続が押し寄せている間は数が保たれる。正確さより、IP を残さないことを優先する。

import { type Connection, type ConnectionContext, Server, type WSMessage } from "partyserver";
import type { ServerMessage } from "../../shared/protocol";
import { LIMITS, RATE, sendMsFor } from "./config";
import type { Env } from "./env";
import { dispatch, type BroadcastOptions, type Conn, type Member, type RoomApi } from "./handlers";
import { addressKey } from "./gateway";
import { ownerFromUid } from "./identity";
import {
  classify,
  extraCost,
  helloExpired,
  IdentifyBacklog,
  isFlooding,
  nextAlarmAt,
  PositionPace,
  rejectFor,
  screenRaw,
  ViolationCounter,
} from "./inbound";
import { coarseFrame, movedFrames, TickClock, tickMsFor, welcomeDots } from "./presence";
import { Cooldown, KeyedCounter, TokenBucket } from "./rate-limit";
import { inView } from "./spatial";
import { World } from "./world";

// ハイバネートを越えて残す接続ごとの最小情報（uid と IP は持たない）。connection.setState で接続に書く（約 2KB まで）。
// id は配信に使う短い id（ps・leave・welcome.id）。PartyServer の connection.id は長いので配信には使わない
interface Session {
  id: string;
  owner: string | null;
  since: number;
  x: number;
  y: number;
  c: number;
}

type Socket = Connection<Session>;
// メモリ上だけの接続の状態（トークンバケット・視界・違反の数など）。休止から起きたら Session から作り直す
type Live = Conn & { ws: Socket; pace: PositionPace };

const isMember = <T extends Conn>(c: T): c is T & Member => c.owner !== null;

// PartyServer は URL の `_pk` を connection.id に使う。クライアントに id を選ばせない（長すぎる id・重複を防ぐ）よう、
// クエリを落としてから渡す（connection.id は PartyServer が作る）。接続の永続状態に残る URL も短くなる
function withoutQuery(request: Request): Request {
  const url = new URL(request.url);
  if (!url.search) return request;
  url.search = "";
  return new Request(url.toString(), request);
}

export class Universe extends Server<Env> implements RoomApi {
  static options = { hibernate: true };

  readonly world = new World();
  private live = new WeakMap<Socket, Live>();
  // 片付け済みの接続。あとから届く close / error で、接続を作り直して leave を二重に送らないため
  private gone = new WeakSet<Socket>();
  // hello のハッシュ計算中の接続と、その間に届いたメッセージ（計算が済んだら順に処理する）
  private identifying = new Map<Live, IdentifyBacklog>();
  // 開いている接続（片付け済みを除く）。hello 前（pending）と hello 済み（members）のどちらか一方に入る
  private pending = new Set<Live>();
  private members = new Set<Live & Member>();
  private indexed = false; // 集合を getConnections() から作り直したか（インスタンスごとに 1 回）
  // 同じ接続元（IP）の同時接続数。ipOf は数えた接続とその IP（片付けのときに減らす）。どちらもメモリ上だけ
  private ips = new KeyedCounter(LIMITS.maxConnsPerIp);
  private ipOf = new WeakMap<Socket, string>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private clock = new TickClock();
  private tickMs: number = LIMITS.tickMs;
  private sendMs: number = LIMITS.sendMsMin; // クライアントに指示している位置の送信間隔

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // アプリ層の ping には、Durable Object を起こさずに pong を返す（死活監視用）
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // --- PartyServer のフック ---

  // 起動時・休止から起きたときに 1 回。PartyServer が blockConcurrencyWhile の中で呼ぶので、
  // 済むまで他のリクエスト・メッセージは届かない
  async onStart() {
    // 値は旧形式・壊れたものを含みうるので unknown として読み、World.load が検証する
    const stars = await this.ctx.storage.list<unknown>({ prefix: "s:" });
    const links = await this.ctx.storage.list<unknown>({ prefix: "l:" });
    this.world.load(stars.entries(), links.entries());
    this.persist(); // load で捨てた星・線（旧形式・持ち主が uid・端の無い線）を、読んだ鍵のまま保存先からも消す
    this.ensureIndexed();
    this.sendMs = sendMsFor(this.count());
  }

  // 満員の判定・hello 前の枠・同じ接続元の同時接続数・hello の締め切りは、PartyServer がソケットを受け入れる前に行う
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return super.fetch(request);
    // onStart（PartyServer が super.fetch の中で呼ぶ）より前なので、休止から起きた直後でもここで集合を作る
    this.ensureIndexed();
    // 満員なら Worker に次の空を探させる（hello 済みの人だけを数える）
    if (this.count() >= LIMITS.roomCapacity) {
      return new Response("room full", { status: 503, headers: { "x-room-full": "1" } });
    }
    // hello 前の接続が多すぎる。次の空に回す（1 つの空の別枠で、サイト全体の新しい接続を止めさせない）
    if (this.pending.size >= LIMITS.maxPendingConnections) {
      return new Response("too many pending connections", { status: 503, headers: { "x-room-full": "1" } });
    }
    const rawIp = request.headers.get("CF-Connecting-IP");
    const ip = rawIp ? addressKey(rawIp) : null;
    if (ip !== null && this.ips.count(ip) >= LIMITS.maxConnsPerIp) {
      return new Response("too many connections from this address", { status: 429 });
    }
    // hello が来なければ切るための alarm を、ソケットを受け入れる前に用意する
    // （受け入れてから失敗すると、締め切りの無い接続が残る）
    await this.ensureAlarm(Date.now() + LIMITS.helloTimeoutMs);
    return super.fetch(withoutQuery(request));
  }

  onConnect(ws: Socket, ctx: ConnectionContext) {
    const now = Date.now();
    const session: Session = { id: crypto.randomUUID().slice(0, 8), owner: null, since: now, x: 0.5, y: 0.5, c: 0 };
    ws.setState(session);
    const conn = this.makeLive(ws, session, now);
    this.live.set(ws, conn);
    this.track(conn);
    // fetch で確かめてから受け入れるまでの間に、同じ接続元の接続が重なって上限を超えたときは切る
    const rawIp = ctx.request.headers.get("CF-Connecting-IP");
    if (!rawIp) return;
    const ip = addressKey(rawIp);
    if (this.ips.tryAdd(ip)) this.ipOf.set(ws, ip);
    else this.close(conn, 1013, "too many connections from this address");
  }

  onMessage(ws: Socket, message: WSMessage) {
    const conn = this.runtime(ws);
    if (!conn) return;
    // JSON を読む前に 1 通ぶんのトークンを取る（大きすぎる・文字列でないものも数える）
    const verdict = screenRaw(message, conn.bucket, Date.now());
    if (verdict === "close") return this.close(conn, 1008, "rate limit");
    if (verdict === "limited") {
      // 読まずに捨てた星・線は、送り主の画面から取り消してもらう（t と id だけを軽く読む。rejectFor）
      if (isMember(conn) && typeof message === "string") {
        const reject = rejectFor(message);
        if (reject) this.send(conn, reject);
      }
      return;
    }
    if (verdict !== "accept" || typeof message !== "string") return;
    this.handleText(conn, message);
  }

  onClose(ws: Socket) {
    this.drop(ws);
  }

  onError(ws: Socket) {
    this.drop(ws);
  }

  // 観測用の数値（Worker の /stats がまとめて返す）。Worker の外からは届かない
  onRequest(request: Request): Response {
    if (new URL(request.url).pathname !== "/stats") return new Response("not found", { status: 404 });
    return Response.json({
      connections: this.count(), // hello 済みの人
      pending: this.pending.size, // hello 前の接続
      capacity: LIMITS.roomCapacity,
      stars: this.world.stars.size,
      links: this.world.links.size,
      sendMs: this.sendMs, // クライアントに指示している位置の送信間隔
    });
  }

  // 寿命切れの後片付けと、hello が来ない接続の切断。
  // 次の alarm は「hello の締め切り」と「次に寿命が切れる星・線の時刻」の早い方（nextAlarmAt）。
  // どちらも無ければ張らない（休止中の Durable Object を起こして全レコードを読み直さない）
  async onAlarm() {
    const now = Date.now();
    try {
      this.prune(true);
      for (const c of [...this.pending]) {
        if (!this.identifying.has(c) && helloExpired(c.since, now)) this.close(c, 1008, "hello timeout");
      }
    } catch (err) {
      console.error("alarm failed", err);
    }
    const at = nextAlarmAt(
      now,
      [...this.pending].map((c) => c.since),
      this.world.nextExpiryAt(),
    );
    if (at !== null) await this.ctx.storage.setAlarm(at);
  }

  // --- RoomApi（handlers から使われる） ---

  now() {
    return Date.now();
  }

  send(conn: Conn, msg: ServerMessage) {
    this.sendRaw(conn.ws, JSON.stringify(msg));
  }

  // hello を済ませた全員に送る（welcome 前の接続には何も送らない）
  broadcastAll(msg: ServerMessage, except?: Conn) {
    const out = JSON.stringify(msg);
    for (const c of this.members) if (c !== except) this.sendRaw(c.ws, out);
  }

  // 視界に入っている人にだけ送る（波紋のような「その場所」の出来事用）
  broadcastNear(msg: ServerMessage, x: number, y: number, opts: BroadcastOptions = {}) {
    const out = JSON.stringify(msg);
    for (const c of this.members) {
      if (c === opts.except || (opts.requireView && !c.view)) continue;
      if (inView(c.view, x, y, LIMITS.viewMargin)) this.sendRaw(c.ws, out);
    }
  }

  markDirty(conn: Conn) {
    conn.dirty = true;
    this.clock.wake();
    this.ensureTicker();
  }

  // 前回から変わった分だけを書く。変更が無ければ何もしない。
  // 星・線を書いたときは、寿命切れを片付ける alarm が alarmMinMs 以内に鳴るようにする
  // （alarm は早める方向にだけ動かし、鳴ったときに正確な時刻へ張り直す。onAlarm）
  persist() {
    const { put, del } = this.world.drainChanges();
    const keys = Object.keys(put);
    if (keys.length) this.ctx.waitUntil(this.ensureAlarm(Date.now() + LIMITS.alarmMinMs));
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
    for (const id of r.stars) this.broadcastAll({ t: "unstar", id });
    for (const id of r.links) this.broadcastAll({ t: "unlink", id });
    this.persist();
  }

  // --- 受信 ---

  // 関門を通ったメッセージを処理する。hello の処理中に貯めた分も、ここから処理する（トークンは取り済み）
  private handleText(conn: Live, message: string) {
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
    // 指示した間隔を守らずに位置を送り続ける接続は切る（受け取った分は課金されるので、切るほかに減らす方法がない）
    if (msg.t === "p" && conn.pace.record(now, this.sendMs)) return this.close(conn, 1008, "position flood");
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

    // 位置は頻繁に変わるので、接続の state への書き込みは間引く
    if (msg.t === "p" && now - conn.attachedAt > 2000) this.attach(conn, now);
  }

  // --- 持ち主の確定（hello） ---

  // ハッシュの計算は非同期なので、その間に届いたメッセージは identifying に貯めておく
  private identify(conn: Live, uid: string) {
    const backlog = new IdentifyBacklog(LIMITS.maxBacklogWhileIdentifying);
    this.identifying.set(conn, backlog);
    this.ctx.waitUntil(this.admit(conn, uid, backlog));
  }

  private async admit(conn: Live, uid: string, backlog: IdentifyBacklog) {
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
    if (!this.isLive(conn)) return; // 計算の間に切れた

    // 寿命切れの片付けは members に入れる前に行う（welcome 前の接続に unstar を送らない。消えた星は welcome に載らない）
    this.prune();
    conn.owner = owner;
    this.track(conn);
    this.updateRate(conn); // 既にいる人へ（新しい人には welcome で伝える）
    const now = Date.now();
    this.attach(conn, now);

    const dots = welcomeDots(this.members, conn, LIMITS.maxWelcomePeers);
    const { stars, links } = this.world.snapshot(); // 保存専用の born / v は配らない
    this.send(conn, { t: "welcome", id: conn.id, me: owner, sendMs: this.sendMs, dots, stars, links });
    this.markDirty(conn); // 他の人に新しい光を知らせる

    // 貯めきれなかった星・線は断ったことを伝え（welcome のあとなので、クライアントは取り消せる）、残りを順に処理する
    for (const r of backlog.rejects) this.send(conn, r);
    for (const raw of backlog.items) {
      if (!this.isLive(conn)) return; // 処理の途中で切った
      this.handleText(conn, raw);
    }
  }

  // --- 位置のまとめ配信（何を誰に送るかは presence.ts） ---

  private tick() {
    try {
      this.tickOnce();
    } catch (err) {
      console.error("tick failed", err);
    }
  }

  private tickOnce() {
    const all = [...this.members];
    const moved = all.filter((c) => c.dirty);

    // 人数が増えたらタイマーの間隔を広げる（1 回の処理が間に合わなくなるのを防ぐ）
    if (this.tickMs !== tickMsFor(this.count())) this.restartTicker();

    const decision = this.clock.next(moved.length > 0);
    if (decision.do === "sleep") return this.stopTicker();
    if (decision.do === "idle") return;

    const max = LIMITS.maxPeersPerMessage;
    if (decision.coarse !== null) {
      const out = JSON.stringify({ t: "ps", d: coarseFrame(all, decision.coarse, max) } satisfies ServerMessage);
      for (const me of all) this.sendRaw(me.ws, out);
    }
    // 粗い一覧の回でも、動いた人の更新は落とさない（粗い一覧は窓をずらすので、載らない人がいる）
    if (moved.length) for (const [me, d] of movedFrames(all, moved, max)) this.send(me, { t: "ps", d });
    for (const c of moved) c.dirty = false;
  }

  private ensureTicker() {
    if (this.ticker) return;
    this.tickMs = tickMsFor(this.count());
    this.ticker = setInterval(() => this.tick(), this.tickMs);
  }

  private restartTicker() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.ensureTicker();
  }

  private stopTicker() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.clock.wake();
  }

  // 人数に応じた送信間隔が変わったら、全員に知らせる（except には welcome で伝える）
  private updateRate(except?: Conn) {
    const next = sendMsFor(this.count());
    if (next === this.sendMs) return;
    this.sendMs = next;
    this.broadcastAll({ t: "rate", sendMs: next }, except);
  }

  // --- 接続 ---

  // hello 済みの人数（満員の判定と送信間隔に使う。hello 前の接続は数えない）
  private count(): number {
    return this.members.size;
  }

  // 起動・休止からの復帰のあとに 1 回だけ、開いている接続から集合を作り直す
  private ensureIndexed() {
    if (this.indexed) return;
    this.indexed = true;
    for (const ws of this.getConnections<Session>()) this.runtime(ws);
  }

  // 接続を、持ち主の有無に応じて pending / members のどちらかに入れる
  private track(conn: Live) {
    if (isMember(conn)) {
      this.pending.delete(conn);
      this.members.add(conn);
    } else {
      this.pending.add(conn);
    }
  }

  // メモリ上の状態。休止から起きた直後は、接続の state から作り直して集合に入れる。片付け済みなら null
  private runtime(ws: Socket): Live | null {
    if (this.gone.has(ws)) return null;
    const known = this.live.get(ws);
    if (known) return known;
    const s = ws.state;
    if (!s) return null; // こちらから切った接続（close で state を消している）
    const conn = this.makeLive(ws, s, Date.now());
    this.live.set(ws, conn);
    this.track(conn);
    return conn;
  }

  private isLive(conn: Live): boolean {
    return this.live.get(conn.ws) === conn;
  }

  private makeLive(ws: Socket, s: Readonly<Session>, now: number): Live {
    return {
      ws,
      id: s.id,
      owner: s.owner,
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
      pace: new PositionPace(),
    };
  }

  // ハイバネートを越えて残す分を接続の state に書く
  private attach(conn: Live, now: number) {
    const { id, owner, since, x, y, c } = conn;
    conn.ws.setState({ id, owner, since, x, y, c });
    conn.attachedAt = now;
  }

  // 接続を片付ける。休止から起きた直後の close でも、state から接続を取り出して leave を配信する
  private drop(ws: Socket) {
    const conn = this.runtime(ws);
    if (!conn) return;
    this.gone.add(ws);
    this.live.delete(ws);
    this.identifying.delete(conn);
    this.pending.delete(conn);
    if (isMember(conn)) this.members.delete(conn);
    const ip = this.ipOf.get(ws);
    if (ip !== undefined) {
      this.ips.remove(ip);
      this.ipOf.delete(ws);
    }
    if (isMember(conn)) this.broadcastAll({ t: "leave", id: conn.id }); // welcome 前の接続は誰にも見えていない
    this.updateRate();
    if (this.count() === 0) this.stopTicker();
  }

  // こちらから切る。close イベントを待たずに片付ける。
  // state を先に消すので、休止を挟んで close が届いても接続を作り直さない（leave を二重に送らない）
  private close(conn: Live, code: number, reason: string) {
    try {
      conn.ws.setState(null);
      conn.ws.close(code, reason);
    } catch (err) {
      console.warn("close failed", reason, err); // 既に閉じている。片付けだけ行う
    }
    this.drop(conn.ws);
  }

  // 閉じかけの接続には送らない（close イベントで片付く）
  private sendRaw(ws: WebSocket, out: string) {
    if (ws.readyState !== WebSocket.READY_STATE_OPEN) return;
    try {
      ws.send(out);
    } catch (err) {
      console.warn("send failed", err); // 判定と送信の間に閉じた。close イベントで片付く
    }
  }

  private async ensureAlarm(at: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }
}
