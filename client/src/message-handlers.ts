// サーバーからのメッセージごとの処理。
// `serverHandlers` は ServerMessage の全種類を網羅しないと型エラーになる。
// 新しいメッセージを足すときは、shared/protocol.ts に型を足してからここに処理を書く。

import type { ServerMessage, ServerMessageType } from "../../shared/protocol";
import { PALETTES } from "./constants";
import type { Universe } from "./universe";

type Handler<K extends ServerMessageType> = (m: Extract<ServerMessage, { t: K }>, u: Universe) => void;

export const serverHandlers: { [K in ServerMessageType]: Handler<K> } = {
  welcome(m, u) {
    u.myId = m.id;
    for (const d of m.dots) u.peers.set(d.id, { x: d.x, y: d.y, rx: d.x, ry: d.y, c: d.c });
    for (const s of m.stars) {
      u.stars.set(s.id, s);
      u.ghosts.delete(s.id); // 生きてるなら幽霊は要らない
    }
    for (const l of m.links) u.links.set(l.id, l);
    u.pairsDirty = true;
  },

  // 他の人の位置（まとめて届く）
  ps(m, u) {
    for (const [id, x, y, c] of m.d) {
      const p = u.peers.get(id);
      if (p) {
        p.x = x;
        p.y = y;
        p.c = c;
      } else {
        u.peers.set(id, { x, y, rx: x, ry: y, c });
      }
    }
  },

  star(m, u) {
    u.stars.set(m.id, m);
    u.ghosts.delete(m.id);
    u.pairsDirty = true;
  },

  unstar(m, u) {
    const s = u.stars.get(m.id);
    if (s && s.by === u.uid) {
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

export function handleServerMessage(m: ServerMessage, u: Universe) {
  // 未知の種類（新しいサーバーと古いクライアントの組み合わせ）は無視する
  const handler = serverHandlers[m.t] as ((m: ServerMessage, u: Universe) => void) | undefined;
  handler?.(m, u);
}
