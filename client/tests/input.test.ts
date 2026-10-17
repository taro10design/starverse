import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import type { Input as InputClass } from "../src/input";
import type { KeyLike } from "../src/keys";

// ブラウザ API の最小限のスタブ（constants.ts / universe.ts / player.ts が読み込み時・実行時に使う）
const store = new Map<string, string>();
vi.stubGlobal("location", { search: "", hostname: "localhost", host: "localhost", port: "" });
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
});
vi.stubGlobal("performance", { now: () => 1234 });

let mod: {
  KeyState: typeof import("../src/keys").KeyState;
  Input: typeof InputClass;
  Camera: typeof import("../src/camera").Camera;
  Player: typeof import("../src/player").Player;
  Universe: typeof import("../src/universe").Universe;
  History: typeof import("../src/history").History;
  StarTool: typeof import("../src/tools/star-tool").StarTool;
};

beforeAll(async () => {
  mod = {
    KeyState: (await import("../src/keys")).KeyState,
    Input: (await import("../src/input")).Input,
    Camera: (await import("../src/camera")).Camera,
    Player: (await import("../src/player")).Player,
    Universe: (await import("../src/universe")).Universe,
    History: (await import("../src/history")).History,
    StarTool: (await import("../src/tools/star-tool")).StarTool,
  };
});

beforeEach(() => {
  vi.restoreAllMocks();
});

// キーイベントの形だけを作る
const key = (code: string, k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  code,
  key: k,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  target: null,
  ...mods,
});

describe("KeyState（キーの押下・解放は e.code で照合する）", () => {
  it("押している間だけパンする。Shift を挟んで離しても押しっぱなしにならない", () => {
    const k = new mod.KeyState();
    k.down(key("KeyA", "a"));
    expect(k.motion()).toEqual({ dx: 1, dy: 0, zoom: 0 });
    k.down(key("ShiftLeft", "Shift", { shiftKey: true }));
    expect(k.shift).toBe(true);
    k.up(key("KeyA", "A", { shiftKey: true })); // e.key は大文字になる
    expect(k.motion()).toEqual({ dx: 0, dy: 0, zoom: 0 });
    expect(k.active).toBe(false);
    k.up(key("ShiftLeft", "Shift"));
    expect(k.shift).toBe(false);
  });

  it("矢印・WASD・ズームキー（テンキーも）", () => {
    const k = new mod.KeyState();
    k.down(key("ArrowUp", "ArrowUp"));
    k.down(key("KeyD", "d"));
    k.down(key("NumpadAdd", "+"));
    expect(k.motion()).toEqual({ dx: -1, dy: 1, zoom: 1 });
    k.down(key("Minus", "-"));
    k.down(key("NumpadSubtract", "-"));
    expect(k.motion().zoom).toBe(-1);
    k.up(key("NumpadAdd", "+"));
    k.up(key("Minus", "-"));
    k.up(key("NumpadSubtract", "-"));
    k.down(key("Equal", "="));
    expect(k.motion().zoom).toBe(1);
  });

  it("JIS 配列の + （Shift+;）も拡大として押下中に保持し、同じ code の解放で止まる", () => {
    const k = new mod.KeyState();
    const r = k.down(key("Semicolon", "+", { shiftKey: true }));
    expect(r.preventDefault).toBe(true);
    expect(k.motion().zoom).toBe(1);
    k.up(key("Semicolon", ";"));
    expect(k.motion().zoom).toBe(0);
  });

  it("数字キーでツール、0 / Home で自分の光へ", () => {
    const k = new mod.KeyState();
    expect(k.down(key("Digit1", "1")).action).toEqual({ kind: "tool", name: "move" });
    expect(k.down(key("Numpad3", "3")).action).toEqual({ kind: "tool", name: "line" });
    expect(k.down(key("Digit5", "%", { shiftKey: true })).action).toEqual({ kind: "tool", name: "ghost" });
    expect(k.down(key("Digit0", "0")).action).toEqual({ kind: "focus" });
    expect(k.down(key("Home", "Home")).action).toEqual({ kind: "focus" });
  });

  it("Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y で undo / redo。Alt つきは扱わない", () => {
    const k = new mod.KeyState();
    expect(k.down(key("KeyZ", "z", { ctrlKey: true })).action).toEqual({ kind: "undo" });
    expect(k.down(key("KeyZ", "Z", { ctrlKey: true, shiftKey: true })).action).toEqual({ kind: "redo" });
    expect(k.down(key("KeyY", "y", { metaKey: true })).action).toEqual({ kind: "redo" });
    expect(k.down(key("KeyA", "a", { altKey: true })).action).toBeNull();
    expect(k.active).toBe(false);
  });

  it("Space: 押している間 spaceDown。ボタンや入力欄にフォーカスがあるときは preventDefault しない", () => {
    const k = new mod.KeyState();
    expect(k.down(key("Space", " ")).preventDefault).toBe(true);
    expect(k.spaceDown).toBe(true);
    k.up(key("Space", " "));
    expect(k.spaceDown).toBe(false);
    const onButton = k.down(key("Space", " ", { target: { tagName: "BUTTON" } as unknown as EventTarget }));
    expect(onButton.preventDefault).toBe(false);
    expect(k.spaceDown).toBe(false);
    const onInput = k.down(key("Space", " ", { target: { tagName: "INPUT" } as unknown as EventTarget }));
    expect(onInput.preventDefault).toBe(false);
  });

  it("releaseAll（ウィンドウの blur）で押しっぱなしを全部解除する", () => {
    const k = new mod.KeyState();
    k.down(key("KeyW", "w"));
    k.down(key("Space", " "));
    k.down(key("ShiftLeft", "Shift", { shiftKey: true }));
    k.releaseAll();
    expect(k.active).toBe(false);
    expect(k.spaceDown).toBe(false);
    expect(k.shift).toBe(false);
  });
});

// Input を App の最小の偽物で動かす
function setup() {
  store.clear();
  const camera = new mod.Camera();
  camera.resize(1000, 700);
  const player = new mod.Player();
  const universe = new mod.Universe(false, () => undefined);
  universe.ownerId = "me";
  const history = new mod.History(vi.fn());
  const canvas = {
    setPointerCapture: vi.fn(),
    addEventListener: vi.fn(),
    style: { cursor: "" },
  };
  const app = {
    canvas,
    camera,
    player,
    universe,
    history,
    network: { send: vi.fn() },
    ui: { ping: vi.fn(), haptic: vi.fn(), selectTool: vi.fn() },
    focusLight: vi.fn(),
    canEdit: () => true,
    undo: vi.fn(),
    redo: vi.fn(),
  };
  // Input は App のうち使う部分しか触らない。型だけ App として渡す
  const input = new mod.Input(app as unknown as App);
  const pe = (pointerId: number, x: number, y: number, button = 0) =>
    ({ pointerId, clientX: x, clientY: y, button, target: canvas }) as unknown as PointerEvent;
  return { input, app, canvas, universe, history, pe };
}

describe("Input（ポインタ）", () => {
  it("キャンバス上のポインタは全て setPointerCapture する", () => {
    const { input, canvas, pe } = setup();
    input.handlePointerDown(pe(1, 100, 100));
    input.handlePointerDown(pe(2, 200, 100));
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(1);
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(2);
  });

  it("2 本目の指でピンチが始まったらツールを cancel し、ピンチ後の up は呼ばない", () => {
    const cancel = vi.spyOn(mod.StarTool.prototype, "cancel");
    const up = vi.spyOn(mod.StarTool.prototype, "up");
    const { input, universe, pe } = setup();
    input.setTool("star");
    input.handlePointerDown(pe(1, 100, 100));
    expect(universe.stars.size).toBe(1);
    input.handlePointerDown(pe(2, 300, 100));
    expect(cancel).toHaveBeenCalledTimes(1);
    input.handlePointerMove(pe(1, 60, 100));
    input.handlePointerMove(pe(2, 400, 100));
    input.handlePointerUp(pe(2, 400, 100));
    input.handlePointerMove(pe(1, 20, 300)); // 残った指をなぞっても星は置かない
    input.handlePointerUp(pe(1, 20, 300));
    expect(up).not.toHaveBeenCalled();
    expect(universe.stars.size).toBe(1);
    // 全部の指が離れたら、次の操作は普通に効く
    input.handlePointerDown(pe(3, 500, 500));
    input.handlePointerUp(pe(3, 500, 500));
    expect(up).toHaveBeenCalledTimes(1);
    expect(universe.stars.size).toBe(2);
  });

  it("lostpointercapture で指を片付けてツールを cancel する（次のクリックがピンチ扱いにならない）", () => {
    const cancel = vi.spyOn(mod.StarTool.prototype, "cancel");
    const { input, universe, pe } = setup();
    input.setTool("star");
    input.handlePointerDown(pe(1, 100, 100));
    input.handleLostCapture(pe(1, 100, 100));
    expect(cancel).toHaveBeenCalledTimes(1);
    input.handlePointerDown(pe(2, 400, 400)); // ピンチなら星は置かれない
    expect(universe.stars.size).toBe(2);
  });

  it("普通に離したあとの lostpointercapture では cancel しない", () => {
    const cancel = vi.spyOn(mod.StarTool.prototype, "cancel");
    const { input, pe } = setup();
    input.setTool("star");
    input.handlePointerDown(pe(1, 100, 100));
    input.handlePointerUp(pe(1, 100, 100));
    input.handleLostCapture(pe(1, 100, 100));
    expect(cancel).not.toHaveBeenCalled();
  });

  it("ウィンドウの blur で指とキーを片付け、ツールを cancel する", () => {
    const cancel = vi.spyOn(mod.StarTool.prototype, "cancel");
    const { input, universe, app, pe } = setup();
    input.setTool("star");
    input.handlePointerDown(pe(1, 100, 100));
    input.handleKeyDown({ ...key("KeyW", "w"), preventDefault: vi.fn() } as unknown as KeyboardEvent);
    input.handleBlur();
    expect(cancel).toHaveBeenCalledTimes(1);
    const cx = app.camera.cx;
    input.update(1); // W はもう押されていない
    expect(app.camera.cx).toBe(cx);
    expect(app.camera.cy).toBe(0.5);
    input.handlePointerDown(pe(2, 400, 400));
    expect(universe.stars.size).toBe(2);
  });
});
