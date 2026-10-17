// クライアントからのメッセージごとの処理。
// `handlers` は ClientMessage の全種類（hello を除く）を網羅しないと型エラーになる。
// 新しいメッセージを足すときは、shared/protocol.ts に型を足してからここに処理を書く。
// hello は持ち主を決める接続の入口なので、room.ts が受け持つ（ここに来るのは hello を済ませた接続だけ）。

import type { ClientMessage, ServerMessage, View } from "../../shared/protocol";
import type { ViolationCounter } from "./inbound";
import type { Cooldown, TokenBucket } from "./rate-limit";
import type { World } from "./world";

// 1本の接続（1人ぶんの状態）
export interface Conn {
  ws: WebSocket;
  id: string;
  owner: string | null; // 持ち主 ID（uid のハッシュ）。hello を受けるまでは null
  ip: string | null; // 接続元の鍵（HMAC。同じ接続元の接続数・星の数を数える用）。分からなければ null
  since: number; // 接続した時刻（hello の待ち時間の判定用）
  x: number;
  y: number;
  c: number;
  view: View | null; // 見ている範囲。null なら全体
  dirty: boolean; // 位置が変わって、まだ配信していない
  bucket: TokenBucket;
  violations: ViolationCounter; // 手順の違反（hello 前の hello 以外、2 回目以降の hello）
  admired: Cooldown; // 星ごとの、最後にきらめかせた時刻（連打で寿命を延ばし続けられないように）
  attachedAt: number; // 最後に永続属性（ハイバネート用）へ書いた時刻
}

// hello を済ませて持ち主が決まった接続
export type Member = Conn & { owner: string };

export interface BroadcastOptions {
  except?: Conn;
  requireView?: boolean; // true なら、視界をまだ送ってこない接続には送らない
}

// ハンドラが部屋に頼める操作。部屋の実装（room.ts）を隠す
export interface RoomApi {
  readonly world: World;
  now(): number;
  send(conn: Conn, msg: ServerMessage): void;
  broadcast(msg: ServerMessage, except?: Conn): void;
  broadcastNear(msg: ServerMessage, x: number, y: number, opts?: BroadcastOptions): void;
  markDirty(conn: Conn): void;
  persist(): void;
  prune(force?: boolean): void;
}

// hello 以外のメッセージ
export type MemberMessage = Exclude<ClientMessage, { t: "hello" }>;
type MemberMessageType = MemberMessage["t"];

type Handler<K extends MemberMessageType> = (
  room: RoomApi,
  conn: Member,
  msg: Extract<MemberMessage, { t: K }>,
) => void;

// これより小さい変化は「動いていない」とみなす（止まっている人の送信で部屋を起こし続けない）
const MOVE_EPS = 1e-4;
const VIEW_EPS = 1e-3;

function viewChanged(prev: View | null, next: View): boolean {
  if (!prev) return true;
  return next.some((v, i) => Math.abs(v - prev[i]) >= VIEW_EPS);
}

const handlers: { [K in MemberMessageType]: Handler<K> } = {
  p(room, conn, m) {
    const moved = Math.abs(m.x - conn.x) >= MOVE_EPS || Math.abs(m.y - conn.y) >= MOVE_EPS || m.c !== conn.c;
    const looked = m.v !== undefined && viewChanged(conn.view, m.v);
    if (!moved && !looked) return;
    conn.x = m.x;
    conn.y = m.y;
    conn.c = m.c;
    if (m.v) conn.view = m.v;
    room.markDirty(conn);
  },

  pulse(room, conn, m) {
    room.broadcastNear({ t: "pulse", x: m.x, y: m.y, c: conn.c }, m.x, m.y, { except: conn, requireView: true });
  },

  star(room, conn, m) {
    room.prune();
    const star = room.world.placeStar(conn.owner, m.id, m.x, m.y, m.c, room.now(), conn.ip);
    if (!star) {
      room.send(conn, { t: "reject", kind: "star", id: m.id }); // 上限超え（全体・持ち主・接続元）・他人の星の上書き
      return;
    }
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

  // 見てもらった星は息を吹き返す。同じ接続から同じ星へは admireCooldownMs に 1 回だけ。
  // 知らせるのは、その星が視界に入っている人だけ（視界をまだ送ってこない人には送る）
  admire(room, conn, m) {
    const now = room.now();
    if (!room.world.stars.has(m.id) || !conn.admired.allow(m.id, now)) return;
    const star = room.world.admire(m.id, now); // 作成から maxStarAgeMs を過ぎた星は延びない
    if (!star) return;
    room.broadcastNear({ t: "admire", id: star.id, ts: star.ts }, star.x, star.y);
    room.persist();
  },

  link(room, conn, m) {
    room.prune();
    const link = room.world.addLink(conn.owner, m.id, m.a, m.b, room.now());
    if (!link) {
      room.send(conn, { t: "reject", kind: "link", id: m.id }); // 上限超え・無効な端・同じ 2 点の重複
      return;
    }
    room.broadcast({ t: "link", ...link }, conn);
    room.persist();
  },

  unlink(room, conn, m) {
    if (!room.world.removeLink(m.id, conn.owner)) return; // 線は持ち主だけが消せる
    room.broadcast({ t: "unlink", id: m.id }, conn);
    room.persist();
  },
};

export function dispatch(room: RoomApi, conn: Member, msg: MemberMessage) {
  (handlers[msg.t] as (r: RoomApi, c: Member, m: MemberMessage) => void)(room, conn, msg);
}
