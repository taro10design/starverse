import { snap } from "../util";
import type { Tool, ToolContext, PointerInfo } from "./tool";
import { deleteMine, placeAgain, removeById } from "./ops";
import type { StarSnap } from "./ops";

const STEP_PX = 10; // なぞる時、この距離ごとに星を置く
const MAX_PER_SEC = 20; // なぞりで置ける速さの上限（サーバーのレート制限に当たらないよう間引く）

// 星：空に星を置く（なぞると連続で置く）。自分の星の上なら消す、他人の星ならきらめき。
// 自分の星の上限（MAX_STARS_PER_USER）は Universe.placeStar が守る。
// ピンチの 1 本目の指で星を置かないよう、down は Input がピンチでない操作と確定してから呼ぶ（押した時点の位置で）
export class StarTool implements Tool {
  readonly name = "star";
  private batch: StarSnap[] | null = null; // ドラッグ中に置いた星（一つの履歴に束ねる）
  private lastPlaced: [number, number] | null = null; // 最後に置いたスクリーン座標
  private recent: number[] = []; // 直近 1 秒に置いた時刻（間引き用）

  constructor(private ctx: ToolContext) {}

  // 押した: 自分の星なら消す、他人の星ならきらめき、空なら置いてなぞりを始める。
  // 当たり判定は押した時点のワールド座標（p.wx / p.wy）で行う（確定までの間にカメラが動いてもずれない）
  down(p: PointerInfo) {
    this.finish(); // なぞりの途中の分は確定する
    if (!this.ctx.canEdit()) return;
    const { universe, hit, feedback } = this.ctx;
    const s = hit.star(p);
    if (s && universe.isMine(s)) {
      deleteMine(this.ctx, s); // 自分の星の上なら消す
    } else if (s) {
      universe.admire(s); // 他人の星に触れたらきらめきを送る
      feedback.ping();
    } else {
      this.batch = [];
      this.lastPlaced = [p.sx, p.sy]; // 置けなくても、なぞりの起点にはする
      this.place(p);
    }
  }
  move(p: PointerInfo, pressed: boolean): boolean {
    if (!pressed) return false;
    // なぞった軌道に沿って連続で星を置く
    const last = this.lastPlaced;
    if (this.batch && last && Math.hypot(p.sx - last[0], p.sy - last[1]) > STEP_PX && this.ctx.canEdit()) {
      if (this.place(p)) this.lastPlaced = [p.sx, p.sy];
    }
    return true;
  }
  up() {
    this.finish();
  }
  // ピンチ・ツール切替など。なぞりの途中は確定する
  cancel() {
    this.finish();
  }

  // 間引きと上限の範囲で 1 つ置く。置けたら true
  private place(p: PointerInfo): boolean {
    const now = Date.now();
    this.recent = this.recent.filter((t) => now - t < 1000);
    if (this.recent.length >= MAX_PER_SEC) return false;
    const ns = this.ctx.universe.placeStar(p.wx, p.wy, this.ctx.player.colorIndex);
    if (!ns) return false;
    this.recent.push(now);
    this.batch?.push(snap(ns));
    return true;
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
