import type { ToolName } from "./constants";
import { mid, dist } from "./util";
import type { Point } from "./util";
import type { App } from "./app";
import { createTools, HitTester } from "./tools";
import type { Tool, PointerInfo, LinkPreview } from "./tools";
import { KeyState } from "./keys";

// 押したが、まだツールに渡していない 1 本目の指
interface PendingDown {
  id: number;
  p: PointerInfo; // 押した時点の位置（ツールにはこの位置を渡す）
  timer: ReturnType<typeof setTimeout>;
}

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
// ツールごとの操作は tools/ の各クラスに任せる。キーの押下状態は keys.ts の KeyState が持つ。
//
// キャンバス上のポインタは全て setPointerCapture する（ウィンドウの外で離しても pointerup が届く）。
// それでも取りこぼした指（lostpointercapture・blur）は片付けて、ツールを cancel する。
//
// 1 本目の指の押下は、すぐにはツールに渡さない（遅延確定）。離す・COMMIT_MOVE_PX より動く・COMMIT_HOLD_MS
// 待つ、のどれかで「ピンチでない操作」と確定してから、押した時点の位置で tool.down と波紋・音・振動を出す。
// その前に 2 本目の指が来たら（ピンチ）、何もしない。ツールの種類によらない（星を置く・消しゴムで消す・
// pulse を送る、をピンチの指で起こさない）

export class Input {
  private tools: Record<ToolName, Tool>;
  private current: Tool;

  private pointers = new Map<number, Point>();
  private pinch: PinchState | null = null;
  private pending: PendingDown | null = null;
  // ピンチが始まったジェスチャー。全部の指が離れるまでツールに up を渡さない
  private gestureCancelled = false;
  private mapDrag = false;
  private downX = 0;
  private downY = 0;
  private downTarget: EventTarget | null = null;
  // PC 向けのカメラ操作
  private panning: { id: number; sx: number; sy: number; cx: number; cy: number } | null = null;
  private keys = new KeyState();

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
      canEdit: () => app.canEdit(),
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
    const { canvas } = this.app;
    addEventListener("pointerdown", (e) => this.handlePointerDown(e));
    addEventListener("pointermove", (e) => this.handlePointerMove(e));
    addEventListener("pointerup", (e) => this.handlePointerUp(e));
    addEventListener("pointercancel", (e) => this.handlePointerCancel(e));
    canvas.addEventListener("lostpointercapture", (e) => this.handleLostCapture(e));
    addEventListener("wheel", (e) => this.handleWheel(e), { passive: false });
    addEventListener("keydown", (e) => this.handleKeyDown(e));
    addEventListener("keyup", (e) => this.handleKeyUp(e));
    addEventListener("blur", () => this.handleBlur()); // ウィンドウから離れたら押しっぱなしを解除
    // 中ボタンの自動スクロールを止める
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    addEventListener("contextmenu", (e) => e.preventDefault());
  }

  setTool(name: ToolName) {
    if (name === this.current.name) return;
    this.commitPending(); // 押したばかりの操作は、前のツールで確定する
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
    const { camera, canvas } = this.app;
    this.downTarget = e.target;
    if (e.target !== canvas) return;
    canvas.setPointerCapture(e.pointerId);
    // Space+ドラッグ / 中ボタン / 右ボタンのドラッグで視点を動かす
    if (e.button === 1 || e.button === 2 || (e.button === 0 && this.keys.spaceDown)) {
      this.panning = { id: e.pointerId, sx: e.clientX, sy: e.clientY, cx: camera.cx, cy: camera.cy };
      this.updateCursor();
      return;
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size >= 2) {
      // 2 本目の指でピンチが始まった。まだ確定していない 1 本目の押下は捨てる。
      // 確定済みの操作は確定して止め、離したときの up も渡さない
      this.clearPending();
      if (!this.gestureCancelled) this.current.cancel();
      this.gestureCancelled = true;
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const m = mid(a, b);
        const [wx, wy] = camera.screenToWorld(m.x, m.y);
        this.pinch = { d0: dist(a, b), z0: camera.z, wx, wy };
      }
      return;
    }
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.clearPending();
    this.pending = {
      id: e.pointerId,
      p: this.pointerInfo(e),
      timer: setTimeout(() => this.commitPending(), COMMIT_HOLD_MS),
    };
  }

  // 押下を「ピンチでない操作」として確定し、押した時点の位置でツールに渡す
  private commitPending() {
    const pd = this.pending;
    if (!pd) return;
    this.clearPending();
    const { universe, player, network, ui } = this.app;
    const { p } = pd;
    universe.addPulse(p.wx, p.wy, 1, player.palette.glow);
    network.send({ t: "pulse", x: p.wx, y: p.wy });
    ui.ping();
    ui.haptic();
    this.current.down(p);
  }

  private clearPending() {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
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
    if (this.pending?.id === e.pointerId) {
      // 確定前の小さな動きは、ツールにも光にも渡さない。大きく動いたら確定してから続ける
      if (Math.hypot(e.clientX - this.downX, e.clientY - this.downY) <= COMMIT_MOVE_PX) return;
      this.commitPending();
    }
    const p = this.pointerInfo(e);
    // ピンチのあと残った指は、ツールには渡さず光を動かすだけにする
    if (!this.gestureCancelled && this.current.move(p, pt !== undefined)) return;
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
    const wasPressed = this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    this.mapDrag = false;
    if (this.gestureCancelled) {
      if (this.pointers.size === 0) this.gestureCancelled = false;
      return;
    }
    if (!wasPressed) return; // キャンバスの外で始まった操作（ボタンなど）や、片付け済みの指
    if (this.pending?.id === e.pointerId) this.commitPending(); // すぐ離した（タップ）

    // タップ＝他の指もなく・キャンバス上で押して・ほとんど動いていない
    const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
    const tap = this.pointers.size === 0 && this.downTarget === this.app.canvas && moved <= 12;
    this.current.up(this.pointerInfo(e), tap); // tap でなくても呼ぶ（ドラッグ中の操作を確定する）
    this.app.ui.onboarding.released(this.tool, tap);
  }

  // 追っていない指（キャンバスの外で始まった・片付け済み）の中断では、ツールの操作を止めない
  handlePointerCancel(e: PointerEvent) {
    if (this.isTracked(e.pointerId)) this.releasePointer(e.pointerId);
  }

  // キャプチャが外れた。普通に離したあと（pointerup で片付け済み）なら何もしない
  handleLostCapture(e: PointerEvent) {
    if (this.isTracked(e.pointerId)) this.releasePointer(e.pointerId);
  }

  private isTracked(id: number): boolean {
    return this.pointers.has(id) || this.panning?.id === id;
  }

  // ウィンドウから離れた。押していた指・キーは離したことにする（離した通知が届かないため）
  handleBlur() {
    const had = this.pointers.size > 0 || this.panning !== null;
    this.clearPending();
    this.pointers.clear();
    this.pinch = null;
    this.gestureCancelled = false;
    this.panning = null;
    this.mapDrag = false;
    if (had) this.current.cancel();
    this.keys.releaseAll();
    this.updateCursor();
  }

  // 1 本の指を中断として片付け、ツールの途中の操作を cancel する
  private releasePointer(id: number) {
    if (this.panning && id === this.panning.id) {
      this.panning = null;
      this.updateCursor();
    }
    if (this.pending?.id === id) this.clearPending();
    this.pointers.delete(id);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) this.gestureCancelled = false;
    this.mapDrag = false;
    this.current.cancel();
  }

  handleWheel(e: WheelEvent) {
    if (e.target !== this.app.canvas) return;
    e.preventDefault();
    this.app.camera.zoomAt(Math.exp(-e.deltaY * 0.0012), e.clientX, e.clientY);
  }

  // --- キーボード ---
  // 矢印 / WASD でパン（Shift で速く）、+ / - でズーム、0 で自分の光に戻る、1〜5 でツール、Space+ドラッグでパン
  handleKeyDown(e: KeyboardEvent) {
    const wasSpace = this.keys.spaceDown;
    const { action, preventDefault } = this.keys.down(e);
    if (preventDefault) e.preventDefault();
    if (wasSpace !== this.keys.spaceDown) this.updateCursor();
    if (!action) return;
    if (action.kind === "undo") this.app.undo();
    else if (action.kind === "redo") this.app.redo();
    else if (action.kind === "focus") this.app.focusLight();
    else this.app.ui.selectTool(action.name);
  }

  handleKeyUp(e: KeyboardEvent) {
    const wasSpace = this.keys.spaceDown;
    this.keys.up(e);
    if (wasSpace !== this.keys.spaceDown) this.updateCursor();
  }

  // 押されているキーに応じて、毎フレーム視点を動かす
  update(dt: number) {
    if (!this.keys.active) return;
    const { camera } = this.app;
    const seconds = dt * (1 / 60);
    const fast = this.keys.shift ? 2.5 : 1;
    const step = KEY_PAN_PX_PER_SEC * fast * seconds;
    const { dx, dy, zoom } = this.keys.motion();
    if (dx || dy) camera.pan(dx * step, dy * step);
    if (zoom) camera.zoomBy(Math.exp(zoom * KEY_ZOOM_PER_SEC * seconds));
  }

  // Space を押している間・ドラッグ中は手のカーソルにする（普通は光が主役なのでカーソルは隠す）
  private updateCursor() {
    this.app.canvas.style.cursor = this.panning ? "grabbing" : this.keys.spaceDown ? "grab" : "";
  }
}

// 押下の遅延確定（ピンチの 1 本目の指で操作しない）。2 本の指がそろうまでの時間差は普通 100ms 以内
const COMMIT_HOLD_MS = 120;
const COMMIT_MOVE_PX = 10; // これより動いたら、ピンチを待たずに確定する（なぞりの始まり）
const KEY_PAN_PX_PER_SEC = 480; // Leaflet の矢印 1 回 80px を、押している間の連続移動にした値
const KEY_ZOOM_PER_SEC = 1.4;
