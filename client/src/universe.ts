import { PALETTES, CROWD_R, GHOST_TTL, ttlFor } from "./constants";
import { storage } from "./storage";
import { isGhost, isLinkData, isStarData, validItems } from "./validate";
import type { RGB } from "./constants";
import type { StarData, LinkData, ClientMessage } from "../../shared/protocol";
import { MAX_LINKS_PER_USER, MAX_STARS_PER_USER, UID_PATTERN } from "../../shared/limits";

const PEER_STALE_MS = 30_000; // これだけ位置が届かなかった人は、いなくなったものとして消す
const REVIVED_TTL_MS = 30_000; // 復活で消した幽霊を、サーバーに断られたときのために覚えておく時間
const KEY_STORAGE = "uchu-key"; // 持ち主の鍵の保存先

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
  seen: number; // 最後に位置が届いた時刻（Date.now()）
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
  readonly uid = Universe.loadUid(); // 持ち主の鍵。秘密なので hello と鍵リンクにしか使わない
  // 持ち主 ID（星の by と比べて「自分の星か」を判定する）。オンラインでは welcome.me で決まり、
  // それまでは null（星も線も作れない）。ソロでは uid と同じ
  ownerId: string | null;
  myId: string | null = null; // サーバーが割り当てた接続 id（他の人の位置の中から自分を除くのに使う）
  readonly stars = new Map<string, Star>();
  readonly links = new Map<string, LinkData>(); // 誰かが手で引いた線
  readonly ghosts = new Map<string, Ghost>();
  readonly peers = new Map<string, Peer>();
  pulses: Pulse[] = [];
  pairsDirty = true;
  pairList: Pair[] = [];
  private saveTimer = 0;
  // 復活（placeStar に ghost を渡した）で消した幽霊。サーバーに断られたら戻す（REVIVED_TTL_MS で期限切れ）
  private readonly revived = new Map<string, { ghost: Ghost; at: number }>();

  constructor(
    private solo: boolean,
    private send: (msg: ClientMessage) => void,
  ) {
    this.ownerId = solo ? this.uid : null;
    this.loadGhosts();
    if (solo) this.loadSolo();
  }

  // このブラウザ固有の持ち主の鍵。?key= で持ち越せる（Discord等の使い捨てブラウザ対策）。
  // 鍵はアドレスバーに残すと画面共有や履歴から漏れるので、保存したら URL から消す。
  // 旧プロトコルでは鍵（uchu-uid）が星の by として全員に配信されていたので、それは読まずに作り直す
  static loadUid(): string {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get("key");
    let uid = fromUrl ?? storage.get(KEY_STORAGE);
    if (!uid || !UID_PATTERN.test(uid)) uid = crypto.randomUUID();
    storage.set(KEY_STORAGE, uid);
    if (fromUrl !== null) {
      // URLSearchParams.toString() は `?solo` を `?solo=` に変えるので、key の部分だけを文字列から除く
      const rest = location.search
        .slice(1)
        .split("&")
        .filter((part) => part !== "" && part.split("=")[0] !== "key");
      history.replaceState(null, "", location.pathname + (rest.length ? "?" + rest.join("&") : "") + location.hash);
    }
    return uid;
  }

  isMine(s: { by: string }): boolean {
    return this.ownerId !== null && s.by === this.ownerId;
  }
  private countMine(items: Iterable<{ by: string }>): number {
    let n = 0;
    for (const it of items) if (this.isMine(it)) n++;
    return n;
  }

  // --- 永続化 ---
  loadGhosts() {
    for (const g of validItems(storage.getJSON("uchu-ghosts"), isGhost)) {
      if (Date.now() - g.gone < GHOST_TTL) this.ghosts.set(g.id, g);
    }
  }
  saveGhosts() {
    storage.setJSON("uchu-ghosts", [...this.ghosts.values()].slice(-128));
  }
  // ソロモード：自分の星は localStorage に残る（消えない個人の空）
  loadSolo() {
    const saved = storage.getJSON("uchu-solo");
    const fields: { stars?: unknown; links?: unknown } = typeof saved === "object" && saved !== null ? saved : {};
    for (const s of validItems(fields.stars, isStarData)) this.stars.set(s.id, s);
    for (const l of validItems(fields.links, isLinkData)) this.links.set(l.id, l);
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
  // 星を置いてサーバーへ送る。持ち主 ID が未確定（welcome の前）か、自分の星が上限に達していたら置かずに null。
  // ghost を渡すと同じ id・位置・色で置き直す（幽霊の復活・アンドゥ）
  placeStar(nx: number, ny: number, color: number, ghost?: Pick<Star, "id" | "x" | "y" | "c"> | null): Star | null {
    const by = this.ownerId;
    if (by === null || this.countMine(this.stars.values()) >= MAX_STARS_PER_USER) return null;
    const s = ghost
      ? { id: ghost.id, x: ghost.x, y: ghost.y, c: ghost.c, by, ts: Date.now() }
      : { id: crypto.randomUUID().slice(0, 12), x: nx, y: ny, c: color, by, ts: Date.now() };
    this.stars.set(s.id, s);
    const g = this.ghosts.get(s.id);
    if (g) {
      // 生きてるなら幽霊は要らない。ただしサーバーに断られたら戻すので覚えておく
      this.sweepRevived();
      this.revived.set(s.id, { ghost: g, at: Date.now() });
      this.ghosts.delete(s.id);
      this.saveGhosts();
    }
    this.pairsDirty = true;
    this.saveSolo();
    this.send({ t: "star", id: s.id, x: s.x, y: s.y, c: s.c });
    return s;
  }
  private sweepRevived(now = Date.now()) {
    for (const [id, r] of this.revived) if (now - r.at > REVIVED_TTL_MS) this.revived.delete(id);
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
    this.send({ t: "unstar", id: s.id });
  }
  // サーバーが断った星を、自分の画面からだけ取り消す（unstar は送らない）。
  // - 同じ id の星が自分のものでなければ（id の衝突など）、その星には触らない
  // - 幽霊からの復活だったなら（期限内）、幽霊に戻す
  // - そうでなければ、同じ id の幽霊も消す（置いてすぐ消した星。サーバーには最初から無い）
  rollbackStar(id: string) {
    const s = this.stars.get(id);
    if (s && this.isMine(s)) {
      this.stars.delete(id);
      this.dropLinksTouching(id);
      this.pairsDirty = true;
      this.saveSolo();
    }
    const now = Date.now();
    const r = this.revived.get(id);
    this.revived.delete(id);
    if (r && now - r.at <= REVIVED_TTL_MS) {
      this.ghosts.set(id, r.ghost);
      this.saveGhosts();
    } else if (this.ghosts.delete(id)) {
      this.saveGhosts();
    }
  }

  // 接続したときの空の全体（welcome）で、星と線を置き換える。
  // 前の空にあって新しい空に無い自分の星（寿命内）は、他人に消された・別の空に移ったので幽霊にする。
  // 新しい空で生きている星の幽霊は要らない
  replaceSky(stars: StarData[], links: LinkData[]) {
    const now = Date.now();
    const alive = new Set(stars.map((s) => s.id));
    let ghostsChanged = false;
    for (const s of this.stars.values()) {
      if (alive.has(s.id) || !this.isMine(s) || now - s.ts > ttlFor(s.n || 0)) continue;
      this.ghosts.set(s.id, { id: s.id, x: s.x, y: s.y, c: s.c, gone: now });
      ghostsChanged = true;
    }
    this.stars.clear();
    this.links.clear();
    for (const s of stars) {
      this.stars.set(s.id, s);
      if (this.ghosts.delete(s.id)) ghostsChanged = true;
    }
    for (const l of links) this.links.set(l.id, l);
    if (ghostsChanged) this.saveGhosts();
    this.pairsDirty = true;
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
  // 線を引いてサーバーへ送る。同じ 2 点の線がある・持ち主 ID が未確定・自分の線が上限なら null
  addLink(a: string, b: string): LinkData | null {
    const by = this.ownerId;
    if (!a || !b || a === b || by === null) return null;
    for (const l of this.links.values()) {
      if ((l.a === a && l.b === b) || (l.a === b && l.b === a)) return null;
    }
    const l = { id: crypto.randomUUID().slice(0, 12), a, b, by, ts: Date.now() };
    return this.restoreLink(l) ? l : null;
  }
  // 線を（アンドゥなどで）引き直す。自分の線が上限に達していたら引かずに false
  restoreLink(l: LinkData): boolean {
    if (this.countMine(this.links.values()) >= MAX_LINKS_PER_USER) return false;
    this.links.set(l.id, l);
    this.saveSolo();
    this.send({ t: "link", id: l.id, a: l.a, b: l.b });
    return true;
  }
  removeLink(id: string) {
    this.links.delete(id);
    this.saveSolo();
    this.send({ t: "unlink", id });
  }
  // サーバーが断った線を、自分の画面からだけ取り消す（unlink は送らない）
  rollbackLink(id: string) {
    if (this.links.delete(id)) this.saveSolo();
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
  // 幽霊を同じ id・位置・幽霊の色で復活させる。置けなければ（上限など）幽霊のまま null
  reviveGhost(g: Ghost): Star | null {
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
  // 他の人の位置を受け取った（新しい人なら補間の起点もそこにする）
  setPeer(id: string, x: number, y: number, c: number, now = Date.now()) {
    const p = this.peers.get(id);
    if (p) {
      p.x = x;
      p.y = y;
      p.c = c;
      p.seen = now;
    } else {
      this.peers.set(id, { x, y, rx: x, ry: y, c, seen: now });
    }
  }
  // 表示位置を補間で追いかける。leave を取りこぼした人は、しばらく位置が届かなければ消す
  // （粗い一覧は人数が多いと数秒おきなので、余裕を持たせる）
  updatePeers(dt: number, now = Date.now()) {
    for (const [id, p] of this.peers) {
      if (now - p.seen > PEER_STALE_MS) {
        this.peers.delete(id);
        continue;
      }
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
    this.sweepRevived(now);
  }
}
