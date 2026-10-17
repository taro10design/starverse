// Worker のエントリーポイント。
// /ws は「空」（Durable Object）へ振り分け、それ以外は静的ファイルを返す。
// 部屋の実装は room.ts、世界のルールは world.ts。

import { LIMITS, roomName } from "./config";
import type { Env } from "./env";

export { Universe } from "./room";

// 満員の空は飛ばして、空きのある最初の空に入れる。
// 先頭の "space" は従来どおりの名前なので、既存の星もそのまま引き継がれる。
async function connect(request: Request, env: Env): Promise<Response> {
  for (let i = 0; i < LIMITS.maxRooms; i++) {
    const room = env.UNIVERSE.get(env.UNIVERSE.idFromName(roomName(i)));
    const res = await room.fetch(request.clone());
    if (!(res.status === 503 && res.headers.get("x-room-full"))) return res;
  }
  return new Response("all rooms are full", { status: 503 });
}

// 空ごとの接続数・星の数などを返す（観測用）。Durable Object への問い合わせが増えすぎないよう 10 秒キャッシュする
let statsCache: { at: number; body: string } | null = null;
async function stats(env: Env): Promise<Response> {
  const headers = { "content-type": "application/json", "cache-control": "public, max-age=10" };
  if (statsCache && Date.now() - statsCache.at < 10_000) return new Response(statsCache.body, { headers });

  const rooms = [];
  for (let i = 0; i < LIMITS.maxRooms; i++) {
    const room = env.UNIVERSE.get(env.UNIVERSE.idFromName(roomName(i)));
    const data = (await (await room.fetch("https://room/stats")).json()) as { connections: number };
    rooms.push({ room: roomName(i), ...data });
    if (i > 0 && data.connections === 0) break; // 使われていない空より先は見ない
  }
  const body = JSON.stringify({ totalConnections: rooms.reduce((n, r) => n + r.connections, 0), rooms });
  statsCache = { at: Date.now(), body };
  return new Response(body, { headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws" && request.headers.get("Upgrade") === "websocket") {
      return connect(request, env);
    }
    if (url.pathname === "/stats") return stats(env);
    return env.ASSETS.fetch(request);
  },
};
