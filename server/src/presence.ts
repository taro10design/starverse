// 位置の配信（誰に・何を送るか）の純粋な部品。Durable Object に依存しないので単体テストできる。
// 実際に送るのは room.ts。
//
// - 動いた人は、視界（余白つき）に入る相手にだけ、一定間隔で 1 通にまとめて送る（movedFrames）
// - 一定間隔で、視界外も含めた粗い一覧を全員に送る（coarseFrame。ミニマップ用）
// - 誰も動かない間はタイマーを止めて、Durable Object がハイバネートできるようにする（TickClock）

import type { PeerDot, PresenceTuple, View } from "../../shared/protocol";
import { LIMITS } from "./config";
import { inView } from "./spatial";

// 配信に使う 1 人ぶんの情報
export interface Peer {
  id: string;
  x: number;
  y: number;
  c: number;
  view: View | null; // 見ている範囲。null ならまだ送ってこない（全体を見ているとみなす）
}

export const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

const tupleOf = (p: Peer): PresenceTuple => [p.id, round4(p.x), round4(p.y), p.c];

// 人数が増えるほど配信の間隔を広げる（1 回の処理が間に合うように）
export function tickMsFor(n: number): number {
  for (const [upTo, ms] of LIMITS.tickMsByConnections) if (n <= upTo) return ms;
  return LIMITS.tickMs;
}

// tick ごとに何をするか。send の coarse は粗い一覧を送る回の番号（送らない回は null）
export type TickDecision = { do: "send"; coarse: number | null } | { do: "idle" } | { do: "sleep" };

// tick の回数と、誰も動かない回の数を数える
export class TickClock {
  private count = 0;
  private quiet = 0;

  next(anyMoved: boolean): TickDecision {
    this.count++;
    const coarse = this.count % LIMITS.coarseEveryTicks === 0 ? this.count / LIMITS.coarseEveryTicks : null;
    if (!anyMoved && coarse === null) {
      if (++this.quiet <= LIMITS.idleTicksBeforeSleep) return { do: "idle" };
      this.quiet = 0;
      return { do: "sleep" };
    }
    return { do: "send", coarse };
  }

  // 誰かが動いた。静かな回を数え直す
  wake() {
    this.quiet = 0;
  }
}

// welcome に載せる他の人（自分を除く。max 人まで）
export function welcomeDots(peers: Iterable<Peer>, self: Peer, max: number): PeerDot[] {
  const dots: PeerDot[] = [];
  for (const o of peers) {
    if (o === self) continue;
    if (dots.length >= max) break;
    dots.push({ id: o.id, x: round4(o.x), y: round4(o.y), c: o.c });
  }
  return dots;
}

// 粗い一覧は全員に同じ内容なので 1 回だけ作る。受け取った側は自分の id を無視する。
// 人数が max より多いときは、回（round）ごとに窓をずらして全員が順に載るようにする
export function coarseFrame(all: readonly Peer[], round: number, max: number): PresenceTuple[] {
  const offset = (round * max) % Math.max(1, all.length);
  const d: PresenceTuple[] = [];
  for (let k = 0; k < all.length && d.length < max; k++) d.push(tupleOf(all[(offset + k) % all.length]));
  return d;
}

// 位置の配信用グリッド。1 セル = ワールド座標 1（おおよそ 1 画面）
const CELL = 1;
const cellKey = (cx: number, cy: number) => cx * 1_000_000 + cy;

interface Entry<T> {
  peer: T;
  tuple: PresenceTuple;
}

// 動いた人をグリッドに入れて、各受信者は視界に重なるセルだけを見る。
// 戻り値は受信者ごとの 1 通ぶん（送るものが無い受信者は含めない）
export function movedFrames<T extends Peer>(
  all: readonly T[],
  moved: readonly T[],
  max: number,
): Map<T, PresenceTuple[]> {
  const grid = new Map<number, Entry<T>[]>();
  for (const o of moved) {
    const key = cellKey(Math.floor(o.x / CELL), Math.floor(o.y / CELL));
    const entry = { peer: o, tuple: tupleOf(o) };
    const bucket = grid.get(key);
    if (bucket) bucket.push(entry);
    else grid.set(key, [entry]);
  }
  const entries = [...grid.values()].flat();

  const out = new Map<T, PresenceTuple[]>();
  for (const me of all) {
    const d: PresenceTuple[] = [];
    for (const e of candidates(me.view, grid, entries)) {
      if (e.peer === me || !inView(me.view, e.peer.x, e.peer.y, LIMITS.viewMargin)) continue;
      d.push(e.tuple);
      if (d.length >= max) break;
    }
    if (d.length) out.set(me, d);
  }
  return out;
}

// 受信者の視界に重なるセルにいる人だけを返す。視界が広すぎるときは全員を調べるほうが速い
function candidates<T>(v: View | null, grid: Map<number, T[]>, all: T[]): T[] {
  if (!v) return all;
  const mx = (v[2] - v[0]) * LIMITS.viewMargin;
  const my = (v[3] - v[1]) * LIMITS.viewMargin;
  const cx0 = Math.floor((v[0] - mx) / CELL),
    cx1 = Math.floor((v[2] + mx) / CELL);
  const cy0 = Math.floor((v[1] - my) / CELL),
    cy1 = Math.floor((v[3] + my) / CELL);
  if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > grid.size) return all;
  const out: T[] = [];
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cy = cy0; cy <= cy1; cy++) {
      const bucket = grid.get(cellKey(cx, cy));
      if (bucket) out.push(...bucket);
    }
  }
  return out;
}
