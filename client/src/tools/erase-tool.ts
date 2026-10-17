import { snap } from "../util";
import type { Tool, ToolContext, PointerInfo } from "./tool";
import { placeAgain, removeById } from "./ops";
import type { StarSnap } from "./ops";

// 消：なぞった星を消す（消モードは誰の星でも消せる）。
// 履歴に積むのは自分の星だけ。他人の星を undo で置き直すと持ち主が自分に移ってしまうので、戻さない
export class EraseTool implements Tool {
  readonly name = "erase";
  private batch: StarSnap[] | null = null; // 押している間に消した自分の星（一つの履歴に束ねる）

  constructor(private ctx: ToolContext) {}

  down(p: PointerInfo) {
    if (!this.ctx.canEdit()) return;
    this.batch = [];
    this.eraseAt(p);
  }
  move(p: PointerInfo, pressed: boolean): boolean {
    if (!this.batch || !pressed) return false;
    if (this.ctx.canEdit()) this.eraseAt(p); // なぞった星を消していく
    return true;
  }
  up() {
    this.finish();
  }
  cancel() {
    this.finish();
  }

  private eraseAt(p: PointerInfo) {
    const { universe, hit } = this.ctx;
    const s = hit.star(p.sx, p.sy, 16);
    if (!s) return;
    if (universe.isMine(s)) this.batch?.push(snap(s));
    universe.deleteStar(s);
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
