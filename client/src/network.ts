import { WS_HOST } from "./constants";
import { SOLO } from "./env";
import type { ClientMessage, ServerMessage, View } from "../../shared/protocol";
import { handleServerMessage } from "./message-handlers";
import type { App } from "./app";

// ---------------------------------------------------------------------------
// Network — WebSocket 通信
// ---------------------------------------------------------------------------
const SEND_INTERVAL_MS = 100;
const HEARTBEAT_MS = 5000;

export class Network {
  private ws: WebSocket | null = null;
  private retry = 1500;
  private lastSend = 0;
  private lastForced = 0;
  private lastSent: { x: number; y: number; v: View } | null = null;

  constructor(private app: App) {}
  connect() {
    if (SOLO || location.protocol === "file:") return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = (this.ws = new WebSocket(`${scheme}://${WS_HOST}/ws`));
    ws.onopen = () => {
      this.retry = 1500;
      this.sendPosition();
    };
    ws.onmessage = (e) => handleServerMessage(JSON.parse(e.data) as ServerMessage, this.app.universe);
    ws.onclose = () => {
      this.app.universe.peers.clear();
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 1.6, 15000);
    };
    ws.onerror = () => ws.close();
  }
  send(obj: ClientMessage) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
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
  // 100msごとに確認し、動いたとき（と、動かなくても5秒に1回）だけ送る
  tick(t: number) {
    if (t - this.lastSend < SEND_INTERVAL_MS) return;
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
}

const round = (v: number, digits: number) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};
