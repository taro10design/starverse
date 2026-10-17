import { WS_HOST } from "./constants";
import { SOLO } from "./env";
import type { ClientMessage, View } from "../../shared/protocol";
import { handleServerMessage, parseServerMessage } from "./message-handlers";
import type { App } from "./app";

// ---------------------------------------------------------------------------
// Network — WebSocket 通信
//
// 位置を送る間隔はサーバーが指示する（welcome / rate）。人が増えるほど間隔が広がり、
// 1 つの空が受け取るメッセージ量を一定の予算に収める。受信側は補間して滑らかに見せる。
//
// 接続の状態: 接続はいつも高々 1 本（this.ws）。新しく開く前に、古い接続のハンドラを外して閉じ、
// 予約済みの再接続も取り消す。古い接続から遅れて届いた通知は ws !== this.ws で無視する。
// 「隠れて切った」（paused）間は、再接続を予約しない。表示に戻ったら 1 本だけ開く。
// 再接続の待ち時間は、welcome まで受け取れたときだけ初期値に戻す（開くだけで切られる状態で詰め寄らない）。
// ---------------------------------------------------------------------------
const DEFAULT_SEND_MS = 100; // 位置を送る間隔の下限（サーバーの指示がこれより短くても守る）
const PING_MS = 10_000; // 死活監視の ping（サーバーが Durable Object を起こさずに pong を返す）
const DEAD_AFTER_MS = 25_000; // 何も受け取れない状態がこれだけ続いたら（ping 2 回に答えが無い）、つなぎ直す
const WATCHDOG_MS = 5000; // 死活監視の確認間隔
const CONNECT_TIMEOUT_MS = 10_000; // 開いてから welcome までの上限（CONNECTING のまま固まるのを防ぐ）
const HIDDEN_CLOSE_MS = 30_000; // タブが隠れて、これだけ経ったら切断して空きを返す
const RETRY_MIN_MS = 1500;
const RETRY_MAX_MS = 15_000;
const POLICY_RETRY_MS = 30_000; // サーバーが 1008（ポリシー違反・乱用対策）で切ったときの待ち時間
const CLOSE_POLICY = 1008;
const OPEN = 1; // WebSocket.OPEN

// Network が使う App の部分（テストでは最小の偽物を渡す）
export type NetworkHost = Pick<App, "universe" | "player" | "camera">;

export class Network {
  private ws: WebSocket | null = null;
  private welcomed = false; // いまの接続で welcome を受け取ったか
  private retry = RETRY_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private paused = false; // 隠れていたために切った（表示に戻ったらつなぐ）
  private started = false;
  private sendMs = DEFAULT_SEND_MS;
  private lastSend = 0;
  private lastSent: { x: number; y: number; v: View } | null = null;
  private lastRx = 0;

  constructor(private app: NetworkHost) {}

  connect() {
    if (SOLO || location.protocol === "file:" || this.started) return;
    this.started = true;
    document.addEventListener("visibilitychange", () => this.onVisibility());
    this.open();
  }

  // サーバーへ送る操作ができる状態か（つながっていて、welcome で持ち主 ID が分かっている）
  get ready(): boolean {
    return this.welcomed && this.ws !== null && this.ws.readyState === OPEN;
  }

  private open() {
    this.cancelReconnect();
    this.discard();
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${WS_HOST}/ws`);
    this.ws = ws;
    this.welcomed = false;
    this.clearConnectTimer();
    // onopen も welcome も来ないまま固まったら、閉じて（待ち時間を伸ばしながら）つなぎ直す
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (ws !== this.ws || this.welcomed) return;
      this.discard();
      this.scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.lastRx = Date.now();
      this.send({ t: "hello", uid: this.app.universe.uid }); // 最初に 1 回だけ、持ち主の鍵を名乗る
      this.sendPosition(); // 接続直後は、操作していなくても 1 回送る
      this.startWatchdog(ws);
    };
    ws.onmessage = (e) => {
      if (ws !== this.ws) return;
      this.lastRx = Date.now();
      if (e.data === "pong") return;
      const m = parseServerMessage(e.data);
      if (m) handleServerMessage(m, this.app.universe, this);
    };
    ws.onclose = (e) => {
      if (ws !== this.ws) return; // 置き換えた古い接続の通知
      this.ws = null;
      this.onDisconnected();
      if (this.paused) return;
      // 乱用対策で切られたなら、しばらく（ばらつきつきで）待つ
      if (e.code === CLOSE_POLICY) this.scheduleReconnect(POLICY_RETRY_MS * (1 + Math.random() * 0.5));
      else this.scheduleReconnect();
    };
    ws.onerror = () => {
      if (ws === this.ws) ws.close();
    };
  }

  // いまの接続のハンドラを外して閉じる（閉じる通知を待たない）
  private discard() {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    ws.close();
    this.onDisconnected();
  }

  private onDisconnected() {
    this.welcomed = false;
    this.stopWatchdog();
    this.clearConnectTimer();
    this.app.universe.peers.clear();
  }

  private clearConnectTimer() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  // 一斉に再接続して集中しないよう、待ち時間にばらつきを持たせる。delay を渡すとその時間だけ待つ
  private scheduleReconnect(delay = this.retry * (0.5 + Math.random())) {
    this.cancelReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
    this.retry = Math.min(this.retry * 1.6, RETRY_MAX_MS);
  }

  private cancelReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  send(obj: ClientMessage) {
    if (this.ws && this.ws.readyState === OPEN) this.ws.send(JSON.stringify(obj));
  }

  // welcome を受け取った（message-handlers から呼ばれる）。ここで初めて「つながった」とみなす
  markWelcomed() {
    this.welcomed = true;
    this.retry = RETRY_MIN_MS;
    this.clearConnectTimer();
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
  // half-open（閉じる通知が来ない）こともあるので、閉じるのを待たずに新しく開く
  private startWatchdog(ws: WebSocket) {
    this.stopWatchdog();
    let sinceLastPing = 0;
    this.watchdog = setInterval(() => {
      if (ws !== this.ws) return;
      if (Date.now() - this.lastRx >= DEAD_AFTER_MS) {
        this.open();
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
  // 隠れている間は描画ループが止まり位置も送られない。長く隠れたら切断して空きを返し、戻ったらつなぎ直す
  private onVisibility() {
    if (document.hidden) {
      if (this.hiddenTimer || this.paused) return;
      this.hiddenTimer = setTimeout(() => {
        this.hiddenTimer = null;
        this.paused = true;
        this.cancelReconnect();
        this.discard();
      }, HIDDEN_CLOSE_MS);
      return;
    }
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    this.hiddenTimer = null;
    if (this.paused) {
      this.paused = false;
      this.retry = RETRY_MIN_MS;
      this.open();
    }
  }
}

const round = (v: number, digits: number) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};
