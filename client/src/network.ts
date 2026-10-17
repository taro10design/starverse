import ReconnectingWebSocket from "partysocket/ws";
import { WS_HOST } from "./constants";
import { SOLO } from "./env";
import type { ClientMessage, View } from "../../shared/protocol";
import { handleServerMessage, parseServerMessage } from "./message-handlers";
import type { App } from "./app";
import { OpPacer } from "./op-pacer";

// ---------------------------------------------------------------------------
// Network — WebSocket 通信
//
// 位置を送る間隔はサーバーが指示する（welcome / rate）。人が増えるほど間隔が広がり、
// 1 つの空が受け取るメッセージ量を一定の予算に収める。受信側は補間して滑らかに見せる。
//
// 接続は PartySocket（partysocket/ws の ReconnectingWebSocket）に任せる。再接続の待ち・バックオフ・
// CONNECTING のタイムアウト・古い接続のイベントの切り離し・二重接続の防止は部品の仕事。
// ここに残すのはアプリ固有のこと: hello の送信、welcome の待ち、死活監視の ping、隠れたタブの切断、
// 1008（乱用対策）で切られたときの長い待ち、サーバーが指示した送信間隔、一括操作の送信の小分け（OpPacer）。
//
// welcome が来ないときと 1008 のあとは、PartySocket の再接続を止めて（close）、こちらで待ってから reconnect() する。
// reconnect() は PartySocket の待ち（retryCount）を初期値に戻すので、そのまま呼ぶと待ちなしで繰り返してしまう。
// 待ちの終わる時刻（retryAt）を覚えておき、隠れたタブで切断しても、表示に戻ったときは残りだけ待つ。
// ---------------------------------------------------------------------------
const DEFAULT_SEND_MS = 100; // 位置を送る間隔の下限（サーバーの指示がこれより短くても守る）
const PING_MS = 10_000; // 死活監視の ping（サーバーが Durable Object を起こさずに pong を返す）
const DEAD_AFTER_MS = 25_000; // 何も受け取れない状態がこれだけ続いたら（ping 2 回に答えが無い）、つなぎ直す
const WATCHDOG_MS = 5000; // 死活監視の確認間隔
const WELCOME_TIMEOUT_MS = 10_000; // 開いてから welcome までの上限
const HIDDEN_CLOSE_MS = 30_000; // タブが隠れて、これだけ経ったら切断して空きを返す
const POLICY_RETRY_MS = 30_000; // サーバーが 1008（ポリシー違反・乱用対策）で切ったときの待ち時間
// welcome が来ないまま締め切ったときの待ち: 1.5 秒 × 1.6^n（15 秒で頭打ち）× 1〜1.5 のばらつき。
// PartySocket の待ちと同じ伸び方。welcome を受け取ったら初期値に戻す
const WELCOME_RETRY_MIN_MS = 1500;
const WELCOME_RETRY_MAX_MS = 15_000;
const WELCOME_RETRY_GROW = 1.6;
const CLOSE_POLICY = 1008;
const OPEN = 1; // WebSocket.OPEN

// PartySocket の設定。待ち時間は 1.5 秒 × 1.6^n（15 秒で頭打ち）。一斉に再接続して集中しないよう、
// 最小の待ちを端末ごとに 1〜1.5 倍ずらす（PartySocket 自体の待ちにはばらつきが無い）。
// 待ちが初期値に戻るのは、接続が minUptime（5 秒）続いたとき（開くだけで切られる状態で詰め寄らない）。
// minUptime は welcome の締め切り（10 秒）より短いが、それで足りる: 締め切りで閉じた接続は PartySocket の
// 待ちを使わず、こちらの伸びる待ち（WELCOME_RETRY_*。welcome でだけ初期値に戻る）で待つ。
// 残るのは「開いて 5〜10 秒で、welcome の前にサーバーから切られる」場合だけで、そのときも
// 1.5 秒以上の待ち + 5 秒以上の接続で、1 回あたり 6.5 秒以上空くので、詰め寄りにはならない
// 送信バッファは使わない（maxEnqueuedMessages: 0）。切断中の star などを再接続後に送ると、
// welcome で状態を置き換えたあとに古い操作が届き、持ち主の整合が崩れるため
export function socketOptions() {
  return {
    minReconnectionDelay: 1500 * (1 + Math.random() * 0.5),
    maxReconnectionDelay: 15_000,
    reconnectionDelayGrowFactor: 1.6,
    minUptime: 5000,
    connectionTimeout: 10_000, // CONNECTING のまま固まるのを防ぐ
    maxRetries: Infinity,
    maxEnqueuedMessages: 0,
    // 1008 では PartySocket の再接続を止め、こちらで長く待ってから reconnect() する
    shouldReconnectOnClose: (e: { code: number }) => e.code !== CLOSE_POLICY,
  };
}

// Network が使う App の部分（テストでは最小の偽物を渡す）
export type NetworkHost = Pick<App, "universe" | "player" | "camera">;

export class Network {
  private ws: ReconnectingWebSocket | null = null;
  private welcomed = false; // いまの接続で welcome を受け取ったか
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null;
  // こちらで待ってから reconnect() する（welcome の締め切り・1008）。retryAt は待ちの終わる時刻（0 なら待っていない）
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAt = 0;
  private welcomeRetries = 0; // welcome が来ないまま締め切った回数（待ちを伸ばす）
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private paused = false; // 隠れていたために切った（表示に戻ったらつなぐ）
  private sendMs = DEFAULT_SEND_MS;
  private lastSend = 0;
  private lastSent: { x: number; y: number; v: View } | null = null;
  private lastRx = 0;
  // 星・線の操作は小分けにして送る（サーバーのレート制限で unstar などが黙って捨てられないように）
  private readonly pacer = new OpPacer((data) => {
    if (this.ws?.readyState === OPEN) this.ws.send(data);
  });

  // socketImpl: WebSocket の実装（テストで偽物を差し込む。省略時はブラウザの WebSocket）
  constructor(
    private app: NetworkHost,
    private socketImpl?: typeof WebSocket,
  ) {}

  connect() {
    if (SOLO || location.protocol === "file:" || this.ws) return;
    document.addEventListener("visibilitychange", () => this.onVisibility());
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new ReconnectingWebSocket(`${scheme}://${WS_HOST}/ws`, undefined, {
      ...socketOptions(),
      WebSocket: this.socketImpl,
    });
    this.ws = ws;
    // addEventListener ではなく onX に付ける。ブラウザでは PartySocket が自分で作る close（reconnect() や
    // タイムアウト）を addEventListener 向けに複製するとき code が壊れるため（onX には元のイベントが届く）
    ws.onopen = () => {
      this.lastRx = Date.now();
      this.send({ t: "hello", uid: this.app.universe.uid }); // 最初に 1 回だけ、持ち主の鍵を名乗る
      this.sendPosition(); // 接続直後は、操作していなくても 1 回送る
      this.startWatchdog();
      // つながっても welcome が来ないまま固まったら、閉じて、伸びる待ちのあとでつなぎ直す
      this.clearWelcomeTimer();
      this.welcomeTimer = setTimeout(() => {
        this.welcomeTimer = null;
        if (this.welcomed) return;
        ws.close(); // PartySocket の再接続も止まる（close の通知は同期で届く）
        this.retryAfter(this.nextWelcomeRetryMs());
      }, WELCOME_TIMEOUT_MS);
    };
    ws.onmessage = (e) => {
      this.lastRx = Date.now();
      if (e.data === "pong") return;
      const m = parseServerMessage(e.data);
      if (m) handleServerMessage(m, this.app.universe, this);
    };
    ws.onclose = (e) => {
      this.onDisconnected();
      // 乱用対策で切られたなら、しばらく（ばらつきつきで）待つ。PartySocket の再接続は止まっている
      if (e.code !== CLOSE_POLICY) return;
      this.retryAfter(POLICY_RETRY_MS * (1 + Math.random() * 0.5));
    };
  }

  // ms 待ってから reconnect() する。終わる時刻を覚えておく（隠れたタブから戻ったとき、残りだけ待つため）
  private retryAfter(ms: number) {
    this.clearRetryTimer();
    this.retryAt = Date.now() + ms;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryAt = 0;
      this.ws?.reconnect();
    }, ms);
  }

  private clearRetryTimer() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private nextWelcomeRetryMs(): number {
    const base = WELCOME_RETRY_MIN_MS * WELCOME_RETRY_GROW ** this.welcomeRetries;
    this.welcomeRetries++;
    return Math.min(WELCOME_RETRY_MAX_MS, base * (1 + Math.random() * 0.5));
  }

  // サーバーへ送る操作ができる状態か（つながっていて、welcome で持ち主 ID が分かっている）
  get ready(): boolean {
    return this.welcomed && this.ws !== null && this.ws.readyState === OPEN;
  }

  private onDisconnected() {
    this.welcomed = false;
    this.stopWatchdog();
    this.clearWelcomeTimer();
    this.pacer.clear(); // 小分けの残りは送らない（次の welcome で空の全体を受け取ってそろう）
    this.app.universe.peers.clear();
  }

  private clearWelcomeTimer() {
    if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
    this.welcomeTimer = null;
  }

  // 開いているときだけ送る。切断中の操作は捨てる（PartySocket のバッファも 0 にしてある）。
  // 星・線・きらめきの操作は OpPacer を通して小分けにする（位置・pulse・hello はそのまま）
  send(obj: ClientMessage) {
    const ws = this.ws;
    if (ws?.readyState !== OPEN) return;
    const data = JSON.stringify(obj);
    if (PACED.has(obj.t)) this.pacer.push(data);
    else ws.send(data);
  }

  // welcome を受け取った（message-handlers から呼ばれる）。ここで初めて「つながった」とみなす。
  // welcome の締め切りの待ちは初期値に戻す（PartySocket の待ちを戻すのは minUptime。部品に、外から戻す API が無いため）
  markWelcomed() {
    this.welcomed = true;
    this.welcomeRetries = 0;
    this.clearWelcomeTimer();
  }

  // サーバーからの指示で、位置を送る間隔を変える（1 人のときの 1000ms などもそのまま使う。下限だけ守る）
  setSendInterval(ms: number) {
    this.sendMs = Math.max(DEFAULT_SEND_MS, ms);
  }

  // 位置と、いま見ている範囲（視界）を送る。サーバーは視界の近くの人にだけ位置を返す
  sendPosition() {
    const { player, camera } = this.app;
    const [x0, y0] = camera.screenToWorld(0, 0);
    const [x1, y1] = camera.screenToWorld(camera.W, camera.H);
    const x = round(player.x, 4),
      y = round(player.y, 4);
    const v: View = [round(x0, 3), round(y0, 3), round(x1, 3), round(y1, 3)];
    this.lastSent = { x, y, v };
    this.send({ t: "p", x, y, c: player.colorIndex, v });
  }

  // 毎フレーム呼ばれる。指示された間隔ごとに確認し、ユーザーの操作で動いたときだけ送る
  // （止まった位置も次の確認で送られる）。死活監視は ping に任せるので、動かなければ送らない。
  // autopilot（target が null）で漂っている間の位置は送らない。視界は、ユーザーが自分で
  // 動かしたとき（camera.free）だけ送る
  tick(t: number) {
    if (t - this.lastSend < this.sendMs) return;
    this.lastSend = t;
    const { player, camera } = this.app;
    const last = this.lastSent;
    if (!last) return; // 接続直後の 1 回をまだ送っていない
    const autopilot = player.target === null;
    if (autopilot && !camera.free) return;
    const [vx0, vy0] = camera.screenToWorld(0, 0);
    const [vx1] = camera.screenToWorld(camera.W, 0);
    const posMoved = !autopilot && (Math.abs(player.x - last.x) > 1e-4 || Math.abs(player.y - last.y) > 1e-4);
    const viewMoved =
      Math.abs(vx0 - last.v[0]) > 1e-3 || Math.abs(vy0 - last.v[1]) > 1e-3 || Math.abs(vx1 - last.v[2]) > 1e-3;
    if (posMoved || viewMoved) this.sendPosition();
  }

  // --- 死活監視 ---

  // 定期的に ping を送り、長く何も届かなければ切れているとみなす。
  // half-open（閉じる通知が来ない）こともあるので、reconnect() で古い接続を捨てて、待たずに新しく開く
  private startWatchdog() {
    this.stopWatchdog();
    let sinceLastPing = 0;
    this.watchdog = setInterval(() => {
      const ws = this.ws;
      if (!ws) return;
      if (Date.now() - this.lastRx >= DEAD_AFTER_MS) {
        ws.reconnect();
        return;
      }
      sinceLastPing += WATCHDOG_MS;
      if (sinceLastPing >= PING_MS && ws.readyState === OPEN) {
        sinceLastPing = 0;
        ws.send("ping");
      }
    }, WATCHDOG_MS);
  }

  private stopWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  // --- 隠れたタブ ---
  // 隠れている間は描画ループが止まり位置も送られない。長く隠れたら切断して空きを返し、戻ったらつなぎ直す。
  // close() は PartySocket の再接続（待ちの途中のものも）を止める。reconnect() は接続を 1 本にそろえて開き直す
  private onVisibility() {
    if (document.hidden) {
      if (this.hiddenTimer || this.paused) return;
      this.hiddenTimer = setTimeout(() => {
        this.hiddenTimer = null;
        this.paused = true;
        this.clearRetryTimer(); // 待ちの終わる時刻（retryAt）は覚えておく
        this.ws?.close();
      }, HIDDEN_CLOSE_MS);
      return;
    }
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    this.hiddenTimer = null;
    if (!this.paused) return;
    this.paused = false;
    // 1008・welcome の締め切りの待ちの途中で隠れていたなら、残りだけ待つ（隠れても待ちは短くならない）
    const remain = this.retryAt - Date.now();
    if (remain > 0) {
      this.retryAfter(remain);
      return;
    }
    this.retryAt = 0;
    this.ws?.reconnect();
  }
}

// OpPacer を通す（サーバーのレート制限で数えられる操作）種類
const PACED = new Set<ClientMessage["t"]>(["star", "unstar", "link", "unlink", "admire"]);

const round = (v: number, digits: number) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};
