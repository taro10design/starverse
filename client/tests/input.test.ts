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
  repeat: false,
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

  it("Ctrl+Z / Ctrl+Y の自動リピート（押しっぱなし）は無視する。既定の動作も止める", () => {
    const k = new mod.KeyState();
    expect(k.down(key("KeyZ", "z", { ctrlKey: true, repeat: true }))).toEqual({ action: null, preventDefault: true });
    expect(k.down(key("KeyY", "y", { ctrlKey: true, repeat: true }))).toEqual({ action: null, preventDefault: true });
    expect(k.down(key("KeyZ", "Z", { ctrlKey: true, shiftKey: true, repeat: true })).action).toBeNull();
    expect(k.down(key("KeyC", "c", { ctrlKey: true, repeat: true })).preventDefault).toBe(false); // 他のショートカットは邪魔しない
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
    ui: { ping: vi.fn(), haptic: vi.fn(), selectTool: vi.fn(), onboarding: { released: vi.fn() } },
    focusLight: vi.fn(),
    canEdit: () => true,
    undo: vi.fn(),
    redo: vi.fn(),
  };
  // Input は App のうち使う部分しか触らない。型だけ App として渡す
  const input = new mod.Input(app as unknown as App);
  const pe = (pointerId: number, x: number, y: number, button = 0, pointerType = "touch") =>
    ({ pointerId, clientX: x, clientY: y, button, pointerType, target: canvas }) as unknown as PointerEvent;
  return { input, app, canvas, universe, history, pe };
}

// 光を目標まで動かし終えたことにする
const arrive = (player: InstanceType<typeof mod.Player>) => {
  if (!player.target) throw new Error("目標がない");
  player.x = player.target.x;
  player.y = player.target.y;
};

describe("Input（ポインタ）", () => {
  it("マウスでは、カーソルが画面端にあっても視点は動かない（光がカーソルに着いても）", () => {
    const { input, app, pe } = setup();
    for (const [x, y] of [
      [995, 350],
      [5, 350],
      [500, 3],
      [500, 697],
    ]) {
      const { camera, player } = app;
      const [cx, cy] = [camera.cx, camera.cy];
      input.handlePointerMove(pe(1, x, y, 0, "mouse"));
      arrive(player); // 光がカーソルに着いた
      camera.follow(player);
      expect([camera.cx, camera.cy]).toEqual([cx, cy]);
    }
  });

  it("タッチでは、光が画面端に近づくと視点が寄り添う", () => {
    const { input, app, pe } = setup();
    const { camera, player } = app;
    input.handlePointerDown(pe(1, 500, 350));
    input.handlePointerMove(pe(1, 995, 350));
    arrive(player);
    camera.follow(player);
    expect(camera.cx).toBeGreaterThan(0.5);
  });

  it("キャンバス上のポインタは全て setPointerCapture する", () => {
    const { input, canvas, pe } = setup();
    input.handlePointerDown(pe(1, 100, 100));
    input.handlePointerDown(pe(2, 200, 100));
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(1);
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(2);
  });

  it("2 本目の指でピンチが始まったらツールを cancel し、ピンチ後の up は呼ばない（1 本目の星も置かない）", () => {
    const cancel = vi.spyOn(mod.StarTool.prototype, "cancel");
    const up = vi.spyOn(mod.StarTool.prototype, "up");
    const { input, universe, pe } = setup();
    input.setTool("star");
    input.handlePointerDown(pe(1, 100, 100));
    input.handlePointerDown(pe(2, 300, 100));
    expect(cancel).toHaveBeenCalledTimes(1);
    input.handlePointerMove(pe(1, 60, 100));
    input.handlePointerMove(pe(2, 400, 100));
    input.handlePointerUp(pe(2, 400, 100));
    input.handlePointerMove(pe(1, 20, 300)); // 残った指をなぞっても星は置かない
    input.handlePointerUp(pe(1, 20, 300));
    expect(up).not.toHaveBeenCalled();
    expect(universe.stars.size).toBe(0);
    // 全部の指が離れたら、次の操作は普通に効く
    input.handlePointerDown(pe(3, 500, 500));
    input.handlePointerUp(pe(3, 500, 500));
    expect(up).toHaveBeenCalledTimes(1);
    expect(universe.stars.size).toBe(1);
  });

  it("キャンバスで離したら、今のツールとタップかどうかを案内（Onboarding）に知らせる。ピンチの指では知らせない", () => {
    const { input, app, pe } = setup();
    input.handlePointerDown(pe(1, 100, 100));
    input.handlePointerUp(pe(1, 100, 100));
    expect(app.ui.onboarding.released).toHaveBeenLastCalledWith("move", true);
    input.setTool("star");
    input.handlePointerDown(pe(2, 100, 100));
    input.handlePointerMove(pe(2, 200, 100));
    input.handlePointerUp(pe(2, 200, 100));
    expect(app.ui.onboarding.released).toHaveBeenLastCalledWith("star", false);
    // ピンチ（2 本指）では知らせない
    input.handlePointerDown(pe(3, 100, 100));
    input.handlePointerDown(pe(4, 300, 100));
    input.handlePointerUp(pe(4, 300, 100));
    input.handlePointerUp(pe(3, 100, 100));
    expect(app.ui.onboarding.released).toHaveBeenCalledTimes(2);
  });

  it("lostpointercapture で指を片付けてツールを cancel する（次のクリックがピンチ扱いにならない）", () => {
    const cancel = vi.spyOn(mod.StarTool.prototype, "cancel");
    const { input, universe, pe } = setup();
    input.setTool("star");
    input.handlePointerDown(pe(1, 100, 100));
    input.handleLostCapture(pe(1, 100, 100));
    expect(cancel).toHaveBeenCalledTimes(1);
    input.handlePointerDown(pe(2, 400, 400)); // ピンチなら星は置かれない
    input.handlePointerUp(pe(2, 400, 400));
    expect(universe.stars.size).toBe(1);
  });

  it("追っている指の pointercancel ではツールを cancel する", () => {
    const cancel = vi.spyOn(mod.StarTool.prototype, "cancel");
    const { input, pe } = setup();
    input.setTool("star");
    input.handlePointerDown(pe(1, 100, 100));
    input.handlePointerCancel(pe(1, 100, 100));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("追っていない指の pointercancel ではツールを cancel しない", () => {
    const cancel = vi.spyOn(mod.StarTool.prototype, "cancel");
    const { input, universe, pe } = setup();
    input.setTool("star");
    input.handlePointerDown(pe(1, 100, 100));
    input.handlePointerCancel(pe(99, 0, 0)); // キャンバスの外のボタンなどで始まった指
    input.handlePointerCancel(pe(1, 100, 100)); // 片付け済みのあとに重ねて届いた
    input.handlePointerCancel(pe(1, 100, 100));
    expect(cancel).toHaveBeenCalledTimes(1);
    input.handlePointerDown(pe(2, 400, 400));
    input.handlePointerUp(pe(2, 400, 400));
    expect(universe.stars.size).toBe(1);
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
    input.handlePointerUp(pe(2, 400, 400));
    expect(universe.stars.size).toBe(1);
  });
});

describe("Input（押下の遅延確定。ピンチの 1 本目の指で操作しない）", () => {
  const pulses = (app: ReturnType<typeof setup>["app"]) =>
    app.network.send.mock.calls.filter(([m]) => (m as { t: string }).t === "pulse").length;

  it("消しゴム: 2 本目の指でピンチになったら、1 本目の下の星を消さない。pulse・音・振動も出さない", () => {
    vi.useFakeTimers();
    try {
      const { input, universe, app, pe } = setup();
      const [wx, wy] = app.camera.screenToWorld(100, 100);
      const s = universe.placeStar(wx, wy, 0);
      if (!s) throw new Error("星が置けない");
      input.setTool("erase");
      input.handlePointerDown(pe(1, 100, 100));
      input.handlePointerDown(pe(2, 300, 100));
      vi.advanceTimersByTime(1000);
      input.handlePointerUp(pe(2, 300, 100));
      input.handlePointerUp(pe(1, 100, 100));
      expect(universe.stars.has(s.id)).toBe(true);
      expect(pulses(app)).toBe(0);
      expect(app.ui.ping).not.toHaveBeenCalled();
      expect(app.ui.haptic).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("消しゴム: すぐ離したら（タップ）押した所の星を消し、pulse・音・振動を 1 回ずつ出す", () => {
    const { input, universe, app, pe } = setup();
    const [wx, wy] = app.camera.screenToWorld(100, 100);
    const s = universe.placeStar(wx, wy, 0);
    if (!s) throw new Error("星が置けない");
    input.setTool("erase");
    input.handlePointerDown(pe(1, 100, 100));
    expect(universe.stars.has(s.id)).toBe(true); // まだ確定していない
    input.handlePointerUp(pe(1, 100, 100));
    expect(universe.stars.has(s.id)).toBe(false);
    expect(pulses(app)).toBe(1);
    expect(app.network.send).toHaveBeenCalledWith({ t: "pulse", x: wx, y: wy });
    expect(app.ui.ping).toHaveBeenCalledTimes(1);
    expect(app.ui.haptic).toHaveBeenCalledTimes(1);
  });

  it("120ms 押し続けたら確定する（ツールの種類によらない）", () => {
    vi.useFakeTimers();
    try {
      const { input, universe, app, pe } = setup();
      const [wx, wy] = app.camera.screenToWorld(100, 100);
      const s = universe.placeStar(wx, wy, 0);
      if (!s) throw new Error("星が置けない");
      input.setTool("erase");
      input.handlePointerDown(pe(1, 100, 100));
      vi.advanceTimersByTime(119);
      expect(universe.stars.has(s.id)).toBe(true);
      expect(pulses(app)).toBe(0);
      vi.advanceTimersByTime(1);
      expect(universe.stars.has(s.id)).toBe(false);
      expect(pulses(app)).toBe(1);
      input.handlePointerDown(pe(2, 300, 100)); // 確定したあとの 2 本目は、ツールを止めるだけ
      input.handlePointerUp(pe(2, 300, 100));
      input.handlePointerUp(pe(1, 100, 100));
      expect(pulses(app)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("10px 以内の動きでは確定せず、10px を超えたら押した所で確定してからなぞりを続ける", () => {
    const { input, universe, app, pe } = setup();
    input.setTool("star");
    const [wx0] = app.camera.screenToWorld(100, 100);
    input.handlePointerDown(pe(1, 100, 100));
    input.handlePointerMove(pe(1, 108, 100));
    expect(universe.stars.size).toBe(0);
    expect(pulses(app)).toBe(0);
    input.handlePointerMove(pe(1, 112, 100));
    expect(pulses(app)).toBe(1);
    const xs = [...universe.stars.values()].map((s) => s.x);
    expect(xs[0]).toBe(wx0); // 押した所
    expect(universe.stars.size).toBe(2); // 続けてなぞった所にも置く
    input.handlePointerUp(pe(1, 112, 100));
  });

  it("星ツール: 確定までの間にカメラが動いても、押した時点の位置に置く", () => {
    vi.useFakeTimers();
    try {
      const { input, universe, app, pe } = setup();
      input.setTool("star");
      const [wx, wy] = app.camera.screenToWorld(300, 300);
      input.handlePointerDown(pe(1, 300, 300));
      app.camera.pan(200, 0);
      vi.advanceTimersByTime(120);
      expect([...universe.stars.values()]).toMatchObject([{ x: wx, y: wy }]);
      input.handlePointerUp(pe(1, 300, 300));
    } finally {
      vi.useRealTimers();
    }
  });

  it("確定前の指が lostpointercapture / blur で片付いたら、何も起こさない", () => {
    vi.useFakeTimers();
    try {
      const { input, universe, app, pe } = setup();
      input.setTool("star");
      input.handlePointerDown(pe(1, 100, 100));
      input.handleLostCapture(pe(1, 100, 100));
      input.handlePointerDown(pe(2, 200, 200));
      input.handleBlur();
      vi.advanceTimersByTime(1000);
      expect(universe.stars.size).toBe(0);
      expect(pulses(app)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
