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
const STAR_TTL = 3 * 60 * 60 * 1000; // 孤立した星の寿命
const CROWD_R = 0.06; // 「混んでる」とみなす近傍半径（ワールド座標）

// 周囲の星の数で寿命が決まる。密集スパムは1分で自壊する
function ttlFor(crowd: number): number {
  if (crowd >= 8) return 60 * 1000;
  if (crowd >= 5) return 5 * 60 * 1000;
  if (crowd >= 2) return 30 * 60 * 1000;
  return STAR_TTL;
}

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
        this.removeStar(ws, meta, String(data.id), typeof data.uid === "string" ? data.uid : "");
      } else if (data.t === "admire") {
        const s = this.stars.get(String(data.id));
        if (s) {
          s.ts = Date.now(); // 見てもらった星は息を吹き返す
          this.ctx.waitUntil(this.ctx.storage.put("stars", [...this.stars.values()]));
          this.broadcast(null, { t: "admire", id: s.id, ts: s.ts });
        }
      } else if (data.t === "link") {
        this.addLink(ws, meta, String(data.a), String(data.b), typeof data.uid === "string" ? data.uid : "", typeof data.id === "string" ? data.id : "");
      } else if (data.t === "unlink") {
        this.removeLink(ws, meta, String(data.id), typeof data.uid === "string" ? data.uid : "");
      }
    } catch {}
  }

  private placeStar(ws: WebSocket, meta: Session, data: { id: string; x: number; y: number; uid?: string }) {
    this.prune();
    // 持ち主はブラウザ固有のuid（セッションではなく端末が主語）
    const owner = typeof data.uid === "string" && data.uid ? data.uid.slice(0, 40) : meta.id;
    let mine = 0;
    for (const s of this.stars.values()) if (s.by === owner) mine++;
    if (this.stars.size >= MAX_STARS || mine >= MAX_STARS_PER_USER) return;

    const star: FixedStar = {
      id: String(data.id).slice(0, 24),
      x: data.x,
      y: data.y,
      c: meta.c,
      by: owner,
      ts: Date.now(),
    };
    this.stars.set(star.id, star);
    this.ctx.waitUntil(this.ctx.storage.put("stars", [...this.stars.values()]));
    this.broadcast(ws, { t: "star", ...star });
  }

  private removeStar(ws: WebSocket, meta: Session, starId: string, uid: string) {
    const s = this.stars.get(starId);
    if (!s) return; // 誰でも消せる。持ち主は幽霊から復活できる
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

  private addLink(ws: WebSocket, meta: Session, a: string, b: string, uid: string, id: string) {
    if (a === b || !this.stars.has(a) || !this.stars.has(b)) return;
    for (const l of this.links.values()) {
      if ((l.a === a && l.b === b) || (l.a === b && l.b === a) || l.id === id) return; // 同じ線は一本
    }
    this.prune();
    const owner = uid ? uid.slice(0, 40) : meta.id;
    let mine = 0;
    for (const l of this.links.values()) if (l.by === owner) mine++;
    if (this.links.size >= MAX_LINKS || mine >= MAX_LINKS_PER_USER) return;

    const link: Link = { id: id ? id.slice(0, 24) : crypto.randomUUID().slice(0, 12), a, b, by: owner, ts: Date.now() };
    this.links.set(link.id, link);
    this.ctx.waitUntil(this.ctx.storage.put("links", [...this.links.values()]));
    this.broadcast(ws, { t: "link", ...link });
  }

  private removeLink(ws: WebSocket, meta: Session, linkId: string, uid: string) {
    const l = this.links.get(linkId);
    if (!l || !uid || l.by !== uid) return;
    this.links.delete(linkId);
    this.ctx.waitUntil(this.ctx.storage.put("links", [...this.links.values()]));
    this.broadcast(ws, { t: "unlink", id: linkId });
  }

  private prune() {
    const now = Date.now();
    const arr = [...this.stars.values()];
    const crowd = new Map<string, number>();
    for (const s of arr) crowd.set(s.id, 0);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const dx = arr[i].x - arr[j].x;
        const dy = arr[i].y - arr[j].y;
        if (dx * dx + dy * dy < CROWD_R * CROWD_R) {
          crowd.set(arr[i].id, crowd.get(arr[i].id)! + 1);
          crowd.set(arr[j].id, crowd.get(arr[j].id)! + 1);
        }
      }
    }
    let dirty = false;
    for (const s of arr) {
      if (now - s.ts > ttlFor(crowd.get(s.id) || 0)) {
        this.stars.delete(s.id);
        dirty = true;
        this.broadcast(null, { t: "unstar", id: s.id });
        for (const [lid, l] of this.links) {
          if (l.a === s.id || l.b === s.id) {
            this.links.delete(lid);
            this.broadcast(null, { t: "unlink", id: lid });
          }
        }
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
    if (ldirty || dirty) this.ctx.waitUntil(this.ctx.storage.put("links", [...this.links.values()]));
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
