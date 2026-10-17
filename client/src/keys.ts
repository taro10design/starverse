import type { ToolName } from "./constants";

// ---------------------------------------------------------------------------
// KeyState — キーボードの押下状態（DOM に触らない純粋なロジック）
//
// 押しっぱなしのキーは e.code（物理キー）で照合する。e.key は Shift の有無で "a" / "A" のように
// 変わるので、押下と解放で食い違って押しっぱなしになる。
// Undo / Redo のような一回きりのショートカットは、配列に合わせて e.key で判定する。
// ---------------------------------------------------------------------------

// KeyboardEvent のうち使う部分
export interface KeyLike {
  code: string;
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

export type KeyAction = { kind: "undo" } | { kind: "redo" } | { kind: "focus" } | { kind: "tool"; name: ToolName };

export interface KeyResult {
  action: KeyAction | null;
  preventDefault: boolean;
}

interface Hold {
  dx: number;
  dy: number;
  zoom: number;
}

// 押している間パンする（矢印 / WASD）。dx, dy は画面が動く向き
const PAN_CODES: Record<string, Hold> = {
  ArrowLeft: { dx: 1, dy: 0, zoom: 0 },
  KeyA: { dx: 1, dy: 0, zoom: 0 },
  ArrowRight: { dx: -1, dy: 0, zoom: 0 },
  KeyD: { dx: -1, dy: 0, zoom: 0 },
  ArrowUp: { dx: 0, dy: 1, zoom: 0 },
  KeyW: { dx: 0, dy: 1, zoom: 0 },
  ArrowDown: { dx: 0, dy: -1, zoom: 0 },
  KeyS: { dx: 0, dy: -1, zoom: 0 },
};
const ZOOM_IN: Hold = { dx: 0, dy: 0, zoom: 1 };
const ZOOM_OUT: Hold = { dx: 0, dy: 0, zoom: -1 };
// 押している間ズームする（テンキーも）
const ZOOM_CODES: Record<string, Hold> = {
  Equal: ZOOM_IN,
  NumpadAdd: ZOOM_IN,
  Minus: ZOOM_OUT,
  NumpadSubtract: ZOOM_OUT,
};
const NONE: KeyResult = { action: null, preventDefault: false };
const TOOL_ORDER: ToolName[] = ["move", "star", "line", "erase", "ghost"];
const FOCUS_CODES = new Set(["Digit0", "Home"]);

// 1〜5 のキー（数字の段・テンキー）→ ツール
function toolFor(code: string): ToolName | null {
  const m = /^(?:Digit|Numpad)([1-5])$/.exec(code);
  return m ? TOOL_ORDER[Number(m[1]) - 1] : null;
}

// ボタン・入力欄にフォーカスがある（Space はそちらの操作に任せる）
function isFormControl(t: EventTarget | null): boolean {
  if (!t || !("tagName" in t) || typeof t.tagName !== "string") return false;
  if (["BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(t.tagName.toUpperCase())) return true;
  return "isContentEditable" in t && t.isContentEditable === true;
}

export class KeyState {
  spaceDown = false;
  shift = false; // 押している間はパンが速くなる
  private held = new Map<string, Hold>(); // 押されている code → 動き

  get active(): boolean {
    return this.held.size > 0;
  }

  down(e: KeyLike): KeyResult {
    this.shift = e.shiftKey;
    // ブラウザやOSのショートカットを邪魔しないよう、Ctrl / Alt / Meta つきは扱わない（Undo/Redo を除く）
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "z") return { action: { kind: e.shiftKey ? "redo" : "undo" }, preventDefault: true };
      if (k === "y") return { action: { kind: "redo" }, preventDefault: true };
      return NONE;
    }
    if (e.altKey) return NONE;

    if (e.code === "Space") {
      if (isFormControl(e.target)) return NONE;
      this.spaceDown = true;
      return { action: null, preventDefault: true };
    }
    // JIS 配列の + は Shift+; なので、code で見つからないときは e.key の + / - も拡大・縮小にする
    // （押下中は code で保持するので、解放の照合は code のまま）
    const hold =
      PAN_CODES[e.code] ?? ZOOM_CODES[e.code] ?? (e.key === "+" ? ZOOM_IN : e.key === "-" ? ZOOM_OUT : undefined);
    if (hold) {
      this.held.set(e.code, hold);
      return { action: null, preventDefault: true };
    }
    if (FOCUS_CODES.has(e.code)) return { action: { kind: "focus" }, preventDefault: true };
    const tool = toolFor(e.code);
    if (tool) return { action: { kind: "tool", name: tool }, preventDefault: false };
    return NONE;
  }

  up(e: KeyLike) {
    this.shift = e.shiftKey;
    if (e.code === "Space") this.spaceDown = false;
    this.held.delete(e.code);
  }

  // ウィンドウから離れたら押しっぱなしを解除する（keyup が届かないため）
  releaseAll() {
    this.held.clear();
    this.spaceDown = false;
    this.shift = false;
  }

  // 押されているキーの合計の向き（各成分は -1 / 0 / 1 の和）
  motion(): Hold {
    let dx = 0,
      dy = 0,
      zoom = 0;
    for (const h of this.held.values()) {
      dx += h.dx;
      dy += h.dy;
      zoom += h.zoom;
    }
    return { dx, dy, zoom };
  }
}
