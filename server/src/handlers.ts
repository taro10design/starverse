// クライアントからのメッセージごとの処理。
// `handlers` は ClientMessage の全種類を網羅しないと型エラーになる。
// 新しいメッセージを足すときは、shared/protocol.ts に型を足してからここに処理を書く。

import type { ClientMessage, ClientMessageType, ServerMessage, View } from "../../shared/protocol";
import type { TokenBucket } from "./rate-limit";
import type { World } from "./world";

// 1本の接続（1人ぶんの状態）
export interface Conn {
  ws: WebSocket;
  id: string;
  x: number;
  y: number;
  c: number;
  view: View | null; // 見ている範囲。null なら全体
  dirty: boolean; // 位置が変わって、まだ配信していない
  bucket: TokenBucket;
  attachedAt: number; // 最後に永続属性（ハイバネート用）へ書いた時刻
}

// ハンドラが部屋に頼める操作。部屋の実装（room.ts）を隠す
export interface RoomApi {
  readonly world: World;
  now(): number;
  broadcast(msg: ServerMessage, except?: Conn): void;
  broadcastNear(msg: ServerMessage, x: number, y: number, except?: Conn): void;
  markDirty(conn: Conn): void;
  persist(): void;
  prune(force?: boolean): void;
}

type Handler<K extends ClientMessageType> = (room: RoomApi, conn: Conn, msg: Extract<ClientMessage, { t: K }>) => void;

const owner = (conn: Conn, uid: string | undefined) => uid ?? conn.id; // 持ち主はブラウザ固有の uid（端末が主語）

export const handlers: { [K in ClientMessageType]: Handler<K> } = {
  p(room, conn, m) {
    conn.x = m.x;
    conn.y = m.y;
    conn.c = m.c;
    if (m.v) conn.view = m.v;
    room.markDirty(conn);
  },

  pulse(room, conn, m) {
    room.broadcastNear({ t: "pulse", x: m.x, y: m.y, c: conn.c }, m.x, m.y, conn);
  },

  star(room, conn, m) {
    room.prune();
    const star = room.world.placeStar(owner(conn, m.uid), m.id, m.x, m.y, conn.c, room.now());
    if (!star) return;
    room.broadcast({ t: "star", ...star }, conn);
    room.persist();
  },

  unstar(room, conn, m) {
    const removed = room.world.removeStar(m.id);
    if (!removed) return;
    room.broadcast({ t: "unstar", id: removed.star.id }, conn);
    for (const id of removed.links) room.broadcast({ t: "unlink", id }); // 端が消えたら線も消える
    room.persist();
  },

  admire(room, _conn, m) {
    const star = room.world.admire(m.id, room.now()); // 見てもらった星は息を吹き返す
    if (!star) return;
    room.broadcast({ t: "admire", id: star.id, ts: star.ts });
    room.persist();
  },

  link(room, conn, m) {
    room.prune();
    const link = room.world.addLink(owner(conn, m.uid), m.id, m.a, m.b, room.now());
    if (!link) return;
    room.broadcast({ t: "link", ...link }, conn);
    room.persist();
  },

  unlink(room, conn, m) {
    if (!room.world.removeLink(m.id, m.uid)) return;
    room.broadcast({ t: "unlink", id: m.id }, conn);
    room.persist();
  },
};

export function dispatch(room: RoomApi, conn: Conn, msg: ClientMessage) {
  (handlers[msg.t] as (r: RoomApi, c: Conn, m: ClientMessage) => void)(room, conn, msg);
}
