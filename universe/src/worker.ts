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

// 誰かが意図して引いた線。星aと星bを結ぶ
interface Link {
  id: string;
  a: string;
  b: string;
  by: string;
  ts: number;
}

const MAX_STARS = 500;
const MAX_STARS_PER_USER = 64;
const MAX_LINKS = 600;
const MAX_LINKS_PER_USER = 96;
const STAR_TTL = 24 * 60 * 60 * 1000; // 星は一日で消える

// 宇宙という名の部屋。全員がここにいる。
export class Universe {
  private stars = new Map<string, FixedStar>();
  private links = new Map<string, Link>();

  constructor(private ctx: DurableObjectState) {
    this.ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get<FixedStar[]>("stars");
      if (saved) for (const s of saved) this.stars.set(s.id, s);
      const savedLinks = await this.ctx.storage.get<Link[]>("links");
      if (savedLinks) for (const l of savedLinks) this.links.set(l.id, l);
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
    server.send(JSON.stringify({ t: "welcome", id, dots, stars: [...this.stars.values()], links: [...this.links.values()] }));
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
        this.broadcast(ws, { t: "pulse", x: data.x, y: data.y, c: meta.c });
      } else if (data.t === "star") {
        this.placeStar(ws, meta, data);
      } else if (data.t === "unstar") {
        this.removeStar(ws, meta, String(data.id));
      } else if (data.t === "link") {
        this.addLink(ws, meta, String(data.a), String(data.b));
      } else if (data.t === "unlink") {
        this.removeLink(ws, meta, String(data.id));
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
    // 端が消えたら線も消える
    for (const [lid, l] of this.links) {
      if (l.a === s.id || l.b === s.id) {
        this.links.delete(lid);
        this.broadcast(null, { t: "unlink", id: lid });
      }
    }
    this.ctx.waitUntil(this.ctx.storage.put("links", [...this.links.values()]));
  }

  private addLink(ws: WebSocket, meta: Session, a: string, b: string) {
    if (a === b || !this.stars.has(a) || !this.stars.has(b)) return;
    for (const l of this.links.values()) {
      if ((l.a === a && l.b === b) || (l.a === b && l.b === a)) return; // 同じ線は一本
    }
    this.prune();
    let mine = 0;
    for (const l of this.links.values()) if (l.by === meta.id) mine++;
    if (this.links.size >= MAX_LINKS || mine >= MAX_LINKS_PER_USER) return;

    const link: Link = { id: crypto.randomUUID().slice(0, 12), a, b, by: meta.id, ts: Date.now() };
    this.links.set(link.id, link);
    this.ctx.waitUntil(this.ctx.storage.put("links", [...this.links.values()]));
    this.broadcast(ws, { t: "link", ...link });
  }

  private removeLink(ws: WebSocket, meta: Session, linkId: string) {
    const l = this.links.get(linkId);
    if (!l || l.by !== meta.id) return;
    this.links.delete(linkId);
    this.ctx.waitUntil(this.ctx.storage.put("links", [...this.links.values()]));
    this.broadcast(ws, { t: "unlink", id: linkId });
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
    let ldirty = false;
    for (const [id, l] of this.links) {
      if (now - l.ts > STAR_TTL || !this.stars.has(l.a) || !this.stars.has(l.b)) {
        this.links.delete(id);
        ldirty = true;
      }
    }
    if (ldirty) this.ctx.waitUntil(this.ctx.storage.put("links", [...this.links.values()]));
  }

  webSocketClose(ws: WebSocket) {
    const meta = ws.deserializeAttachment() as Session | null;
    if (meta) this.broadcast(ws, { t: "leave", id: meta.id });
  }

  webSocketError(ws: WebSocket) {
    this.webSocketClose(ws);
  }

  private broadcast(sender: WebSocket | null, msg: unknown) {
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
