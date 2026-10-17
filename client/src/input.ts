import { HIT_RADIUS } from "./constants";
import type { ToolName } from "./constants";
import { snap, mid, dist } from "./util";
import type { Point } from "./util";
import type { App } from "./app";
import type { Star, Ghost } from "./universe";

interface PinchState {
  d0: number;
  z0: number;
  wx: number;
  wy: number;
}
type StarSnap = ReturnType<typeof snap>;

// ---------------------------------------------------------------------------
// Input — ポインタ / タッチ / キーボード
// ---------------------------------------------------------------------------

export class Input {
  tool: ToolName = "move";
  linking: Star | null = null; // 線を引き始めた星
  linkTip: [number, number] | null = null; // 引き途中の先端（ワールド座標）

  private pointers = new Map<number, Point>();
  private pinch: PinchState | null = null;
  private mapDrag = false;
  private downX = 0;
  private downY = 0;
  private downTarget: EventTarget | null = null;
  private lastPlaced: [number, number] | null = null;
  private erasing = false;
  private ghosting = false;
  // ドラッグ中の連続操作を一つの履歴として束ねる
  private placeBatch: StarSnap[] | null = null;
  private eraseBatch: StarSnap[] | null = null;
  private forgetBatch: Ghost[] | null = null;
  // PC 向けのカメラ操作
  private panning: { id: number; sx: number; sy: number; cx: number; cy: number } | null = null;
  private spaceDown = false;
  private shiftHeld = false; // 押している間はパンが速くなる
  private keys = new Set<string>(); // 押されている間パンやズームを続けるキー

  constructor(private app: App) {}

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
    this.tool = name;
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

  // 画面上の点に近い星 / 幽霊（hit px 以内）
  starAt(sx: number, sy: number, hit = HIT_RADIUS, exclude: string | null = null): Star | null {
    const { camera, universe } = this.app;
    const [wx, wy] = camera.screenToWorld(sx, sy);
    return universe.getStarAt(wx, wy, hit / camera.scalePx(), exclude);
  }
  ghostAt(sx: number, sy: number, hit = 20): Ghost | null {
    const { camera, universe } = this.app;
    const [wx, wy] = camera.screenToWorld(sx, sy);
    return universe.getGhostAt(wx, wy, hit / camera.scalePx());
  }
  unstarAt(x: number, y: number): Star | null {
    const s = this.starAt(x, y, 20);
    if (s && this.app.universe.isMine(s)) {
      this.app.universe.deleteStar(s);
      return s;
    }
    return null;
  }
  eraseAt(x: number, y: number): Star | null {
    const s = this.starAt(x, y, 16);
    if (s) {
      this.app.universe.deleteStar(s); // 消モードは誰の星でも消せる
      return s;
    }
    return null;
  }
  forgetAt(x: number, y: number): Ghost | null {
    const g = this.ghostAt(x, y, 18);
    if (g) {
      this.app.universe.forgetGhost(g);
      return g;
    }
    return null;
  }

  finalizeBatches() {
    const { universe, history, player } = this.app;
    const color = () => player.colorIndex;
    const place = (st: StarSnap) => universe.placeStar(st.x, st.y, color(), st);
    const remove = (st: StarSnap, noGhost?: boolean) => {
      const s = universe.stars.get(st.id);
      if (s) universe.deleteStar(s, noGhost);
    };

    if (this.placeBatch) {
      const list = this.placeBatch;
      this.placeBatch = null;
      if (list.length) {
        history.pushOp({
          undo: () => list.forEach((st) => remove(st, true)),
          redo: () => list.forEach(place),
        });
      }
    }
    if (this.eraseBatch) {
      const list = this.eraseBatch;
      this.eraseBatch = null;
      if (list.length) {
        history.pushOp({
          undo: () => list.forEach(place),
          redo: () => list.forEach((st) => remove(st)),
        });
      }
    }
    if (this.forgetBatch) {
      const list = this.forgetBatch;
      this.forgetBatch = null;
      if (list.length) {
        history.pushOp({
          undo: () => { list.forEach((g) => universe.ghosts.set(g.id, g)); universe.saveGhosts(); },
          redo: () => { list.forEach((g) => universe.ghosts.delete(g.id)); universe.saveGhosts(); },
        });
      }
    }
  }

  handlePointerDown(e: PointerEvent) {
    const { camera, universe, player, network, ui, history } = this.app;
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
    const [wx, wy] = camera.screenToWorld(e.clientX, e.clientY);
    this.downX = e.clientX;
    this.downY = e.clientY;
    universe.addPulse(wx, wy, 1, player.palette.glow);
    network.send({ t: "pulse", x: wx, y: wy, c: player.colorIndex });
    ui.ping();
    ui.haptic();

    const tool = this.tool;
    if (tool === "move") {
      player.target = { x: wx, y: wy };
    } else if (tool === "star") {
      const s = this.starAt(e.clientX, e.clientY);
      if (s && universe.isMine(s)) {
        const d = this.unstarAt(e.clientX, e.clientY); // 自分の星の上なら消す
        if (d) {
          history.pushOp({
            undo: () => universe.placeStar(d.x, d.y, player.colorIndex, snap(d)),
            redo: () => { const c = universe.stars.get(d.id); if (c) universe.deleteStar(c); },
          });
        }
      } else if (s) {
        universe.admire(s); // 他人の星に触れたらきらめきを送る
        ui.ping();
      } else {
        const ns = universe.placeStar(wx, wy, player.colorIndex);
        this.placeBatch = [snap(ns)];
        this.lastPlaced = [e.clientX, e.clientY];
      }
    } else if (tool === "line") {
      const s = this.starAt(e.clientX, e.clientY);
      if (s) {
        this.linking = s;
        this.linkTip = [wx, wy];
      } else {
        player.target = { x: wx, y: wy }; // 空を掴んだら普通に動く
      }
    } else if (tool === "erase") {
      this.erasing = true;
      this.eraseBatch = [];
      const d = this.eraseAt(e.clientX, e.clientY);
      if (d) this.eraseBatch.push(snap(d));
    } else if (tool === "ghost") {
      this.ghosting = true;
      this.forgetBatch = [];
      const g = this.forgetAt(e.clientX, e.clientY);
      if (g) this.forgetBatch.push({ ...g });
    }
  }

  handlePointerMove(e: PointerEvent) {
    const { camera, universe, player } = this.app;
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
    if (this.linking) {
      this.linkTip = camera.screenToWorld(e.clientX, e.clientY);
      return;
    }
    const p = this.pointers.get(e.pointerId);
    if (p) {
      p.x = e.clientX;
      p.y = e.clientY;
    }
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const m = mid(a, b);
      camera.setZoom(this.pinch.z0 * (dist(a, b) / this.pinch.d0));
      camera.anchor(this.pinch.wx, this.pinch.wy, m.x, m.y);
      return;
    }
    if (this.erasing && p) {
      const d = this.eraseAt(e.clientX, e.clientY); // なぞった星を消していく
      if (d && this.eraseBatch) this.eraseBatch.push(snap(d));
      return;
    }
    if (this.ghosting && p) {
      const g = this.forgetAt(e.clientX, e.clientY); // なぞった幽霊を忘れていく
      if (g && this.forgetBatch) this.forgetBatch.push({ ...g });
      return;
    }
    if (this.tool === "star" && p) {
      // なぞった軌道に沿って連続で星を置く
      if (this.lastPlaced && Math.hypot(e.clientX - this.lastPlaced[0], e.clientY - this.lastPlaced[1]) > 10) {
        const [wx, wy] = camera.screenToWorld(e.clientX, e.clientY);
        const ns = universe.placeStar(wx, wy, player.colorIndex);
        if (this.placeBatch) this.placeBatch.push(snap(ns));
        this.lastPlaced = [e.clientX, e.clientY];
      }
      return;
    }
    if (this.pointers.size <= 1) {
      const [wx, wy] = camera.screenToWorld(e.clientX, e.clientY);
      player.target = { x: wx, y: wy };
      camera.free = false;
    }
  }

  handlePointerUp(e: PointerEvent) {
    const { universe, history, player, ui } = this.app;
    if (this.panning && e.pointerId === this.panning.id) {
      this.panning = null;
      this.updateCursor();
      return;
    }
    const wasPinch = this.pinch !== null;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    this.mapDrag = false;

    if (this.linking) {
      const b = this.starAt(e.clientX, e.clientY, 22, this.linking.id);
      if (b) {
        const l = universe.addLink(this.linking.id, b.id);
        if (l) {
          ui.ping();
          history.pushOp({
            undo: () => universe.removeLink(l.id),
            redo: () => universe.restoreLink(l),
          });
        }
      }
      this.linking = null;
      this.linkTip = null;
      return;
    }
    this.finalizeBatches();
    this.lastPlaced = null;
    this.erasing = this.ghosting = false;
    if (wasPinch || this.pointers.size > 0) return;
    if (this.downTarget !== this.app.canvas) return;

    const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
    if (moved > 12) return;
    if (this.tool !== "move") return;

    const s = this.starAt(e.clientX, e.clientY, 20);
    if (s) {
      if (universe.isMine(s)) {
        const d = { ...s };
        universe.deleteStar(s); // 自分の星をタップで消す
        history.pushOp({
          undo: () => universe.placeStar(d.x, d.y, player.colorIndex, d),
          redo: () => { const c = universe.stars.get(d.id); if (c) universe.deleteStar(c); },
        });
      } else {
        universe.admire(s); // 他人の星をタップできらめき
        ui.ping();
      }
      return;
    }
    const g = this.ghostAt(e.clientX, e.clientY);
    if (g) {
      const gg = { ...g };
      universe.reviveGhost(g); // 消えた自分の星はタップで復活
      ui.ping();
      ui.haptic();
      history.pushOp({
        undo: () => { const st = universe.stars.get(gg.id); if (st) universe.deleteStar(st); }, // 幽霊に戻す
        redo: () => universe.reviveGhost(gg),
      });
    }
  }

  handlePointerCancel(e: PointerEvent) {
    if (this.panning && e.pointerId === this.panning.id) {
      this.panning = null;
      this.updateCursor();
    }
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    this.mapDrag = false;
    this.finalizeBatches();
    this.linking = this.linkTip = this.lastPlaced = null;
    this.erasing = this.ghosting = false;
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
        e.shiftKey ? this.app.history.redo() : this.app.history.undo();
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
    let dx = 0, dy = 0, zoom = 0;
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
