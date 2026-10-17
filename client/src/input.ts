import type { ToolName } from "./constants";
import { mid, dist } from "./util";
import type { Point } from "./util";
import type { App } from "./app";
import { createTools, HitTester } from "./tools";
import type { Tool, PointerInfo, LinkPreview } from "./tools";

interface PinchState {
  d0: number;
  z0: number;
  wx: number;
  wy: number;
}

// ---------------------------------------------------------------------------
// Input — ポインタ / タッチ / キーボード
// ---------------------------------------------------------------------------
// ポインタの振り分け（ピンチ・パン・ミニマップ・キー・ホイール）だけを持ち、
// ツールごとの操作は tools/ の各クラスに任せる

export class Input {
  private tools: Record<ToolName, Tool>;
  private current: Tool;

  private pointers = new Map<number, Point>();
  private pinch: PinchState | null = null;
  private mapDrag = false;
  private downX = 0;
  private downY = 0;
  private downTarget: EventTarget | null = null;
  // PC 向けのカメラ操作
  private panning: { id: number; sx: number; sy: number; cx: number; cy: number } | null = null;
  private spaceDown = false;
  private shiftHeld = false; // 押している間はパンが速くなる
  private keys = new Set<string>(); // 押されている間パンやズームを続けるキー

  constructor(private app: App) {
    const { camera, player, universe, history } = app;
    this.tools = createTools({
      camera,
      player,
      universe,
      history,
      hit: new HitTester(camera, universe),
      // ui は Input より後に作られるので、呼ぶ時に解決する
      feedback: { ping: () => app.ui.ping(), haptic: () => app.ui.haptic() },
    });
    this.current = this.tools.move;
  }

  get tool(): ToolName {
    return this.current.name;
  }
  // 引き途中の線（描画用）
  get linkPreview(): LinkPreview | null {
    return this.current.linkPreview?.() ?? null;
  }

  bind() {
    addEventListener("pointerdown", (e) => this.handlePointerDown(e));
    addEventListener("pointermove", (e) => this.handlePointerMove(e));
    addEventListener("pointerup", (e) => this.handlePointerUp(e));
    addEventListener("pointercancel", (e) => this.handlePointerCancel(e));
    addEventListener("wheel", (e) => this.handleWheel(e), { passive: false });
    addEventListener("keydown", (e) => this.handleKeyDown(e));
    addEventListener("keyup", (e) => this.handleKeyUp(e));
    addEventListener("blur", () => this.releaseKeys()); // ウィンドウから離れたら押しっぱなしを解除
    // 中ボタンの自動スクロールを止める
    this.app.canvas.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    addEventListener("contextmenu", (e) => e.preventDefault());
  }

  setTool(name: ToolName) {
    if (name === this.current.name) return;
    this.current.cancel(); // 途中の操作は確定してから切り替える
    this.current = this.tools[name];
  }
  startMapDrag(e: MouseEvent) {
    this.mapDrag = true;
    this.moveToMap(e.offsetX, e.offsetY);
    this.app.camera.free = false;
  }
  moveToMap(mx: number, my: number) {
    const [wx, wy] = this.app.renderer.mapToWorld(mx, my);
    this.app.player.target = { x: wx, y: wy };
  }

  private pointerInfo(e: PointerEvent): PointerInfo {
    const [wx, wy] = this.app.camera.screenToWorld(e.clientX, e.clientY);
    return { sx: e.clientX, sy: e.clientY, wx, wy };
  }

  handlePointerDown(e: PointerEvent) {
    const { camera, universe, player, network, ui } = this.app;
    this.downTarget = e.target;
    if (e.target !== this.app.canvas) return;
    // Space+ドラッグ / 中ボタン / 右ボタンのドラッグで視点を動かす
    if (e.button === 1 || e.button === 2 || (e.button === 0 && this.spaceDown)) {
      this.panning = { id: e.pointerId, sx: e.clientX, sy: e.clientY, cx: camera.cx, cy: camera.cy };
      this.app.canvas.setPointerCapture?.(e.pointerId);
      this.updateCursor();
      return;
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const m = mid(a, b);
      const [wx, wy] = camera.screenToWorld(m.x, m.y);
      this.pinch = { d0: dist(a, b), z0: camera.z, wx, wy };
      return;
    }
    const p = this.pointerInfo(e);
    this.downX = e.clientX;
    this.downY = e.clientY;
    universe.addPulse(p.wx, p.wy, 1, player.palette.glow);
    network.send({ t: "pulse", x: p.wx, y: p.wy, c: player.colorIndex });
    ui.ping();
    ui.haptic();
    this.current.down(p);
  }

  handlePointerMove(e: PointerEvent) {
    const { camera, player } = this.app;
    if (this.mapDrag) {
      const r = this.app.ui.mapEl.getBoundingClientRect();
      this.moveToMap(e.clientX - r.left, e.clientY - r.top);
      return;
    }
    if (this.panning) {
      const s = camera.scalePx();
      camera.cx = this.panning.cx - (e.clientX - this.panning.sx) / s;
      camera.cy = this.panning.cy - (e.clientY - this.panning.sy) / s;
      camera.free = true;
      return;
    }
    const pt = this.pointers.get(e.pointerId);
    if (pt) {
      pt.x = e.clientX;
      pt.y = e.clientY;
    }
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const m = mid(a, b);
      camera.setZoom(this.pinch.z0 * (dist(a, b) / this.pinch.d0));
      camera.anchor(this.pinch.wx, this.pinch.wy, m.x, m.y);
      return;
    }
    const p = this.pointerInfo(e);
    if (this.current.move(p, pt !== undefined)) return;
    if (this.pointers.size <= 1) {
      player.target = { x: p.wx, y: p.wy };
      camera.free = false;
    }
  }

  handlePointerUp(e: PointerEvent) {
    if (this.panning && e.pointerId === this.panning.id) {
      this.panning = null;
      this.updateCursor();
      return;
    }
    const wasPinch = this.pinch !== null;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    this.mapDrag = false;

    // タップ＝ピンチでなく・他の指もなく・キャンバス上で押して・ほとんど動いていない
    const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
    const tap = !wasPinch && this.pointers.size === 0 && this.downTarget === this.app.canvas && moved <= 12;
    this.current.up(this.pointerInfo(e), tap); // tap でなくても呼ぶ（ドラッグ中の操作を確定する）
  }

  handlePointerCancel(e: PointerEvent) {
    if (this.panning && e.pointerId === this.panning.id) {
      this.panning = null;
      this.updateCursor();
    }
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    this.mapDrag = false;
    this.current.cancel();
  }

  handleWheel(e: WheelEvent) {
    if (e.target !== this.app.canvas) return;
    e.preventDefault();
    this.app.camera.zoomAt(Math.exp(-e.deltaY * 0.0012), e.clientX, e.clientY);
  }

  // --- キーボード ---
  // 矢印 / WASD でパン（Shift で速く）、+ / - でズーム、0 で自分の光に戻る、1〜5 でツール、Space+ドラッグでパン。
  // ブラウザやOSのショートカットを邪魔しないよう、Ctrl / Alt / Meta つきは扱わない（Undo/Redo を除く）
  handleKeyDown(e: KeyboardEvent) {
    this.shiftHeld = e.shiftKey;
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "z") {
        e.preventDefault();
        if (e.shiftKey) this.app.history.redo();
        else this.app.history.undo();
      } else if (k === "y") {
        e.preventDefault();
        this.app.history.redo();
      }
      return;
    }
    if (e.altKey) return;

    const key = e.key.toLowerCase();
    if (key === " ") {
      e.preventDefault();
      this.spaceDown = true;
      this.updateCursor();
    } else if (PAN_KEYS.has(key) || ZOOM_KEYS.has(key)) {
      e.preventDefault();
      this.keys.add(key);
    } else if (key === "0" || key === "home") {
      e.preventDefault();
      this.app.focusLight();
    } else if (/^[1-5]$/.test(key)) {
      this.app.ui.selectTool(TOOL_ORDER[Number(key) - 1]);
    }
  }

  handleKeyUp(e: KeyboardEvent) {
    this.shiftHeld = e.shiftKey;
    const key = e.key.toLowerCase();
    if (key === " ") {
      this.spaceDown = false;
      this.updateCursor();
    }
    this.keys.delete(key);
  }

  private releaseKeys() {
    this.keys.clear();
    this.spaceDown = false;
    this.updateCursor();
  }

  // 押されているキーに応じて、毎フレーム視点を動かす
  update(dt: number) {
    if (!this.keys.size) return;
    const { camera } = this.app;
    const seconds = dt * (1 / 60);
    const fast = this.shiftHeld ? 2.5 : 1;
    const step = KEY_PAN_PX_PER_SEC * fast * seconds;
    let dx = 0,
      dy = 0,
      zoom = 0;
    for (const k of this.keys) {
      if (k === "arrowleft" || k === "a") dx += step;
      else if (k === "arrowright" || k === "d") dx -= step;
      else if (k === "arrowup" || k === "w") dy += step;
      else if (k === "arrowdown" || k === "s") dy -= step;
      else if (k === "+" || k === "=" || k === "add") zoom += 1;
      else if (k === "-" || k === "_" || k === "subtract") zoom -= 1;
    }
    if (dx || dy) camera.pan(dx, dy);
    if (zoom) camera.zoomBy(Math.exp(zoom * KEY_ZOOM_PER_SEC * seconds));
  }

  // Space を押している間・ドラッグ中は手のカーソルにする（普通は光が主役なのでカーソルは隠す）
  private updateCursor() {
    this.app.canvas.style.cursor = this.panning ? "grabbing" : this.spaceDown ? "grab" : "";
  }
}

const PAN_KEYS = new Set(["arrowleft", "arrowright", "arrowup", "arrowdown", "w", "a", "s", "d"]);
const ZOOM_KEYS = new Set(["+", "=", "-", "_", "add", "subtract"]); // 数字キーパッドも含む
const TOOL_ORDER: ToolName[] = ["move", "star", "line", "erase", "ghost"];
const KEY_PAN_PX_PER_SEC = 480; // Leaflet の矢印 1 回 80px を、押している間の連続移動にした値
const KEY_ZOOM_PER_SEC = 1.4;
