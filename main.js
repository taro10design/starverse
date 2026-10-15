// universe — 言葉のない空間。あなたは一点の光。他の光もいる。
import {
  PALETTES,
  PEER_COLOR,
  CROWD_R,
  GHOST_TTL,
  ttlFor,
  WS_HOST,
  MAP_SIZE,
  TOOL_SVG,
  TOOL_TIPS,
  HIT_RADIUS,
  autopilot,
} from "./constants.js";

const DPR = Math.min(window.devicePixelRatio || 1, 2);
const SOLO = new URLSearchParams(location.search).has("solo");

// ---------------------------------------------------------------------------
// Camera — ワールド座標(0..1正規化)とスクリーン座標の変換
// ---------------------------------------------------------------------------
class Camera {
  constructor() {
    this.cx = 0.5;
    this.cy = 0.5;
    this.z = 1;
    this.W = 0;
    this.H = 0;
    this.free = false; // ズーム/地図操作中は自分の光を追わない
  }
  resize(W, H) {
    this.W = W;
    this.H = H;
  }
  scalePx() {
    return this.z * Math.min(this.W, this.H);
  }
  worldToScreen(x, y) {
    const s = this.scalePx();
    return [(x - this.cx) * s + this.W / 2, (y - this.cy) * s + this.H / 2];
  }
  screenToWorld(x, y) {
    const s = this.scalePx();
    return [(x - this.W / 2) / s + this.cx, (y - this.H / 2) / s + this.cy];
  }
  // 点の見た目の大きさはズームの平方根でだけスケール（物理サイズではなく「見え方」優先）
  dotScale() {
    return Math.sqrt(this.z);
  }
  setZoom(z) {
    this.z = Math.min(100, Math.max(0.05, z));
  }
  // ワールド座標(wx,wy)がスクリーン座標(sx,sy)に来るようにカメラ中心を合わせる
  anchor(wx, wy, sx, sy) {
    const s = this.scalePx();
    this.cx = wx - (sx - this.W / 2) / s;
    this.cy = wy - (sy - this.H / 2) / s;
    this.free = true;
  }
  zoomAt(factor, sx, sy) {
    const [wx, wy] = this.screenToWorld(sx, sy);
    this.setZoom(this.z * factor);
    this.anchor(wx, wy, sx, sy);
  }
  // 自分の光が画面端に行きそうならカメラが寄り添う
  follow(player) {
    if (this.free) return;
    const [px, py] = this.worldToScreen(player.x, player.y);
    const mx = this.W * 0.22, my = this.H * 0.22;
    const s = this.scalePx();
    if (px < mx) this.cx -= (mx - px) / s;
    if (px > this.W - mx) this.cx += (px - (this.W - mx)) / s;
    if (py < my) this.cy -= (my - py) / s;
    if (py > this.H - my) this.cy += (py - (this.H - my)) / s;
  }
}

// ---------------------------------------------------------------------------
// Player — 自分の光。バネでターゲットへ向かう
// ---------------------------------------------------------------------------
class Player {
  constructor() {
    this.x = 0.5;
    this.y = 0.5;
    this.vx = 0;
    this.vy = 0;
    this.target = null; // {x,y} ポインタが来るまでは自分で漂う
    this.colorIndex = 0;
    try {
      this.colorIndex = Math.min(+(localStorage.getItem("uchu-color") || 0), PALETTES.length - 1);
    } catch {}
  }
  get palette() {
    return PALETTES[this.colorIndex];
  }
  setColor(i) {
    this.colorIndex = i;
    try {
      localStorage.setItem("uchu-color", String(i));
    } catch {}
  }
  update(dt, t) {
    const tgt = this.target || autopilot(t);
    const k = 0.028; // ワールド座標系なので画面サイズで割らない
    this.vx += (tgt.x - this.x) * k * dt;
    this.vy += (tgt.y - this.y) * k * dt;
    this.vx *= Math.pow(0.9, dt);
    this.vy *= Math.pow(0.9, dt);
    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }
}

// ---------------------------------------------------------------------------
// Universe — 星・線・幽霊・他人・波紋の状態と生態系ルール
// ---------------------------------------------------------------------------
class Universe {
  constructor({ solo, send }) {
    this.solo = solo;
    this.send = send;
    this.myId = solo ? "me" : null;
    this.uid = Universe.loadUid();

    this.stars = new Map(); // id -> FixedStar（ワールド座標）
    this.links = new Map(); // id -> {id,a,b,by,ts} 誰かが手で引いた線
    this.ghosts = new Map(); // id -> {id,x,y,c,gone} 消された自分の星（自分の画面にだけ残る）
    this.peers = new Map(); // id -> {x,y,rx,ry,c}
    this.pulses = [];

    this.pairsDirty = true;
    this.pairList = [];
    this.saveTimer = 0;

    this.loadGhosts();
    if (solo) this.loadSolo();
  }

  // このブラウザ固有の持ち主ID。?key= で持ち越せる（Discord等の使い捨てブラウザ対策）
  static loadUid() {
    let uid = null;
    try {
      uid = new URLSearchParams(location.search).get("key") || localStorage.getItem("uchu-uid");
    } catch {}
    if (!uid || !/^[\w-]{8,64}$/.test(uid)) uid = crypto.randomUUID();
    try {
      localStorage.setItem("uchu-uid", uid);
    } catch {}
    return uid;
  }

  isMine(s) {
    return s.by === this.uid || s.by === "me" || s.by === this.myId;
  }

  // --- 永続化 ---
  loadGhosts() {
    try {
      for (const g of JSON.parse(localStorage.getItem("uchu-ghosts") || "[]")) {
        if (Date.now() - g.gone < GHOST_TTL) this.ghosts.set(g.id, g);
      }
    } catch {}
  }
  saveGhosts() {
    try {
      localStorage.setItem("uchu-ghosts", JSON.stringify([...this.ghosts.values()].slice(-128)));
    } catch {}
  }
  // ソロモード：自分の星はlocalStorageに残る（消えない個人の空）
  loadSolo() {
    try {
      const saved = JSON.parse(localStorage.getItem("uchu-solo") || "null");
      const arr = saved ? saved.stars : JSON.parse(localStorage.getItem("uchu-solo-stars") || "[]");
      for (const s of arr || []) this.stars.set(s.id, s);
      for (const l of (saved && saved.links) || []) this.links.set(l.id, l);
      this.pairsDirty = true;
    } catch {}
  }
  saveSolo() {
    if (!this.solo) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        localStorage.setItem("uchu-solo", JSON.stringify({ stars: [...this.stars.values()], links: [...this.links.values()] }));
      } catch {}
    }, 400); // 連続配置中は書き込みをまとめる
  }

  // --- 星 ---
  placeStar(nx, ny, color, ghost) {
    const s = ghost
      ? { id: ghost.id, x: ghost.x, y: ghost.y, c: ghost.c, by: this.uid, ts: Date.now() } // 幽霊の復活
      : { id: crypto.randomUUID().slice(0, 12), x: nx, y: ny, c: color, by: this.uid, ts: Date.now() };
    this.stars.set(s.id, s);
    this.pairsDirty = true;
    this.saveSolo();
    this.send({ t: "star", id: s.id, x: s.x, y: s.y, uid: this.uid });
    return s;
  }
  deleteStar(s, noGhost) {
    if (this.isMine(s) && !noGhost) {
      this.ghosts.set(s.id, { id: s.id, x: s.x, y: s.y, c: s.c, gone: Date.now() });
      this.saveGhosts();
    }
    this.stars.delete(s.id);
    this.dropLinksTouching(s.id);
    this.pairsDirty = true;
    this.saveSolo();
    this.send({ t: "unstar", id: s.id, uid: this.uid });
  }
  // 他人の星をタップ＝きらめきを送る。寿命がリセットされる
  admire(s) {
    s.flash = performance.now();
    this.addPulse(s.x, s.y, 0.9, PALETTES[s.c % PALETTES.length].glow);
    this.send({ t: "admire", id: s.id });
  }
  // 最寄りの星（ワールド座標、半径はワールド単位）
  getStarAt(wx, wy, radius, exclude = null) {
    let best = null, bd = radius * radius;
    for (const s of this.stars.values()) {
      if (s.id === exclude) continue;
      const dx = s.x - wx, dy = s.y - wy, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  // --- 線 ---
  addLink(a, b) {
    if (!a || !b || a === b) return null;
    for (const l of this.links.values()) {
      if ((l.a === a && l.b === b) || (l.a === b && l.b === a)) return null;
    }
    const l = { id: crypto.randomUUID().slice(0, 12), a, b, by: this.uid, ts: Date.now() };
    this.restoreLink(l);
    return l;
  }
  restoreLink(l) {
    this.links.set(l.id, l);
    this.saveSolo();
    this.send({ t: "link", id: l.id, a: l.a, b: l.b, uid: this.uid });
  }
  removeLink(id) {
    this.links.delete(id);
    this.saveSolo();
    this.send({ t: "unlink", id, uid: this.uid });
  }
  dropLinksTouching(starId) {
    for (const [lid, l] of this.links) {
      if (l.a === starId || l.b === starId) this.links.delete(lid);
    }
  }

  // --- 幽霊 ---
  getGhostAt(wx, wy, radius) {
    let best = null, bd = radius * radius;
    for (const g of this.ghosts.values()) {
      const dx = g.x - wx, dy = g.y - wy, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = g; }
    }
    return best;
  }
  reviveGhost(g) {
    this.ghosts.delete(g.id);
    this.saveGhosts();
    return this.placeStar(g.x, g.y, g.c, g);
  }
  forgetGhost(g) {
    this.ghosts.delete(g.id);
    this.saveGhosts();
  }
  forgetAllGhosts() {
    this.ghosts.clear();
    this.saveGhosts();
  }

  // --- 他人・波紋 ---
  addPulse(x, y, life, col) {
    this.pulses.push({ x, y, r: 0, life, col });
  }
  updatePulses(dt, W, H) {
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      p.r += (6 / Math.min(W, H)) * dt;
      p.life -= 0.02 * dt;
      if (p.life <= 0) this.pulses.splice(i, 1);
    }
  }
  updatePeers(dt) {
    for (const p of this.peers.values()) {
      p.rx += (p.x - p.rx) * Math.min(1, 0.12 * dt);
      p.ry += (p.y - p.ry) * Math.min(1, 0.12 * dt);
    }
  }

  // --- 星座・連星と密集度（星が増減した時だけ再計算） ---
  recomputePairs() {
    if (!this.pairsDirty) return;
    this.pairList = [];
    const arr = [...this.stars.values()];
    for (const s of arr) s.n = 0;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const d = Math.hypot(arr[i].x - arr[j].x, arr[i].y - arr[j].y);
        if (d < 0.1) this.pairList.push({ a: arr[i], b: arr[j], binary: d < 0.032 });
        if (d < CROWD_R) {
          arr[i].n++;
          arr[j].n++;
        }
      }
    }
    this.pairsDirty = false;
  }

  // 寿命切れの星・線・幽霊をクライアント側でも定期的に落とす
  cleanupExpired() {
    const now = Date.now();
    let dirty = false;
    for (const [id, s] of this.stars) {
      if (!this.solo && now - s.ts > ttlFor(s.n || 0)) { // ひとりの宇宙では星は消えない
        this.stars.delete(id);
        this.dropLinksTouching(id);
        dirty = true;
      }
    }
    if (dirty) {
      this.pairsDirty = true;
      this.saveSolo();
    }
    let gdirty = false;
    for (const [id, g] of this.ghosts) {
      if (now - g.gone > GHOST_TTL) {
        this.ghosts.delete(id);
        gdirty = true;
      }
    }
    if (gdirty) this.saveGhosts();
  }
}

// ---------------------------------------------------------------------------
// Network — WebSocket 通信
// ---------------------------------------------------------------------------
class Network {
  constructor(app) {
    this.app = app;
    this.ws = null;
    this.retry = 1500;
    this.lastSend = 0;
  }
  connect() {
    if (SOLO || location.protocol === "file:") return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = (this.ws = new WebSocket(`${scheme}://${WS_HOST}/ws`));
    ws.onopen = () => {
      this.retry = 1500;
      this.sendPosition();
    };
    ws.onmessage = (e) => this.handleMessage(JSON.parse(e.data));
    ws.onclose = () => {
      this.app.universe.peers.clear();
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 1.6, 15000);
    };
    ws.onerror = () => ws.close();
  }
  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }
  sendPosition() {
    const { player } = this.app;
    this.send({ t: "p", x: player.x, y: player.y, c: player.colorIndex });
  }
  // 位置は80msごとに間引いて送る
  tick(t) {
    if (t - this.lastSend > 80) {
      this.lastSend = t;
      this.sendPosition();
    }
  }
  handleMessage(m) {
    const u = this.app.universe;
    if (m.t === "welcome") {
      u.myId = m.id;
      for (const d of m.dots) u.peers.set(d.id, { x: d.x, y: d.y, rx: d.x, ry: d.y, c: d.c });
      for (const s of m.stars || []) {
        u.stars.set(s.id, s);
        u.ghosts.delete(s.id); // 生きてるなら幽霊は要らない
      }
      for (const l of m.links || []) u.links.set(l.id, l);
      u.pairsDirty = true;
    } else if (m.t === "p") {
      const p = u.peers.get(m.id) || { x: m.x, y: m.y, rx: m.x, ry: m.y, c: m.c };
      p.x = m.x;
      p.y = m.y;
      if (typeof m.c === "number") p.c = m.c;
      u.peers.set(m.id, p);
    } else if (m.t === "star") {
      u.stars.set(m.id, m);
      u.ghosts.delete(m.id);
      u.pairsDirty = true;
    } else if (m.t === "unstar") {
      const s = u.stars.get(m.id);
      if (s && s.by === u.uid) {
        u.ghosts.set(m.id, { id: s.id, x: s.x, y: s.y, c: s.c, gone: Date.now() }); // 自分の星は幽霊になる
        u.saveGhosts();
      }
      u.stars.delete(m.id);
      u.dropLinksTouching(m.id);
      u.pairsDirty = true;
    } else if (m.t === "admire") {
      const s = u.stars.get(m.id);
      if (s) {
        s.ts = m.ts;
        s.flash = performance.now();
      }
    } else if (m.t === "link") {
      u.links.set(m.id, m);
    } else if (m.t === "unlink") {
      u.links.delete(m.id);
    } else if (m.t === "pulse") {
      u.addPulse(m.x, m.y, 0.8, typeof m.c === "number" ? PALETTES[m.c % PALETTES.length].glow : [255, 230, 200]);
    } else if (m.t === "leave") {
      u.peers.delete(m.id);
    }
  }
}

// ---------------------------------------------------------------------------
// History — アンドゥ / リドゥ
// ---------------------------------------------------------------------------
class History {
  constructor(onChange) {
    this.undoStack = [];
    this.redoStack = [];
    this.onChange = onChange;
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  pushOp(op) {
    this.undoStack.push(op);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
    this.onChange();
  }
  undo() {
    const op = this.undoStack.pop();
    if (!op) return;
    op.undo();
    this.redoStack.push(op);
    this.onChange();
  }
  redo() {
    const op = this.redoStack.pop();
    if (!op) return;
    op.redo();
    this.undoStack.push(op);
    this.onChange();
  }
}

// ---------------------------------------------------------------------------
// Input — ポインタ / タッチ / キーボード
// ---------------------------------------------------------------------------
const snap = (s) => ({ id: s.id, x: s.x, y: s.y, c: s.c });
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

class Input {
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

// ---------------------------------------------------------------------------
// Renderer — Canvas 描画（背景・星・線・他人・波紋・ミニマップ）
// ---------------------------------------------------------------------------
class Renderer {
  constructor(app, canvas) {
    this.app = app;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.mctx = null; // ミニマップ（UI が作った canvas を後で受け取る）
    this.mapBounds = { x0: 0, y0: 0, s: 1 };

    // グローは色ごとのスプライトを使い回す（毎フレームのグラデーション生成を避ける）
    this.starSprites = PALETTES.map((p) => Renderer.makeSprite(p, 0.28));
    this.peerSprite = Renderer.makeSprite(PEER_COLOR, 0.3);
    this.playerSprites = PALETTES.map((p) => Renderer.makeSprite(p, 0.35));

    this.resize();
    addEventListener("resize", () => this.resize());
    this.bgStars = Array.from({ length: 140 }, () => ({
      x: Math.random() * this.app.camera.W,
      y: Math.random() * this.app.camera.H,
      vx: (Math.random() - 0.5) * 0.14,
      vy: (Math.random() - 0.5) * 0.14,
      r: 0.4 + Math.random() * 1.4,
      tw: Math.random() * Math.PI * 2,
      tws: 0.008 + Math.random() * 0.02,
      glow: 0,
      warm: Math.random() < 0.12,
    }));
  }

  static makeSprite(p, midAlpha) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g2 = c.getContext("2d");
    const g = g2.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, p.core);
    g.addColorStop(0.3, `rgba(${p.glow.join(",")},${midAlpha})`);
    g.addColorStop(1, `rgba(${p.glow.join(",")},0)`);
    g2.fillStyle = g;
    g2.fillRect(0, 0, 64, 64);
    return c;
  }
  static hashPhase(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return (h % 628) / 100;
  }

  setMinimap(canvas) {
    this.mctx = canvas.getContext("2d");
    this.mctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  mapToWorld(mx, my) {
    const { x0, y0, s } = this.mapBounds;
    return [x0 + (mx / MAP_SIZE) * s, y0 + (my / MAP_SIZE) * s];
  }

  resize() {
    const W = innerWidth, H = innerHeight;
    this.app.camera.resize(W, H);
    this.canvas.width = W * DPR;
    this.canvas.height = H * DPR;
    this.ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  drawGlow(x, y, r, sprite) {
    this.ctx.drawImage(sprite, x - r, y - r, r * 2, r * 2);
  }

  // 背景の星（スクリーン座標の静かな層）。自分の光と波紋に反応する
  updateBackground(dt) {
    const { camera, player, universe } = this.app;
    const { W, H } = camera;
    const [px, py] = camera.worldToScreen(player.x, player.y);
    for (const s of this.bgStars) {
      s.tw += s.tws * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      if (s.x < 0) s.x += W;
      if (s.x > W) s.x -= W;
      if (s.y < 0) s.y += H;
      if (s.y > H) s.y -= H;

      const dx = px - s.x;
      const dy = py - s.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 160 * 160) {
        const d = Math.sqrt(d2) || 1;
        const f = (1 - d / 160) * 0.06;
        s.vx += (dx / d) * f * dt;
        s.vy += (dy / d) * f * dt;
        s.glow = Math.min(1, s.glow + (1 - d / 160) * 0.05 * dt);
      }
      for (const p of universe.pulses) {
        const [qx, qy] = camera.worldToScreen(p.x, p.y);
        const pdx = s.x - qx;
        const pdy = s.y - qy;
        const pd = Math.sqrt(pdx * pdx + pdy * pdy) || 1;
        const pr = p.r * camera.scalePx();
        if (Math.abs(pd - pr) < 30 && p.life > 0) {
          s.vx += (pdx / pd) * 0.5 * p.life;
          s.vy += (pdy / pd) * 0.5 * p.life;
          s.glow = 1;
        }
      }
      s.vx *= Math.pow(0.97, dt);
      s.vy *= Math.pow(0.97, dt);
      s.glow *= Math.pow(0.96, dt);
    }
  }

  drawBackground() {
    const { ctx } = this;
    const { W, H } = this.app.camera;
    const bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    bg.addColorStop(0, "#0a1028");
    bg.addColorStop(1, "#03040d");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    for (const s of this.bgStars) {
      const a = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(s.tw)) + s.glow * 0.4;
      ctx.globalAlpha = Math.min(1, a);
      ctx.fillStyle = s.warm ? "#ffd9a8" : "#bcd3ff";
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r * (1 + s.glow * 1.6), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawStar(s, wx, wy, t) {
    const { ctx } = this;
    const { camera } = this.app;
    const { W, H } = camera;
    const [x, y] = camera.worldToScreen(wx, wy);
    if (x < -30 || x > W + 30 || y < -30 || y > H + 30) return;
    const ds = camera.dotScale();
    const p = PALETTES[s.c % PALETTES.length] || PEER_COLOR;
    const tw = 0.7 + 0.3 * Math.sin(t * 0.002 + Renderer.hashPhase(s.id) * 10);
    // 老いるほど薄れる。残り寿命の後半50%からフェード（ひとりの宇宙では老いない）
    const remain = SOLO ? 1 : 1 - (Date.now() - s.ts) / ttlFor(s.n || 0);
    const fade = remain > 0.5 ? 1 : Math.max(0.05, remain * 2);
    const flash = s.flash ? Math.max(0, 1 - (t - s.flash) / 900) : 0;
    const r = 14 * ds * (1 + flash * 0.5);
    ctx.globalAlpha = Math.min(1, 0.9 * tw * fade + flash * 0.5);
    this.drawGlow(x, y, r, this.starSprites[s.c % PALETTES.length]);
    ctx.fillStyle = p.core;
    ctx.globalAlpha = Math.min(1, fade + flash);
    ctx.beginPath();
    ctx.arc(x, y, 2.2 * ds * (1 + flash * 0.5), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // 星座線(自動) → 連星 → 通常の星 の順に描き、連星の今の位置を返す
  drawStars(t) {
    const { ctx } = this;
    const { camera, universe } = this.app;
    universe.recomputePairs();

    ctx.strokeStyle = "rgba(200, 215, 255, 0.18)";
    ctx.lineWidth = 0.8 * camera.dotScale();
    for (const pair of universe.pairList) {
      if (pair.binary) continue;
      const [ax, ay] = camera.worldToScreen(pair.a.x, pair.a.y);
      const [bx, by] = camera.worldToScreen(pair.b.x, pair.b.y);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    const drawn = new Set();
    const orbitPos = new Map(); // 連星メンバーの今のワールド座標
    for (const pair of universe.pairList) {
      if (!pair.binary) continue;
      const { a, b } = pair;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const r = Math.hypot(a.x - b.x, a.y - b.y) / 2 || 0.008;
      const ang = t * 0.0006 + Renderer.hashPhase(a.id) + Renderer.hashPhase(b.id);
      const ap = [mx + Math.cos(ang) * r, my + Math.sin(ang) * r];
      const bp = [mx - Math.cos(ang) * r, my - Math.sin(ang) * r];
      orbitPos.set(a.id, ap);
      orbitPos.set(b.id, bp);
      this.drawStar(a, ap[0], ap[1], t);
      this.drawStar(b, bp[0], bp[1], t);
      drawn.add(a.id);
      drawn.add(b.id);
    }
    for (const s of universe.stars.values()) {
      if (!drawn.has(s.id)) this.drawStar(s, s.x, s.y, t);
    }
    return orbitPos;
  }

  // 幽霊（消えた自分の星。自分にだけ見える墓標）
  drawGhosts() {
    const { ctx } = this;
    const { camera, universe } = this.app;
    const { W, H } = camera;
    ctx.setLineDash([3, 4]);
    for (const g of universe.ghosts.values()) {
      const [gx, gy] = camera.worldToScreen(g.x, g.y);
      if (gx < -20 || gx > W + 20 || gy < -20 || gy > H + 20) continue;
      const p = PALETTES[g.c % PALETTES.length];
      ctx.strokeStyle = `rgba(${p.glow.join(",")},0.22)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(gx, gy, 5 * camera.dotScale(), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // 手で引かれた線（意図の線。自動の星座線より少し明るい）と引き途中の線
  drawLinks(orbitPos) {
    const { ctx } = this;
    const { camera, universe, input } = this.app;
    ctx.strokeStyle = "rgba(225, 230, 255, 0.3)";
    ctx.lineWidth = 1 * camera.dotScale();
    for (const l of universe.links.values()) {
      const a = universe.stars.get(l.a), b = universe.stars.get(l.b);
      if (!a || !b) continue;
      const [ax, ay] = camera.worldToScreen(...(orbitPos.get(l.a) || [a.x, a.y]));
      const [bx, by] = camera.worldToScreen(...(orbitPos.get(l.b) || [b.x, b.y]));
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
    if (input.linking && input.linkTip) {
      const [ax, ay] = camera.worldToScreen(input.linking.x, input.linking.y);
      const [bx, by] = camera.worldToScreen(input.linkTip[0], input.linkTip[1]);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(235, 240, 255, 0.55)";
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.restore();
    }
  }

  // 他の光（実在の誰か、色つき）
  drawPeers() {
    const { ctx } = this;
    const { camera, universe } = this.app;
    const { W, H } = camera;
    for (const p of universe.peers.values()) {
      const [px, py] = camera.worldToScreen(p.rx, p.ry);
      if (px < -40 || px > W + 40 || py < -40 || py > H + 40) continue;
      const hasColor = typeof p.c === "number";
      const pc = hasColor ? PALETTES[p.c % PALETTES.length] : PEER_COLOR;
      ctx.globalAlpha = 0.75;
      this.drawGlow(px, py, 18 * camera.dotScale(), hasColor ? this.starSprites[p.c % PALETTES.length] : this.peerSprite);
      ctx.globalAlpha = 1;
      ctx.fillStyle = pc.core;
      ctx.beginPath();
      ctx.arc(px, py, 1.8 * camera.dotScale(), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawPulses() {
    const { ctx } = this;
    const { camera, universe } = this.app;
    for (const p of universe.pulses) {
      const [px, py] = camera.worldToScreen(p.x, p.y);
      ctx.strokeStyle = `rgba(${p.col.join(",")},${0.5 * p.life})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px, py, p.r * camera.scalePx(), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  drawPlayer() {
    const { ctx } = this;
    const { camera, player } = this.app;
    const [x, y] = camera.worldToScreen(player.x, player.y);
    this.drawGlow(x, y, 26 * camera.dotScale(), this.playerSprites[player.colorIndex]);
    ctx.fillStyle = player.palette.core;
    ctx.beginPath();
    ctx.arc(x, y, 2.6 * camera.dotScale(), 0, Math.PI * 2);
    ctx.fill();
  }

  // ミニマップ：世界全体を俯瞰。星・他人・自分・今見ている範囲を描く
  drawMinimap() {
    const { mctx } = this;
    if (!mctx) return;
    const { camera, universe, player } = this.app;
    const { W, H } = camera;
    let x0 = 0, y0 = 0, x1 = 1, y1 = 1;
    const corners = [camera.screenToWorld(0, 0), camera.screenToWorld(W, 0), camera.screenToWorld(W, H), camera.screenToWorld(0, H)];
    const grow = (x, y) => {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    };
    for (const s of universe.stars.values()) grow(s.x, s.y);
    for (const p of universe.peers.values()) grow(p.rx, p.ry);
    for (const pt of [...corners, [player.x, player.y]]) grow(pt[0], pt[1]);

    const pad = 0.12 * Math.max(x1 - x0, y1 - y0);
    const s = Math.max(x1 - x0, y1 - y0) + pad * 2;
    const b = (this.mapBounds = { x0: (x0 + x1) / 2 - s / 2, y0: (y0 + y1) / 2 - s / 2, s });
    const M = (wx, wy) => [((wx - b.x0) / s) * MAP_SIZE, ((wy - b.y0) / s) * MAP_SIZE];

    mctx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);
    mctx.fillStyle = "rgba(8, 12, 30, 0.55)";
    mctx.fillRect(0, 0, MAP_SIZE, MAP_SIZE);

    // 灯された星
    for (const st of universe.stars.values()) {
      const [x, y] = M(st.x, st.y);
      if (x < 0 || x > MAP_SIZE || y < 0 || y > MAP_SIZE) continue;
      mctx.fillStyle = PALETTES[st.c % PALETTES.length].core;
      mctx.globalAlpha = 0.85;
      mctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
    }
    // 他の光
    for (const p of universe.peers.values()) {
      const [x, y] = M(p.rx, p.ry);
      mctx.globalAlpha = 0.9;
      mctx.fillStyle = (typeof p.c === "number" ? PALETTES[p.c % PALETTES.length] : PEER_COLOR).core;
      mctx.beginPath();
      mctx.arc(x, y, 2, 0, Math.PI * 2);
      mctx.fill();
    }
    // 今見ている範囲
    mctx.globalAlpha = 1;
    mctx.strokeStyle = "rgba(200, 215, 255, 0.35)";
    mctx.lineWidth = 0.8;
    mctx.beginPath();
    corners.forEach(([vx, vy], i) => {
      const [x, y] = M(vx, vy);
      i === 0 ? mctx.moveTo(x, y) : mctx.lineTo(x, y);
    });
    mctx.closePath();
    mctx.stroke();
    // 自分
    const [px, py] = M(player.x, player.y);
    const pal = player.palette;
    mctx.fillStyle = pal.core;
    mctx.shadowColor = `rgb(${pal.glow.join(",")})`;
    mctx.shadowBlur = 5;
    mctx.beginPath();
    mctx.arc(px, py, 2.2, 0, Math.PI * 2);
    mctx.fill();
    mctx.shadowBlur = 0;
    mctx.globalAlpha = 1;
  }

  render(t) {
    this.drawBackground();
    const orbitPos = this.drawStars(t);
    this.drawGhosts();
    this.drawLinks(orbitPos);
    this.drawPeers();
    this.drawPulses();
    this.drawPlayer();
    this.drawMinimap();
  }
}

// ---------------------------------------------------------------------------
// UI — DOM の生成とイベント、触覚・音のフィードバック
// ---------------------------------------------------------------------------
const ICON_UNDO = '<svg viewBox="0 0 24 24"><path d="M8 5 L3 9.5 L8 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 9.5 L14 9.5 A6 6 0 0 1 14 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_REDO = '<svg viewBox="0 0 24 24"><path d="M16 5 L21 9.5 L16 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 9.5 L10 9.5 A6 6 0 0 0 10 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

class UI {
  constructor(app) {
    this.app = app;
    this.hapticEl = null;
    this.audioCtx = null;
    this.createPalette();
    this.createModeToggle();
    this.createTools();
    this.createHelpPanel();
    this.createMinimap();
    this.updateHistoryButtons();
  }

  // pointerdown が下のキャンバスに伝わらないようにして実行する
  static onPress(el, fn) {
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      fn(e);
    });
  }

  createPalette() {
    const { player, universe, network } = this.app;
    const el = (this.paletteEl = document.createElement("div"));
    el.id = "palette";
    PALETTES.forEach((p, i) => {
      const b = document.createElement("button");
      b.className = "swatch" + (i === player.colorIndex ? " sel" : "");
      b.style.setProperty("--c", p.core);
      b.style.setProperty("--g", `rgba(${p.glow.join(",")},0.6)`);
      b.setAttribute("aria-label", "color " + i);
      UI.onPress(b, () => {
        player.setColor(i);
        el.querySelectorAll(".swatch").forEach((s, j) => s.classList.toggle("sel", j === i));
        universe.addPulse(player.x, player.y, 1, p.glow);
        network.sendPosition();
      });
      el.appendChild(b);
    });
    document.body.appendChild(el);
  }

  // ひとり/みんな トグル
  createModeToggle() {
    const b = document.createElement("button");
    b.id = "mode";
    b.title = SOLO ? "みんなの宇宙へ" : "ひとりの宇宙へ";
    b.innerHTML = SOLO
      ? '<span class="dot1"></span><span class="lbl">ひとり</span>'
      : '<span class="dot1"></span><span class="dot1"></span><span class="lbl">みんな</span>';
    UI.onPress(b, () => {
      location.href = SOLO ? location.pathname : location.pathname + "?solo";
    });
    document.body.appendChild(b);
  }

  createTools() {
    const { input, history } = this.app;
    const el = (this.toolsEl = document.createElement("div"));
    el.id = "tools";
    for (const name of ["move", "star", "line", "erase", "ghost"]) {
      const b = document.createElement("button");
      b.className = "tool" + (name === input.tool ? " on" : "");
      b.innerHTML = TOOL_SVG[name];
      b.title = TOOL_TIPS[name];
      b.setAttribute("aria-label", TOOL_TIPS[name]);
      UI.onPress(b, () => {
        if (name === "erase" && input.tool === "erase") return this.app.clearMine(); // もう一度押す＝自分の星を全部消す
        if (name === "ghost" && input.tool === "ghost") return this.app.forgetAllGhosts(); // もう一度押す＝幽霊を全部忘れる
        input.setTool(name);
        el.querySelectorAll(".tool").forEach((t) => t.classList.toggle("on", t === b));
      });
      el.appendChild(b);
    }

    const undoB = (this.undoBtn = document.createElement("button"));
    undoB.className = "tool hist dim";
    undoB.style.marginLeft = "10px";
    undoB.innerHTML = ICON_UNDO;
    undoB.title = "もどす (Ctrl+Z)";
    UI.onPress(undoB, () => history.undo());
    el.appendChild(undoB);

    const redoB = (this.redoBtn = document.createElement("button"));
    redoB.className = "tool hist dim";
    redoB.innerHTML = ICON_REDO;
    redoB.title = "やりなおす (Ctrl+Y)";
    UI.onPress(redoB, () => history.redo());
    el.appendChild(redoB);

    document.body.appendChild(el);
  }

  updateHistoryButtons() {
    const { history } = this.app;
    this.undoBtn.classList.toggle("dim", !history.canUndo);
    this.redoBtn.classList.toggle("dim", !history.canRedo);
  }

  createHelpPanel() {
    const btn = (this.helpBtn = document.createElement("button"));
    btn.id = "helpbtn";
    btn.textContent = "?";
    const help = (this.helpEl = document.createElement("div"));
    help.id = "help";
    help.innerHTML = `
  <p>左下 — モードを切り替える</p>
  <p class="dim">● 光：タップで波、動かすとついてくる。自分の星タップで消える</p>
  <p class="dim">他人の星をタップ — きらめきを送る。その星は長生きする</p>
  <p class="dim">✦ 星：タップで置く、なぞると連続で置ける</p>
  <p class="dim">─ 線：星から星へなぞって自分で線を引く</p>
  <p class="dim">⌫ 消：誰の星でも消せる。もう一度押すと自分のが全部消える</p>
  <p class="dim">👻 幽霊：消えた自分の星をなぞって忘れる。もう一度押すと全部忘れる</p>
  <p class="dim">消えた自分の星は幽霊として残る。光モードでタップすると復活</p>
  <p class="dim"><button id="revivebtn">幽霊を全部復活</button></p>
  <p>近くの星どうし — 線がつながって星座に</p>
  <p>すごく近い2つ — 連星になって回る</p>
  <p>ピンチ / ホイール — ズーム</p>
  <p>下の点 — 自分の色</p>
  <p>右上の地図 — 触れた場所へ光を送る</p>
  <p>右下 — ひとりの宇宙と切り替え</p>
  <p class="dim">${SOLO ? "ひとりの宇宙。星はここに残る" : "同じ空を誰かと見ている。混んだ場所の星は早く消え、見てもらった星は長生きする"}</p>
  <p class="dim"><button id="keybtn">鍵リンクをコピー</button> 別の端末・ブラウザでも自分の星として開ける</p>

`;
    UI.onPress(btn, () => help.classList.toggle("open"));
    document.body.appendChild(btn);
    document.body.appendChild(help);

    const keyBtn = help.querySelector("#keybtn");
    UI.onPress(keyBtn, () => this.copyKeyLink(keyBtn));

    const reviveBtn = help.querySelector("#revivebtn");
    UI.onPress(reviveBtn, () => {
      const n = this.app.reviveAllGhosts();
      reviveBtn.textContent = n ? `${n}個復活した` : "幽霊がいない";
      setTimeout(() => (reviveBtn.textContent = "幽霊を全部復活"), 1500);
    });

    let seen = false;
    try {
      seen = !!localStorage.getItem("uchu-seen");
    } catch {}
    if (!seen) help.classList.add("open");

    // パネル外をタップしたら閉じる
    addEventListener("pointerdown", (e) => {
      if (help.classList.contains("open") && e.target !== btn && !(e.target.closest && e.target.closest("#help"))) {
        help.classList.remove("open");
        try {
          localStorage.setItem("uchu-seen", "1");
        } catch {}
      }
    });
  }

  // 「鍵リンク」＝uid入りURL。このリンクで開くとどのブラウザでも自分の星のまま
  copyKeyLink(keyBtn) {
    const url = location.origin + location.pathname + "?key=" + this.app.universe.uid;
    const done = () => {
      keyBtn.textContent = "コピーした";
      setTimeout(() => (keyBtn.textContent = "鍵リンクをコピー"), 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(() => prompt("このリンクを保存してね", url));
    } else {
      prompt("このリンクを保存してね", url);
    }
  }

  // 右上のちいさな地図
  createMinimap() {
    const { input, camera, renderer } = this.app;
    const map = (this.mapEl = document.createElement("canvas"));
    map.id = "minimap";
    map.width = MAP_SIZE * DPR;
    map.height = MAP_SIZE * DPR;
    document.body.appendChild(map);
    renderer.setMinimap(map);
    map.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      input.startMapDrag(e);
      camera.free = false;
    });
  }

  // Androidはnavigator.vibrate、iOS Safariはswitchハックで触覚を出す
  haptic() {
    try {
      if (navigator.vibrate && navigator.vibrate(12)) return;
    } catch {}
    try {
      if (!this.hapticEl) {
        const el = (this.hapticEl = document.createElement("input"));
        el.type = "checkbox";
        el.setAttribute("switch", "");
        el.style.cssText = "position:fixed;top:-200px;opacity:0;pointer-events:none";
        document.body.appendChild(el);
      }
      this.hapticEl.click();
    } catch {}
  }

  ping() {
    try {
      const actx = (this.audioCtx = this.audioCtx || new (window.AudioContext || window.webkitAudioContext)());
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = "sine";
      o.frequency.value = 620 + Math.random() * 300;
      g.gain.setValueAtTime(0.06, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.9);
      o.connect(g).connect(actx.destination);
      o.start();
      o.stop(actx.currentTime + 0.9);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// App — 全体の組み立てとメインループ
// ---------------------------------------------------------------------------
class App {
  constructor() {
    this.canvas = document.getElementById("space");
    this.camera = new Camera();
    this.player = new Player();
    this.universe = new Universe({ solo: SOLO, send: (obj) => this.network.send(obj) });
    this.network = new Network(this);
    this.history = new History(() => this.ui.updateHistoryButtons());
    this.input = new Input(this);
    this.renderer = new Renderer(this, this.canvas);
    this.ui = new UI(this);
    this.t0 = 0;
  }

  init() {
    this.input.bind();
    this.network.connect();
    setInterval(() => this.universe.cleanupExpired(), 15000);
    requestAnimationFrame((t) => this.loop(t));
  }

  loop(t) {
    requestAnimationFrame((n) => this.loop(n));
    const dt = Math.min((t - this.t0) / 16.7, 3) || 1;
    this.t0 = t;
    this.update(dt, t);
    this.renderer.render(t);
  }

  update(dt, t) {
    const { player, camera, universe, renderer, network } = this;
    player.update(dt, t);
    camera.follow(player);
    network.tick(t);
    renderer.updateBackground(dt);
    universe.updatePulses(dt, camera.W, camera.H);
    universe.updatePeers(dt);
  }

  // --- UI から呼ばれる、複数クラスにまたがる操作 ---
  // 消モードでもう一度押す＝自分の星を全部消す
  clearMine() {
    const { universe, history, player, ui } = this;
    const list = [];
    for (const s of [...universe.stars.values()]) {
      if (universe.isMine(s)) {
        list.push(snap(s));
        universe.deleteStar(s);
      }
    }
    if (!list.length) return;
    ui.haptic();
    history.pushOp({
      undo: () => list.forEach((st) => universe.placeStar(st.x, st.y, player.colorIndex, st)),
      redo: () => list.forEach((st) => { const s = universe.stars.get(st.id); if (s) universe.deleteStar(s); }),
    });
  }

  // お化けモードでもう一度押す＝幽霊を全部忘れる
  forgetAllGhosts() {
    if (!this.universe.ghosts.size) return;
    this.universe.forgetAllGhosts();
    this.ui.haptic();
  }

  // 幽霊を全部復活（復活した数を返す）
  reviveAllGhosts() {
    const { universe, history, player } = this;
    const gs = [...universe.ghosts.values()].map((g) => ({ ...g }));
    for (const g of gs) universe.reviveGhost(g);
    if (gs.length) {
      this.ui.haptic();
      history.pushOp({
        undo: () => gs.forEach((g) => { const s = universe.stars.get(g.id); if (s) universe.deleteStar(s); }),
        redo: () => gs.forEach((g) => universe.reviveGhost(g)),
      });
    }
    return gs.length;
  }
}

new App().init();
