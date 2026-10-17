import { snap } from "../util";
import type { Tool, ToolContext, PointerInfo } from "./tool";
import { deleteMine, placeAgain, removeById } from "./ops";
import type { StarSnap } from "./ops";

const STEP_PX = 10; // なぞる時、この距離ごとに星を置く

// 星：空に星を置く（なぞると連続で置く）。自分の星の上なら消す、他人の星ならきらめき
export class StarTool implements Tool {
  readonly name = "star";
  private batch: StarSnap[] | null = null; // ドラッグ中に置いた星（一つの履歴に束ねる）
  private lastPlaced: [number, number] | null = null; // 最後に置いたスクリーン座標

  constructor(private ctx: ToolContext) {}

  down(p: PointerInfo) {
    const { universe, player, hit, feedback } = this.ctx;
    const s = hit.star(p.sx, p.sy);
    if (s && universe.isMine(s)) {
      deleteMine(this.ctx, s); // 自分の星の上なら消す
    } else if (s) {
      universe.admire(s); // 他人の星に触れたらきらめきを送る
      feedback.ping();
    } else {
      const ns = universe.placeStar(p.wx, p.wy, player.colorIndex);
      this.batch = [snap(ns)];
      this.lastPlaced = [p.sx, p.sy];
    }
  }
  move(p: PointerInfo, pressed: boolean): boolean {
    if (!pressed) return false;
    // なぞった軌道に沿って連続で星を置く
    const last = this.lastPlaced;
    if (last && Math.hypot(p.sx - last[0], p.sy - last[1]) > STEP_PX) {
      const ns = this.ctx.universe.placeStar(p.wx, p.wy, this.ctx.player.colorIndex);
      this.batch?.push(snap(ns));
      this.lastPlaced = [p.sx, p.sy];
    }
    return true;
  }
  up() {
    this.finish();
  }
  cancel() {
    this.finish();
  }

  private finish() {
    const list = this.batch;
    this.batch = null;
    this.lastPlaced = null;
    if (!list?.length) return;
    this.ctx.history.pushOp({
      undo: () => list.forEach((st) => removeById(this.ctx, st, true)),
      redo: () => list.forEach((st) => placeAgain(this.ctx, st)),
    });
  }
}
