import { snap } from "../util";
import type { Star } from "../universe";
import type { ToolContext } from "./tool";

// ---------------------------------------------------------------------------
// 履歴まわりの小さな操作（ツール間で共有）
// ---------------------------------------------------------------------------
export type StarSnap = ReturnType<typeof snap>;

// 同じ id・位置・色で星を置き直す
export function placeAgain(ctx: ToolContext, st: StarSnap) {
  ctx.universe.placeStar(st.x, st.y, ctx.player.colorIndex, st);
}

// id の星がまだあれば消す
export function removeById(ctx: ToolContext, st: { id: string }, noGhost?: boolean) {
  const s = ctx.universe.stars.get(st.id);
  if (s) ctx.universe.deleteStar(s, noGhost);
}

// 自分の星を一つ消して、履歴に積む
export function deleteMine(ctx: ToolContext, s: Star) {
  const d = snap(s);
  ctx.universe.deleteStar(s);
  ctx.history.pushOp({
    undo: () => placeAgain(ctx, d),
    redo: () => removeById(ctx, d),
  });
}
