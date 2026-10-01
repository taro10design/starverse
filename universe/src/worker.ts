interface Env {
  UNIVERSE: DurableObjectNamespace;
  ASSETS: Fetcher;
}

interface Session {
  id: string;
  x: number;
  y: number;
  c: number;
}

interface FixedStar {
  id: string;
  x: number;
  y: number;
  c: number;
  by: string;
  ts: number;
}

const MAX_STARS = 500;
const MAX_STARS_PER_USER = 64;
const STAR_TTL = 24 * 60 * 60 * 1000; // 星は一日で消える

// 宇宙という名の部屋。全員がここにいる。
export class Universe {
  private stars = new Map<string, FixedStar>();

  constructor(private ctx: DurableObjectState) {
    this.ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get<FixedStar[]>("stars");
      if (saved) for (const s of saved) this.stars.set(s.id, s);
    });
  }

  fetch(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const id = crypto.randomUUID().slice(0, 8);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, x: 0.5, y: 0.5, c: 0 } satisfies Session);

    // 新しく来た人に、今いる全員の位置と灯っている星を渡す
    const dots: Session[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === server) continue;
      const meta = ws.deserializeAttachment() as Session | null;
      if (meta) dots.push(meta);
    }
    this.prune();
    server.send(JSON.stringify({ t: "welcome", id, dots, stars: [...this.stars.values()] }));
    this.broadcast(server, { t: "p", id, x: 0.5, y: 0.5, c: 0 });

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const meta = ws.deserializeAttachment() as Session | null;
    if (!meta || typeof message !== "string") return;

    try {
      const data = JSON.parse(message);
      if (data.t === "p") {
        meta.x = data.x;
        meta.y = data.y;
        if (typeof data.c === "number") meta.c = data.c;
        ws.serializeAttachment(meta);
        this.broadcast(ws, { t: "p", id: meta.id, x: data.x, y: data.y, c: meta.c });
      } else if (data.t === "pulse") {
        this.broadcast(ws, { t: "pulse", x: data.x, y: data.y });
      } else if (data.t === "star") {
        this.placeStar(ws, meta, data);
      } else if (data.t === "unstar") {
        this.removeStar(ws, meta, String(data.id));
      }
    } catch {}
  }

  private placeStar(ws: WebSocket, meta: Session, data: { id: string; x: number; y: number }) {
    this.prune();
    let mine = 0;
    for (const s of this.stars.values()) if (s.by === meta.id) mine++;
    if (this.stars.size >= MAX_STARS || mine >= MAX_STARS_PER_USER) return;

    const star: FixedStar = {
      id: String(data.id).slice(0, 24),
      x: data.x,
      y: data.y,
      c: meta.c,
      by: meta.id,
      ts: Date.now(),
    };
    this.stars.set(star.id, star);
    this.ctx.waitUntil(this.ctx.storage.put("stars", [...this.stars.values()]));
    this.broadcast(ws, { t: "star", ...star });
  }

  private removeStar(ws: WebSocket, meta: Session, starId: string) {
    const s = this.stars.get(starId);
    if (!s || s.by !== meta.id) return; // 自分の星しか消せない
    this.stars.delete(s.id);
    this.ctx.waitUntil(this.ctx.storage.put("stars", [...this.stars.values()]));
    this.broadcast(ws, { t: "unstar", id: s.id });
  }

  private prune() {
    const now = Date.now();
    let dirty = false;
    for (const [id, s] of this.stars) {
      if (now - s.ts > STAR_TTL) {
        this.stars.delete(id);
        dirty = true;
      }
    }
    if (dirty) this.ctx.waitUntil(this.ctx.storage.put("stars", [...this.stars.values()]));
  }

  webSocketClose(ws: WebSocket) {
    const meta = ws.deserializeAttachment() as Session | null;
    if (meta) this.broadcast(ws, { t: "leave", id: meta.id });
  }

  webSocketError(ws: WebSocket) {
    this.webSocketClose(ws);
  }

  private broadcast(sender: WebSocket, msg: unknown) {
    const out = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== sender) {
        try {
          ws.send(out);
        } catch {}
      }
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws" && request.headers.get("Upgrade") === "websocket") {
      const room = env.UNIVERSE.get(env.UNIVERSE.idFromName("space"));
      return room.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
