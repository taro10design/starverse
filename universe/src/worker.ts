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

// 宇宙という名の部屋。全員がここにいる。
export class Universe {
  constructor(private ctx: DurableObjectState) {}

  fetch(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const id = crypto.randomUUID().slice(0, 8);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, x: 0.5, y: 0.5, c: 0 } satisfies Session);

    // 新しく来た人に、今いる全員の位置を渡す
    const dots: Session[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === server) continue;
      const meta = ws.deserializeAttachment() as Session | null;
      if (meta) dots.push(meta);
    }
    server.send(JSON.stringify({ t: "welcome", id, dots }));
    this.broadcast(server, { t: "p", id, x: 0.5, y: 0.5 });

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
      }
    } catch {}
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
