import type { Star } from "../universe";
import type { Tool, ToolContext, PointerInfo, LinkPreview } from "./tool";

// 線：星から星へドラッグして線を引く。空を掴んだら普通に動く。
// 接続が切れている間は線を引かず、普通に動く。自分の線の上限（MAX_LINKS_PER_USER）は Universe.addLink が守る
export class LineTool implements Tool {
  readonly name = "line";
  private from: Star | null = null; // 線を引き始めた星
  private tip: [number, number] | null = null; // 引き途中の先端（ワールド座標）

  constructor(private ctx: ToolContext) {}

  down(p: PointerInfo) {
    const s = this.ctx.canEdit() ? this.ctx.hit.star(p.sx, p.sy) : null;
    if (s) {
      this.from = s;
      this.tip = [p.wx, p.wy];
    } else {
      this.ctx.player.target = { x: p.wx, y: p.wy }; // 空を掴んだら普通に動く
    }
  }
  move(p: PointerInfo): boolean {
    if (!this.from) return false;
    this.tip = [p.wx, p.wy];
    return true;
  }
  up(p: PointerInfo) {
    const from = this.from;
    this.cancel();
    if (!from || !this.ctx.canEdit()) return; // 引いている途中で切れたら引かない
    const { universe, history, hit, feedback } = this.ctx;
    const b = hit.star(p.sx, p.sy, 22, from.id);
    if (!b) return;
    const l = universe.addLink(from.id, b.id);
    if (!l) return; // 同じ2点の線はもうある・上限に達している
    feedback.ping();
    history.pushOp({
      undo: () => universe.removeLink(l.id),
      redo: () => universe.restoreLink(l),
    });
  }
  cancel() {
    this.from = null;
    this.tip = null;
  }
  linkPreview(): LinkPreview | null {
    return this.from && this.tip ? { from: this.from, tip: this.tip } : null;
  }
}
