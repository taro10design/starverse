import { PALETTES, CROWD_R, GHOST_TTL, ttlFor } from "./constants";
import { storage } from "./storage";
import type { RGB } from "./constants";
import type { StarData, LinkData, ClientMessage } from "../../shared/protocol";

// ---------------------------------------------------------------------------
// Universe — 星・線・幽霊・他人・波紋の状態と生態系ルール
// ---------------------------------------------------------------------------
// クライアント側の星は、サーバーの星に描画用の一時状態が付く
export interface Star extends StarData {
  n?: number; // 近傍の星の数（密集度）
  flash?: number; // きらめきの開始時刻
}
// 消された自分の星（自分の画面にだけ残る）
export interface Ghost {
  id: string;
  x: number;
  y: number;
  c: number;
  gone: number;
}
export interface Peer {
  x: number;
  y: number;
  rx: number; // 補間された表示位置
  ry: number;
  c?: number;
}
export interface Pulse {
  x: number;
  y: number;
  r: number;
  life: number;
  col: RGB;
}
export interface Pair {
  a: Star;
  b: Star;
  binary: boolean;
}

export class Universe {
  readonly uid = Universe.loadUid();
  myId: string | null = null; // サーバーが割り当てた接続 id（他の人の位置の中から自分を除くのに使う）
  readonly stars = new Map<string, Star>();
  readonly links = new Map<string, LinkData>(); // 誰かが手で引いた線
  readonly ghosts = new Map<string, Ghost>();
  readonly peers = new Map<string, Peer>();
  pulses: Pulse[] = [];
  pairsDirty = true;
  pairList: Pair[] = [];
  private saveTimer = 0;

  constructor(
    private solo: boolean,
    private send: (msg: ClientMessage) => void,
  ) {
    this.loadGhosts();
    if (solo) this.loadSolo();
  }

  // このブラウザ固有の持ち主ID。?key= で持ち越せる（Discord等の使い捨てブラウザ対策）
  static loadUid(): string {
    let uid = new URLSearchParams(location.search).get("key") ?? storage.get("uchu-uid");
    if (!uid || !/^[\w-]{8,64}$/.test(uid)) uid = crypto.randomUUID();
    storage.set("uchu-uid", uid);
    return uid;
  }

  isMine(s: { by: string }): boolean {
    return s.by === this.uid;
  }

  // --- 永続化 ---
  loadGhosts() {
    for (const g of storage.getJSON<Ghost[]>("uchu-ghosts") ?? []) {
      if (Date.now() - g.gone < GHOST_TTL) this.ghosts.set(g.id, g);
    }
  }
  saveGhosts() {
    storage.setJSON("uchu-ghosts", [...this.ghosts.values()].slice(-128));
  }
  // ソロモード：自分の星は localStorage に残る（消えない個人の空）
  loadSolo() {
    const saved = storage.getJSON<{ stars?: Star[]; links?: LinkData[] }>("uchu-solo");
    for (const s of saved?.stars ?? []) this.stars.set(s.id, s);
    for (const l of saved?.links ?? []) this.links.set(l.id, l);
    this.pairsDirty = true;
  }
  saveSolo() {
    if (!this.solo) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      storage.setJSON("uchu-solo", { stars: [...this.stars.values()], links: [...this.links.values()] });
    }, 400); // 連続配置中は書き込みをまとめる
  }

  // --- 星 ---
  placeStar(nx: number, ny: number, color: number, ghost?: Pick<Star, "id" | "x" | "y" | "c"> | null): Star {
    const s = ghost
      ? { id: ghost.id, x: ghost.x, y: ghost.y, c: ghost.c, by: this.uid, ts: Date.now() } // 幽霊の復活
      : { id: crypto.randomUUID().slice(0, 12), x: nx, y: ny, c: color, by: this.uid, ts: Date.now() };
    this.stars.set(s.id, s);
    this.pairsDirty = true;
    this.saveSolo();
    this.send({ t: "star", id: s.id, x: s.x, y: s.y, uid: this.uid });
    return s;
  }
  deleteStar(s: Star, noGhost?: boolean) {
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
  admire(s: Star) {
    s.flash = performance.now();
    this.addPulse(s.x, s.y, 0.9, PALETTES[s.c % PALETTES.length].glow);
    this.send({ t: "admire", id: s.id });
  }
  // 最寄りの星（ワールド座標、半径はワールド単位）
  getStarAt(wx: number, wy: number, radius: number, exclude: string | null = null): Star | null {
    let best: Star | null = null,
      bd = radius * radius;
    for (const s of this.stars.values()) {
      if (s.id === exclude) continue;
      const dx = s.x - wx,
        dy = s.y - wy,
        d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  // --- 線 ---
  addLink(a: string, b: string): LinkData | null {
    if (!a || !b || a === b) return null;
    for (const l of this.links.values()) {
      if ((l.a === a && l.b === b) || (l.a === b && l.b === a)) return null;
    }
    const l = { id: crypto.randomUUID().slice(0, 12), a, b, by: this.uid, ts: Date.now() };
    this.restoreLink(l);
    return l;
  }
  restoreLink(l: LinkData) {
    this.links.set(l.id, l);
    this.saveSolo();
    this.send({ t: "link", id: l.id, a: l.a, b: l.b, uid: this.uid });
  }
  removeLink(id: string) {
    this.links.delete(id);
    this.saveSolo();
    this.send({ t: "unlink", id, uid: this.uid });
  }
  dropLinksTouching(starId: string) {
    for (const [lid, l] of this.links) {
      if (l.a === starId || l.b === starId) this.links.delete(lid);
    }
  }

  // --- 幽霊 ---
  getGhostAt(wx: number, wy: number, radius: number): Ghost | null {
    let best: Ghost | null = null,
      bd = radius * radius;
    for (const g of this.ghosts.values()) {
      const dx = g.x - wx,
        dy = g.y - wy,
        d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = g;
      }
    }
    return best;
  }
  reviveGhost(g: Ghost): Star {
    this.ghosts.delete(g.id);
    this.saveGhosts();
    return this.placeStar(g.x, g.y, g.c, g);
  }
  forgetGhost(g: Ghost) {
    this.ghosts.delete(g.id);
    this.saveGhosts();
  }
  // 忘れた幽霊を思い出す（アンドゥ用）
  rememberGhost(g: Ghost) {
    this.ghosts.set(g.id, g);
    this.saveGhosts();
  }
  forgetAllGhosts() {
    this.ghosts.clear();
    this.saveGhosts();
  }

  // --- 他人・波紋 ---
  addPulse(x: number, y: number, life: number, col: RGB) {
    this.pulses.push({ x, y, r: 0, life, col });
  }
  updatePulses(dt: number, W: number, H: number) {
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      p.r += (6 / Math.min(W, H)) * dt;
      p.life -= 0.02 * dt;
      if (p.life <= 0) this.pulses.splice(i, 1);
    }
  }
  updatePeers(dt: number) {
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
          arr[i].n = (arr[i].n ?? 0) + 1;
          arr[j].n = (arr[j].n ?? 0) + 1;
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
      if (!this.solo && now - s.ts > ttlFor(s.n || 0)) {
        // ひとりの宇宙では星は消えない
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
