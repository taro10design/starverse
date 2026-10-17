import type { ToolName } from "../constants";
import type { Camera } from "../camera";
import type { Player } from "../player";
import type { Universe, Star } from "../universe";
import type { History } from "../history";
import type { HitTester } from "./hit";

// ---------------------------------------------------------------------------
// Tool — ツールごとのポインタ操作（Strategy）。Input は振り分けだけを持つ
// ---------------------------------------------------------------------------

// ポインタの位置（スクリーン座標とワールド座標）
export interface PointerInfo {
  sx: number;
  sy: number;
  wx: number;
  wy: number;
}

// 引き途中の線（描画用）
export interface LinkPreview {
  from: Star;
  tip: readonly [number, number]; // 先端（ワールド座標）
}

// 音と振動。UI は App の後ろの方で作られるので、呼ぶ時に解決する
export interface Feedback {
  ping(): void;
  haptic(): void;
}

// ツールが触ってよいもの（App 全体は渡さない）
export interface ToolContext {
  camera: Camera;
  player: Player;
  universe: Universe;
  history: History;
  hit: HitTester;
  feedback: Feedback;
  // サーバーへ送る操作（星・線・消去・きらめき）をしてよいか。オンラインで接続が切れている間は false。ソロは常に true
  canEdit(): boolean;
}

export interface Tool {
  readonly name: ToolName;
  down(p: PointerInfo): void;
  // 消費したら true。true なら Input は「光が追従する」既定動作をしない
  move(p: PointerInfo, pressed: boolean): boolean;
  // tap でなくても必ず呼ばれる（ドラッグ中の操作をここで履歴に確定する）
  up(p: PointerInfo, tap: boolean): void;
  // 中断（pointercancel・ツール切替）。途中の操作は確定して状態を消す
  cancel(): void;
  linkPreview?(): LinkPreview | null;
}
