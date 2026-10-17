import { WS_HOST } from "./constants";
import { SOLO } from "./env";
import type { ClientMessage, ServerMessage, View } from "../../shared/protocol";
import { handleServerMessage } from "./message-handlers";
import type { App } from "./app";

// ---------------------------------------------------------------------------
// Network — WebSocket 通信
//
// 位置を送る間隔はサーバーが指示する（welcome / rate）。人が増えるほど間隔が広がり、
// 1 つの空が受け取るメッセージ量を一定の予算に収める。受信側は補間して滑らかに見せる。
// ---------------------------------------------------------------------------
const DEFAULT_SEND_MS = 100;
const HEARTBEAT_MS = 5000; // 動かなくても、これだけ経ったら位置を送り直す
const PING_MS = 25_000; // 死活監視の ping（サーバーが Durable Object を起こさずに pong を返す）
const DEAD_AFTER_MS = 70_000; // 何も受け取れない状態がこれだけ続いたら、つなぎ直す
const HIDDEN_CLOSE_MS = 30_000; // タブが隠れて、これだけ経ったら切断して空きを返す

export class Network {
  private ws: WebSocket | null = null;
  private retry = 1500;
  private sendMs = DEFAULT_SEND_MS;
  private lastSend = 0;
  private lastForced = 0;
  private lastSent: { x: number; y: number; v: View } | null = null;
  private lastRx = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private pausedByHidden = false;

  constructor(private app: App) {}

  connect() {
    if (SOLO || location.protocol === "file:") return;
    document.addEventListener("visibilitychange", () => this.onVisibility());
    this.open();
  }

  private open() {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = (this.ws = new WebSocket(`${scheme}://${WS_HOST}/ws`));
    ws.onopen = () => {
      this.retry = 1500;
      this.lastRx = Date.now();
      this.sendPosition();
      this.startWatchdog(ws);
    };
    ws.onmessage = (e) => {
      this.lastRx = Date.now();
      if (e.data === "pong") return;
      handleServerMessage(JSON.parse(e.data) as ServerMessage, this.app.universe, this);
    };
    ws.onclose = () => {
      this.stopWatchdog();
      this.app.universe.peers.clear();
      if (this.pausedByHidden) return; // 隠れていたために切った場合は、表示に戻ったときにつなぐ
      // 一斉に再接続して集中しないよう、待ち時間にばらつきを持たせる
      setTimeout(() => this.open(), this.retry * (0.5 + Math.random()));
      this.retry = Math.min(this.retry * 1.6, 15000);
    };
    ws.onerror = () => ws.close();
  }

  send(obj: ClientMessage) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  // サーバーからの指示で、位置を送る間隔を変える
  setSendInterval(ms: number) {
    this.sendMs = Math.max(DEFAULT_SEND_MS, ms);
  }

  // 位置と、いま見ている範囲（視界）を送る。サーバーは視界の近くの人にだけ位置を返す
  sendPosition() {
    const { player, camera } = this.app;
    const [x0, y0] = camera.screenToWorld(0, 0);
    const [x1, y1] = camera.screenToWorld(camera.W, camera.H);
    const x = round(player.x, 4), y = round(player.y, 4);
    const v: View = [round(x0, 3), round(y0, 3), round(x1, 3), round(y1, 3)];
    this.lastSent = { x, y, v };
    this.send({ t: "p", x, y, c: player.colorIndex, v });
  }

  // 毎フレーム呼ばれる。指示された間隔ごとに確認し、動いたとき（と、動かなくても 5 秒に 1 回）だけ送る。
  // 最後に止まった位置も、次の確認で必ず送られる
  tick(t: number) {
    if (t - this.lastSend < this.sendMs) return;
    this.lastSend = t;
    const { player, camera } = this.app;
    const last = this.lastSent;
    const [vx0, vy0] = camera.screenToWorld(0, 0);
    const moved = !last || Math.abs(player.x - last.x) > 1e-4 || Math.abs(player.y - last.y) > 1e-4 || Math.abs(vx0 - last.v[0]) > 1e-3 || Math.abs(vy0 - last.v[1]) > 1e-3;
    if (moved || t - this.lastForced > HEARTBEAT_MS) {
      this.lastForced = t;
      this.sendPosition();
    }
  }

  // --- 死活監視 ---

  // 定期的に ping を送り、長く何も届かなければ切れているとみなしてつなぎ直す
  private startWatchdog(ws: WebSocket) {
    this.stopWatchdog();
    let sinceLastPing = 0;
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastRx > DEAD_AFTER_MS) {
        ws.close();
        return;
      }
      sinceLastPing += 5000;
      if (sinceLastPing >= PING_MS && ws.readyState === 1) {
        sinceLastPing = 0;
        ws.send("ping");
      }
    }, 5000);
  }

  private stopWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  // --- 隠れたタブ ---
  // 隠れている間は描画ループが止まり位置も送られない。長く隠れたら切断して空きを返し、戻ったらつなぎ直す
  private onVisibility() {
    if (document.hidden) {
      this.hiddenTimer = setTimeout(() => {
        this.pausedByHidden = true;
        this.ws?.close();
      }, HIDDEN_CLOSE_MS);
    } else {
      if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
      this.hiddenTimer = null;
      if (this.pausedByHidden) {
        this.pausedByHidden = false;
        this.retry = 1500;
        this.open();
      }
    }
  }
}

const round = (v: number, digits: number) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};
