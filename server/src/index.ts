// Worker のエントリーポイント。
// /ws は「空」（Durable Object）へ振り分け、それ以外は静的ファイルを返す。
// 部屋の実装は src/server/ 以下。

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws" && request.headers.get("Upgrade") === "websocket") {
      return connect(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
