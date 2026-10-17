import { snap } from "../util";
import type { Tool, ToolContext, PointerInfo } from "./tool";
import { placeAgain, removeById } from "./ops";
import type { StarSnap } from "./ops";

// 消：なぞった星を消す（消モードは誰の星でも消せる）
export class EraseTool implements Tool {
  readonly name = "erase";
  private batch: StarSnap[] | null = null; // 押している間に消した星（一つの履歴に束ねる）

  constructor(private ctx: ToolContext) {}

  down(p: PointerInfo) {
    this.batch = [];
    this.eraseAt(p);
  }
  move(p: PointerInfo, pressed: boolean): boolean {
    if (!this.batch || !pressed) return false;
    this.eraseAt(p); // なぞった星を消していく
    return true;
  }
  up() {
    this.finish();
  }
  cancel() {
    this.finish();
  }

  private eraseAt(p: PointerInfo) {
    const s = this.ctx.hit.star(p.sx, p.sy, 16);
    if (!s) return;
    this.batch?.push(snap(s));
    this.ctx.universe.deleteStar(s);
  }
  private finish() {
    const list = this.batch;
    this.batch = null;
    if (!list?.length) return;
    this.ctx.history.pushOp({
      undo: () => list.forEach((st) => placeAgain(this.ctx, st)),
      redo: () => list.forEach((st) => removeById(this.ctx, st)),
    });
  }
}
