import { HIT_RADIUS } from "../../constants.js";
import { snap, mid, dist } from "./util.js";

// ---------------------------------------------------------------------------
// Input — ポインタ / タッチ / キーボード
// ---------------------------------------------------------------------------

export class Input {
  constructor(app) {
    this.app = app;
    this.tool = "move";
    this.pointers = new Map();
    this.pinch = null;
    this.mapDrag = false;
    this.downAt = 0;
    this.downX = 0;
    this.downY = 0;
    this.downTarget = null;
    this.linking = null; // 線を引き始めた星
    this.linkTip = null; // 引き途中の先端（ワールド座標）
    this.lastPlaced = null;
    this.erasing = false;
    this.ghosting = false;
    // ドラッグ中の連続操作を一つの履歴として束ねる
    this.placeBatch = null;
    this.eraseBatch = null;
    this.forgetBatch = null;
  }

  bind() {
    addEventListener("pointerdown", (e) => this.handlePointerDown(e));
    addEventListener("pointermove", (e) => this.handlePointerMove(e));
    addEventListener("pointerup", (e) => this.handlePointerUp(e));
    addEventListener("pointercancel", (e) => this.handlePointerCancel(e));
    addEventListener("wheel", (e) => this.handleWheel(e), { passive: false });
    addEventListener("keydown", (e) => this.handleKeyDown(e));
    addEventListener("contextmenu", (e) => e.preventDefault());
  }

  setTool(name) {
    this.tool = name;
  }
  startMapDrag(e) {
    this.mapDrag = true;
    this.moveToMap(e.offsetX, e.offsetY);
    this.app.camera.free = false;
  }
  moveToMap(mx, my) {
    const [wx, wy] = this.app.renderer.mapToWorld(mx, my);
    this.app.player.target = { x: wx, y: wy };
  }

  // 画面上の点に近い星 / 幽霊（hit px 以内）
  starAt(sx, sy, hit = HIT_RADIUS, exclude = null) {
    const { camera, universe } = this.app;
    const [wx, wy] = camera.screenToWorld(sx, sy);
    return universe.getStarAt(wx, wy, hit / camera.scalePx(), exclude);
  }
  ghostAt(sx, sy, hit = 20) {
    const { camera, universe } = this.app;
    const [wx, wy] = camera.screenToWorld(sx, sy);
    return universe.getGhostAt(wx, wy, hit / camera.scalePx());
  }
  unstarAt(x, y) {
    const s = this.starAt(x, y, 20);
    if (s && this.app.universe.isMine(s)) {
      this.app.universe.deleteStar(s);
      return s;
    }
    return null;
  }
  eraseAt(x, y) {
    const s = this.starAt(x, y, 16);
    if (s) {
      this.app.universe.deleteStar(s); // 消モードは誰の星でも消せる
      return s;
    }
    return null;
  }
  forgetAt(x, y) {
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
    const place = (st) => universe.placeStar(st.x, st.y, color(), st);
    const remove = (st, noGhost) => {
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

  handlePointerDown(e) {
    const { camera, universe, player, network, ui, history } = this.app;
    this.downTarget = e.target;
    if (e.target !== this.app.canvas) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const m = mid(a, b);
      const [wx, wy] = camera.screenToWorld(m.x, m.y);
      this.pinch = { d0: dist(a, b), z0: camera.z, wx, wy };
      return;
    }
    const [wx, wy] = camera.screenToWorld(e.clientX, e.clientY);
    this.downAt = performance.now();
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

  handlePointerMove(e) {
    const { camera, universe, player } = this.app;
    if (this.mapDrag) {
      const r = this.app.ui.mapEl.getBoundingClientRect();
      this.moveToMap(e.clientX - r.left, e.clientY - r.top);
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

  handlePointerUp(e) {
    const { universe, history, player, ui } = this.app;
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

  handlePointerCancel(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    this.mapDrag = false;
    this.finalizeBatches();
    this.linking = this.linkTip = this.lastPlaced = null;
    this.erasing = this.ghosting = false;
  }

  handleWheel(e) {
    if (e.target !== this.app.canvas) return;
    e.preventDefault();
    this.app.camera.zoomAt(Math.exp(-e.deltaY * 0.0012), e.clientX, e.clientY);
  }

  handleKeyDown(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === "z") {
      e.preventDefault();
      e.shiftKey ? this.app.history.redo() : this.app.history.undo();
    } else if (k === "y") {
      e.preventDefault();
      this.app.history.redo();
    }
  }
}
