import { PALETTES, WS_HOST } from "./constants";
import { SOLO } from "./env";
import type { ClientMessage, ServerMessage } from "../shared/protocol";
import type { App } from "./app";

// ---------------------------------------------------------------------------
// Network — WebSocket 通信
// ---------------------------------------------------------------------------
export class Network {
  private ws: WebSocket | null = null;
  private retry = 1500;
  private lastSend = 0;

  constructor(private app: App) {}
  connect() {
    if (SOLO || location.protocol === "file:") return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = (this.ws = new WebSocket(`${scheme}://${WS_HOST}/ws`));
    ws.onopen = () => {
      this.retry = 1500;
      this.sendPosition();
    };
    ws.onmessage = (e) => this.handleMessage(JSON.parse(e.data) as ServerMessage);
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
  sendPosition() {
    const { player } = this.app;
    this.send({ t: "p", x: player.x, y: player.y, c: player.colorIndex });
  }
  // 位置は80msごとに間引いて送る
  tick(t: number) {
    if (t - this.lastSend > 80) {
      this.lastSend = t;
      this.sendPosition();
    }
  }
  handleMessage(m: ServerMessage) {
    const u = this.app.universe;
    if (m.t === "welcome") {
      u.myId = m.id;
      for (const d of m.dots) u.peers.set(d.id, { x: d.x, y: d.y, rx: d.x, ry: d.y, c: d.c });
      for (const s of m.stars || []) {
        u.stars.set(s.id, s);
        u.ghosts.delete(s.id); // 生きてるなら幽霊は要らない
      }
      for (const l of m.links || []) u.links.set(l.id, l);
      u.pairsDirty = true;
    } else if (m.t === "p") {
      const p = u.peers.get(m.id) || { x: m.x, y: m.y, rx: m.x, ry: m.y, c: m.c };
      p.x = m.x;
      p.y = m.y;
      if (typeof m.c === "number") p.c = m.c;
      u.peers.set(m.id, p);
    } else if (m.t === "star") {
      u.stars.set(m.id, m);
      u.ghosts.delete(m.id);
      u.pairsDirty = true;
    } else if (m.t === "unstar") {
      const s = u.stars.get(m.id);
      if (s && s.by === u.uid) {
        u.ghosts.set(m.id, { id: s.id, x: s.x, y: s.y, c: s.c, gone: Date.now() }); // 自分の星は幽霊になる
        u.saveGhosts();
      }
      u.stars.delete(m.id);
      u.dropLinksTouching(m.id);
      u.pairsDirty = true;
    } else if (m.t === "admire") {
      const s = u.stars.get(m.id);
      if (s) {
        s.ts = m.ts;
        s.flash = performance.now();
      }
    } else if (m.t === "link") {
      u.links.set(m.id, m);
    } else if (m.t === "unlink") {
      u.links.delete(m.id);
    } else if (m.t === "pulse") {
      u.addPulse(m.x, m.y, 0.8, typeof m.c === "number" ? PALETTES[m.c % PALETTES.length].glow : [255, 230, 200]);
    } else if (m.t === "leave") {
      u.peers.delete(m.id);
    }
  }
}
