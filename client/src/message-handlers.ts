// サーバーからのメッセージごとの処理。
// `serverHandlers` は ServerMessage の全種類を網羅しないと型エラーになる。
// 新しいメッセージを足すときは、shared/protocol.ts に型を足してからここに処理を書く。

import type { ServerMessage, ServerMessageType } from "../../shared/protocol";
import { PALETTES } from "./constants";
import type { Network } from "./network";
import type { Universe } from "./universe";

type Handler<K extends ServerMessageType> = (m: Extract<ServerMessage, { t: K }>, u: Universe, net: Network) => void;

export const serverHandlers: { [K in ServerMessageType]: Handler<K> } = {
  // 接続したときの空の全体。再接続の前の古い状態が残らないよう、星・線・他の人は置き換える。
  // 幽霊は自分の画面だけの記憶なので残す。黙って消えた自分の星は幽霊にする（Universe.replaceSky）
  welcome(m, u, net) {
    u.replaceSky(m.stars, m.links); // 前の空の自分の星は、前の持ち主 ID で判定する
    u.myId = m.id;
    u.ownerId = m.me;
    net.setSendInterval(m.sendMs);
    u.peers.clear();
    for (const d of m.dots) u.setPeer(d.id, d.x, d.y, d.c);
    net.markWelcomed();
  },

  // 空の人数が変わったときの、位置を送る間隔の指示
  rate(m, _u, net) {
    net.setSendInterval(m.sendMs);
  },

  // サーバーが断った自分の操作（上限超過・レート制限など）。自分の画面からだけ取り消す
  reject(m, u) {
    if (m.kind === "star") u.rollbackStar(m.id);
    else u.rollbackLink(m.id);
  },

  // 他の人の位置（まとめて届く）
  ps(m, u) {
    for (const [id, x, y, c] of m.d) {
      if (id === u.myId) continue; // 粗い一覧には自分も含まれる
      u.setPeer(id, x, y, c);
    }
  },

  star(m, u) {
    u.stars.set(m.id, m);
    if (u.ghosts.delete(m.id)) u.saveGhosts();
    u.pairsDirty = true;
  },

  unstar(m, u) {
    const s = u.stars.get(m.id);
    if (s && u.isMine(s)) {
      u.ghosts.set(m.id, { id: s.id, x: s.x, y: s.y, c: s.c, gone: Date.now() }); // 自分の星は幽霊になる
      u.saveGhosts();
    }
    u.stars.delete(m.id);
    u.dropLinksTouching(m.id);
    u.pairsDirty = true;
  },

  admire(m, u) {
    const s = u.stars.get(m.id);
    if (s) {
      s.ts = m.ts;
      s.flash = performance.now();
    }
  },

  link(m, u) {
    u.links.set(m.id, m);
  },

  unlink(m, u) {
    u.links.delete(m.id);
  },

  pulse(m, u) {
    u.addPulse(m.x, m.y, 0.8, PALETTES[m.c % PALETTES.length].glow);
  },

  leave(m, u) {
    u.peers.delete(m.id);
  },
};

// 受け取った文字列を、t を持つオブジェクトとしてだけ読む。壊れたもの・形の違うものは null
// （中身の詳しい検証はしない。送り手は自分たちのサーバーで、型は shared/protocol.ts で揃えている）
export function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== "string") return null;
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return null; // JSON でないものは無視する
  }
  if (typeof v !== "object" || v === null || Array.isArray(v) || !("t" in v) || typeof v.t !== "string") return null;
  return v as ServerMessage;
}

function isKnownType(t: string): t is ServerMessageType {
  return Object.hasOwn(serverHandlers, t);
}

export function handleServerMessage(m: ServerMessage, u: Universe, net: Network) {
  // 未知の種類（新しいサーバーと古いクライアントの組み合わせ）は無視する
  if (!isKnownType(m.t)) return;
  // m.t と serverHandlers[m.t] の引数の型の対応を TypeScript は追えない（相関ユニオンの制限）ので、
  // ここでだけ「全種類を受け取れる関数」として扱う。表は型で網羅されているので、実際の対応は崩れない
  const handler = serverHandlers[m.t] as (m: ServerMessage, u: Universe, net: Network) => void;
  handler(m, u, net);
}
