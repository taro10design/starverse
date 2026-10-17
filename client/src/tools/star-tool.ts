import { snap } from "../util";
import type { Tool, ToolContext, PointerInfo } from "./tool";
import { deleteMine, placeAgain, removeById } from "./ops";
import type { StarSnap } from "./ops";

const STEP_PX = 10; // なぞる時、この距離ごとに星を置く
const MAX_PER_SEC = 20; // なぞりで置ける速さの上限（サーバーのレート制限に当たらないよう間引く）
// 押してから、これだけ待つか・離すか・STEP_PX より動くまで、押した操作を確定しない。
// その間に 2 本目の指が来たら（ピンチ）、Input が cancel するので何もしない
const HOLD_MS = 120;

// 星：空に星を置く（なぞると連続で置く）。自分の星の上なら消す、他人の星ならきらめき。
// 自分の星の上限（MAX_STARS_PER_USER）は Universe.placeStar が守る
export class StarTool implements Tool {
  readonly name = "star";
  private pending: PointerInfo | null = null; // 押したが、まだ確定していない位置
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private batch: StarSnap[] | null = null; // ドラッグ中に置いた星（一つの履歴に束ねる）
  private lastPlaced: [number, number] | null = null; // 最後に置いたスクリーン座標
  private recent: number[] = []; // 直近 1 秒に置いた時刻（間引き用）

  constructor(private ctx: ToolContext) {}

  down(p: PointerInfo) {
    this.finish(); // なぞりの途中の分は確定し、まだ確定していない押下は捨てる
    if (!this.ctx.canEdit()) return;
    this.pending = p;
    this.holdTimer = setTimeout(() => this.commitDown(), HOLD_MS);
  }
  move(p: PointerInfo, pressed: boolean): boolean {
    if (!pressed) return false;
    const pd = this.pending;
    if (pd && Math.hypot(p.sx - pd.sx, p.sy - pd.sy) > STEP_PX) this.commitDown();
    // なぞった軌道に沿って連続で星を置く
    const last = this.lastPlaced;
    if (this.batch && last && Math.hypot(p.sx - last[0], p.sy - last[1]) > STEP_PX && this.ctx.canEdit()) {
      if (this.place(p)) this.lastPlaced = [p.sx, p.sy];
    }
    return true;
  }
  up() {
    this.commitDown();
    this.finish();
  }
  // ピンチ・ツール切替など。まだ確定していない押した操作は捨て、なぞりの途中は確定する
  cancel() {
    this.finish();
  }

  // 押した操作を確定する: 自分の星なら消す、他人の星ならきらめき、空なら置いてなぞりを始める
  private commitDown() {
    const p = this.pending;
    this.clearPending();
    if (!p || !this.ctx.canEdit()) return;
    const { universe, hit, feedback } = this.ctx;
    const s = hit.star(p.sx, p.sy);
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

  private clearPending() {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.pending = null;
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
    this.clearPending();
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
