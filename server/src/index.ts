// Worker のエントリーポイント。
// /ws は「空」（Durable Object）へ振り分け、/stats は観測用、それ以外は静的ファイルを返す。
// 部屋の実装は room.ts、世界のルールは world.ts、入口の判定（Origin・ヘッダー・接続頻度）は gateway.ts。

import { LIMITS, roomName } from "./config";
import type { Env } from "./env";
import { allowConnectRate, isAllowedOrigin, isWebSocketUpgrade, toRoomRequest } from "./gateway";
import { safeEqual } from "./identity";

export { Universe } from "./room";

// 空の Durable Object。getByName（idFromName）で作るので、PartyServer の this.name は ctx.id.name から決まり、
// onStart は最初の fetch の中で（PartyServer が）済ませる。getServerByName の setName の RPC は要らない
function roomStub(env: Env, index: number) {
  return env.UNIVERSE.getByName(roomName(index));
}

// 満員の空は飛ばして、空きのある最初の空に入れる。
// 先頭の "space" は従来どおりの名前なので、既存の星もそのまま引き継がれる。
// 満員（x-room-full）以外の応答は、次の空に回さずそのまま返す。
async function connect(request: Request, env: Env): Promise<Response> {
  const forward = toRoomRequest(request);
  for (let i = 0; i < LIMITS.maxRooms; i++) {
    const res = await roomStub(env, i).fetch(forward.clone());
    if (!(res.status === 503 && res.headers.get("x-room-full"))) return res;
  }
  return new Response("all rooms are full", { status: 503 });
}

// /ws の入口の確かめ。頻度の制限を先に行う（不許可の Origin での連打も数える）
async function admitWebSocket(request: Request, env: Env): Promise<Response | null> {
  if (!(await allowConnectRate(env.CONNECT_LIMITER, request.headers.get("CF-Connecting-IP")))) {
    return new Response("too many connections", { status: 429 });
  }
  if (!isAllowedOrigin(request.headers.get("Origin"), request.url)) {
    return new Response("forbidden origin", { status: 403 });
  }
  return null;
}

// /stats は公開しない。シークレット STATS_TOKEN が設定されていて、x-stats-token が一致するときだけ返す
function canSeeStats(request: Request, env: Env): boolean {
  const token = env.STATS_TOKEN;
  const given = request.headers.get("x-stats-token");
  return !!token && given !== null && safeEqual(given, token);
}

// 空ごとの接続数・星の数などを返す（観測用）。Durable Object への問い合わせが増えすぎないよう 10 秒キャッシュする
let statsCache: { at: number; body: string } | null = null;
async function stats(env: Env): Promise<Response> {
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  if (statsCache && Date.now() - statsCache.at < 10_000) return new Response(statsCache.body, { headers });

  // 空いている空の先にも人がいることがある（途中の空が空いた場合）ので、全部を順に見る
  const rooms = [];
  for (let i = 0; i < LIMITS.maxRooms; i++) {
    const data = (await (await roomStub(env, i).fetch("https://room/stats")).json()) as { connections: number };
    rooms.push({ room: roomName(i), ...data });
  }
  const body = JSON.stringify({ totalConnections: rooms.reduce((n, r) => n + r.connections, 0), rooms });
  statsCache = { at: Date.now(), body };
  return new Response(body, { headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws" && isWebSocketUpgrade(request)) {
      return (await admitWebSocket(request, env)) ?? connect(request, env);
    }
    if (url.pathname === "/stats") {
      return canSeeStats(request, env) ? stats(env) : new Response("not found", { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
