import { PALETTES, CROWD_R, GHOST_TTL, ttlFor } from "../../constants.js";

// ---------------------------------------------------------------------------
// Universe — 星・線・幽霊・他人・波紋の状態と生態系ルール
// ---------------------------------------------------------------------------
export class Universe {
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
