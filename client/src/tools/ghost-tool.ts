import type { Ghost } from "../universe";
import type { Tool, ToolContext, PointerInfo } from "./tool";

// お化け：なぞった幽霊（消えた自分の星の跡）を忘れる
export class GhostTool implements Tool {
  readonly name = "ghost";
  private batch: Ghost[] | null = null; // 押している間に忘れた幽霊（一つの履歴に束ねる）

  constructor(private ctx: ToolContext) {}

  down(p: PointerInfo) {
    this.batch = [];
    this.forgetAt(p);
  }
  move(p: PointerInfo, pressed: boolean): boolean {
    if (!this.batch || !pressed) return false;
    this.forgetAt(p); // なぞった幽霊を忘れていく
    return true;
  }
  up() {
    this.finish();
  }
  cancel() {
    this.finish();
  }

  private forgetAt(p: PointerInfo) {
    const g = this.ctx.hit.ghost(p.sx, p.sy, 18);
    if (!g) return;
    this.batch?.push({ ...g });
    this.ctx.universe.forgetGhost(g);
  }
  private finish() {
    const list = this.batch;
    this.batch = null;
    if (!list?.length) return;
    const { universe } = this.ctx;
    this.ctx.history.pushOp({
      undo: () => list.forEach((g) => universe.rememberGhost({ ...g })),
      redo: () => list.forEach((g) => universe.forgetGhost(g)),
      local: true, // サーバーへは何も送らないので、切断中でも戻せる
    });
  }
}
