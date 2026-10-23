import type { ToolName } from "./constants";
import type { DemoKind } from "./demo";

// ---------------------------------------------------------------------------
// Onboarding — 初めての人への 1 行の案内と、「?」を光らせるかどうか（docs/specs/0002-controls.md の 13a〜13c）
//
// 長い説明を最初に見せる代わりに、やってみる順に 1 行ずつ（見本の動きつきで）出す: 空をタップ → ✦ を選ぶ → 星を置く。
// 最後まで進めたら記録して、次からは出さない。DOM に触れない（表示は UI が onChange で行う）
// ---------------------------------------------------------------------------

type Step = "tap" | "pickStar" | "placeStar" | "done";

export const HINTS = {
  tap: "空をタップすると、光がそこへ向かう",
  pickStar: "左下の ✦ を選ぶと、星を置ける",
  placeStar: "タップで星を置く。なぞると続けて置ける",
} as const satisfies Record<Exclude<Step, "done">, string>;

// storage.ts と同じ形（テストではメモリ上の偽物を渡す）
export interface OnboardingStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const INTRO_DONE_KEY = "uchu-intro-done";
const HELP_SEEN_KEY = "uchu-help-seen";
const LEGACY_SEEN_KEY = "uchu-seen"; // 前の版の「説明パネルを見た」印。今は使わない

export class Onboarding {
  private step: Step;
  private helpSeen: boolean;

  constructor(
    private store: OnboardingStore,
    private onChange: () => void = () => undefined,
  ) {
    store.remove(LEGACY_SEEN_KEY);
    this.step = store.get(INTRO_DONE_KEY) ? "done" : "tap";
    this.helpSeen = store.get(HELP_SEEN_KEY) !== null;
  }

  // 今出す 1 行。案内が終わっていれば null
  get hint(): string | null {
    return this.step === "done" ? null : HINTS[this.step];
  }

  // 案内の横に出す見本の動き（「✦ を選ぶ」は見本ではなく、本物のボタンを光らせる）
  get demo(): DemoKind | null {
    return this.step === "tap" ? "tap" : this.step === "placeStar" ? "star" : null;
  }

  // 光らせて場所を知らせるツールボタン
  get beckon(): ToolName | null {
    return this.step === "pickStar" ? "star" : null;
  }

  // 「?」を光らせるか（一度開くまで）
  get pulseHelp(): boolean {
    return !this.helpSeen;
  }

  // キャンバスでポインタを離した（tap = ほとんど動かさずに離した）
  released(tool: ToolName, tap: boolean) {
    if (this.step === "tap" && tap) this.go("pickStar");
    else if (this.step === "placeStar" && tool === "star") this.go("done");
  }

  toolSelected(name: ToolName) {
    if (this.step === "done") return;
    if (name === "star") this.go("placeStar");
    else if (this.step === "placeStar") this.go("pickStar");
  }

  helpOpened() {
    if (this.helpSeen) return;
    this.helpSeen = true;
    this.store.set(HELP_SEEN_KEY, "1");
    this.onChange();
  }

  private go(step: Step) {
    if (step === this.step) return;
    this.step = step;
    if (step === "done") this.store.set(INTRO_DONE_KEY, "1");
    this.onChange();
  }
}
