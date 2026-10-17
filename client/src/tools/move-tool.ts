import type { Tool, ToolContext, PointerInfo } from "./tool";
import { deleteMine, removeById } from "./ops";

// 移動：押した所へ光が向かう。タップで自分の星を消す / 他人の星にきらめき / 幽霊を復活
export class MoveTool implements Tool {
  readonly name = "move";

  constructor(private ctx: ToolContext) {}

  down(p: PointerInfo) {
    this.ctx.player.target = { x: p.wx, y: p.wy };
  }
  move(): boolean {
    return false; // 光の追従は Input の既定動作に任せる
  }
  up(p: PointerInfo, tap: boolean) {
    if (!tap) return;
    const { universe, history, hit, feedback } = this.ctx;
    const s = hit.star(p.sx, p.sy, 20);
    if (s) {
      if (universe.isMine(s)) {
        deleteMine(this.ctx, s); // 自分の星をタップで消す
      } else {
        universe.admire(s); // 他人の星をタップできらめき
        feedback.ping();
      }
      return;
    }
    const g = hit.ghost(p.sx, p.sy);
    if (g) {
      const gg = { ...g };
      universe.reviveGhost(g); // 消えた自分の星はタップで復活
      feedback.ping();
      feedback.haptic();
      history.pushOp({
        undo: () => removeById(this.ctx, gg), // 幽霊に戻す
        redo: () => universe.reviveGhost(gg),
      });
    }
  }
  cancel() {
    // 途中の状態を持たないので何もしない
  }
}
