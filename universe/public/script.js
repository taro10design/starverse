// universe — 言葉のない空間。あなたは一点の光。他の光もいる。
const canvas = document.getElementById("space");
const ctx = canvas.getContext("2d");

const DPR = Math.min(window.devicePixelRatio || 1, 2);
let W = 0, H = 0;

// ワールド座標は0..1の正規化。カメラが世界のどこを見ているかを持つ
const cam = { cx: 0.5, cy: 0.5, z: 1 };
const SOLO = new URLSearchParams(location.search).has("solo");

const player = { x: 0.5, y: 0.5, vx: 0, vy: 0, px: 0.5, py: 0.5 };
let target = null;
let stars = [];
let pulses = [];
let t0 = 0;

function scalePx() {
  return cam.z * Math.min(W, H);
}
function w2s(x, y) {
  return [(x - cam.cx) * scalePx() + W / 2, (y - cam.cy) * scalePx() + H / 2];
}
function s2w(x, y) {
  return [(x - W / 2) / scalePx() + cam.cx, (y - H / 2) / scalePx() + cam.cy];
}

// --- 光の色パレット ---
const PALETTES = [
  { core: "#fff8ec", glow: [255, 200, 130] }, // あかり
  { core: "#ffd9d4", glow: [255, 90, 70] },   // 赤
  { core: "#fff3c4", glow: [255, 200, 60] },  // 金
  { core: "#e3ffd8", glow: [90, 230, 110] },  // 緑
  { core: "#d8fbff", glow: [80, 210, 255] },  // 水
  { core: "#dce4ff", glow: [90, 120, 255] },  // 青
  { core: "#f0e0ff", glow: [180, 110, 255] }, // 藤
  { core: "#ffe0ee", glow: [255, 120, 180] }, // 桃
];
const PEER_COLOR = { core: "#dfe9ff", glow: [160, 190, 255] };
let myColor = Math.min(+(localStorage.getItem("uchu-color") || 0), PALETTES.length - 1);

const paletteEl = document.createElement("div");
paletteEl.id = "palette";
PALETTES.forEach((p, i) => {
  const b = document.createElement("button");
  b.className = "swatch" + (i === myColor ? " sel" : "");
  b.style.setProperty("--c", p.core);
  b.style.setProperty("--g", `rgba(${p.glow.join(",")},0.6)`);
  b.setAttribute("aria-label", "color " + i);
  b.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    myColor = i;
    localStorage.setItem("uchu-color", String(i));
    paletteEl.querySelectorAll(".swatch").forEach((el, j) => el.classList.toggle("sel", j === i));
    pulses.push({ x: player.x, y: player.y, r: 0, life: 1, col: p.glow });
    sendPos();
  });
  paletteEl.appendChild(b);
});
document.body.appendChild(paletteEl);

// --- ひとり/みんな トグル ---
const modeBtn = document.createElement("button");
modeBtn.id = "mode";
modeBtn.title = SOLO ? "みんなの宇宙へ" : "ひとりの宇宙へ";
modeBtn.innerHTML = SOLO
  ? '<span class="dot1"></span><span class="lbl">ひとり</span>'
  : '<span class="dot1"></span><span class="dot1"></span><span class="lbl">みんな</span>';
modeBtn.addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  location.href = SOLO ? location.pathname : location.pathname + "?solo";
});
document.body.appendChild(modeBtn);

// --- 説明パネル ---
const helpBtn = document.createElement("button");
helpBtn.id = "helpbtn";
helpBtn.textContent = "?";
const help = document.createElement("div");
help.id = "help";
help.innerHTML = `
  <p>動かす — 光がついてくる</p>
  <p>タップ — 光の波</p>
  <p>長押し — 星を灯す</p>
  <p>近くの星どうし — 線がつながって星座に</p>
  <p>星から星へ長押しで引っぱる — 自分で線を引く</p>
  <p>すごく近い2つ — 連星になって回る</p>
  <p>自分の星をタップ — 消える</p>
  <p>ピンチ / ホイール — ズーム</p>
  <p>下の点 — 自分の色</p>
  <p>右上の地図 — 触れた場所へ光を送る</p>
  <p>右下 — ひとりの宇宙と切り替え</p>
  <p class="dim">${SOLO ? "ひとりの宇宙。星はここに残る" : "同じ空を誰かと見ている。星は24時間で消える"}</p>
`;
helpBtn.addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  help.classList.toggle("open");
});
document.body.appendChild(helpBtn);
document.body.appendChild(help);
if (!localStorage.getItem("uchu-seen")) {
  help.classList.add("open");
}

// --- 右上のちいさな地図 ---
const MAP = 108;
const map = document.createElement("canvas");
map.id = "minimap";
map.width = MAP * DPR;
map.height = MAP * DPR;
const mctx = map.getContext("2d");
mctx.setTransform(DPR, 0, 0, DPR, 0, 0);
document.body.appendChild(map);
let mapBounds = { x0: 0, y0: 0, s: 1 };
let mapDrag = false;
let freeCam = false;

function mapToWorld(mx, my) {
  const { x0, y0, s } = mapBounds;
  return [x0 + (mx / MAP) * s, y0 + (my / MAP) * s];
}
map.addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  mapDrag = true;
  const [wx, wy] = mapToWorld(e.offsetX, e.offsetY);
  target = { x: wx, y: wy };
  freeCam = false;
});

function resize() {
  W = innerWidth;
  H = innerHeight;
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
addEventListener("resize", resize);
resize();

const STAR_N = 140;
for (let i = 0; i < STAR_N; i++) {
  stars.push({
    x: Math.random() * W,
    y: Math.random() * H,
    vx: (Math.random() - 0.5) * 0.14,
    vy: (Math.random() - 0.5) * 0.14,
    r: 0.4 + Math.random() * 1.4,
    tw: Math.random() * Math.PI * 2,
    tws: 0.008 + Math.random() * 0.02,
    glow: 0,
    warm: Math.random() < 0.12,
  });
}

// --- 他の光たち（本物の人間） ---
const peers = new Map(); // id -> {x,y,rx,ry,c}
const fixed = new Map(); // id -> FixedStar（ワールド座標）
const links = new Map(); // id -> {id,a,b,by,ts}　誰かが手で引いた線
let pairsDirty = true;
let pairList = [];
let ws = null;
let myId = null;
let retry = 1500;
let lastSend = 0;

const WS_HOST = location.hostname.endsWith("workers.dev")
  ? location.host
  : "universe.taroooo0w0.workers.dev";

function connect() {
  if (SOLO || location.protocol === "file:") return;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${scheme}://${WS_HOST}/ws`);

  ws.onopen = () => {
    retry = 1500;
    sendPos();
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "welcome") {
      myId = m.id;
      for (const d of m.dots) peers.set(d.id, { x: d.x, y: d.y, rx: d.x, ry: d.y, c: d.c });
      for (const s of m.stars || []) fixed.set(s.id, s);
      for (const l of m.links || []) links.set(l.id, l);
      pairsDirty = true;
    } else if (m.t === "p") {
      const p = peers.get(m.id) || { x: m.x, y: m.y, rx: m.x, ry: m.y, c: m.c };
      p.x = m.x;
      p.y = m.y;
      if (typeof m.c === "number") p.c = m.c;
      peers.set(m.id, p);
    } else if (m.t === "star") {
      fixed.set(m.id, m);
      pairsDirty = true;
    } else if (m.t === "unstar") {
      fixed.delete(m.id);
      dropLinksTouching(m.id);
      pairsDirty = true;
    } else if (m.t === "link") {
      links.set(m.id, m);
    } else if (m.t === "unlink") {
      links.delete(m.id);
    } else if (m.t === "pulse") {
      pulses.push({ x: m.x, y: m.y, r: 0, life: 0.8, col: typeof m.c === "number" ? PALETTES[m.c % PALETTES.length].glow : [255, 230, 200] });
    } else if (m.t === "leave") {
      peers.delete(m.id);
    }
  };
  ws.onclose = () => {
    peers.clear();
    setTimeout(connect, retry);
    retry = Math.min(retry * 1.6, 15000);
  };
  ws.onerror = () => ws.close();
}
connect();

// ソロモード：自分の星はlocalStorageに残る（消えない個人の空）
function soloLoad() {
  try {
    const saved = JSON.parse(localStorage.getItem("uchu-solo") || "null");
    const arr = saved ? saved.stars : JSON.parse(localStorage.getItem("uchu-solo-stars") || "[]");
    for (const s of arr || []) fixed.set(s.id, s);
    for (const l of (saved && saved.links) || []) links.set(l.id, l);
    pairsDirty = true;
  } catch {}
}
function soloSave() {
  if (!SOLO) return;
  try {
    localStorage.setItem("uchu-solo", JSON.stringify({ stars: [...fixed.values()], links: [...links.values()] }));
  } catch {}
}
if (SOLO) {
  myId = "me";
  soloLoad();
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function sendPos() {
  send({ t: "p", x: player.x, y: player.y, c: myColor });
}

// ポインタが来るまでは自分で漂う
function autopilot(t) {
  const s = t * 0.00022;
  return {
    x: 0.5 + Math.sin(s) * 0.12 + Math.sin(s * 2.7) * 0.04,
    y: 0.5 + Math.cos(s * 0.8) * 0.1 + Math.cos(s * 2.1) * 0.04,
  };
}

// --- ジェスチャー ---
const pointers = new Map();
let pinch = null;
let downAt = 0, downX = 0, downY = 0, downTarget = null;
let pendingStar = null, linkTimer = 0, linking = null, linkTip = null;

// 画面上の点に一番近い星を返す（hit px 以内）
function starAt(sx, sy, hit = 18, exclude = null) {
  const [wx, wy] = s2w(sx, sy);
  const h = hit / scalePx();
  let best = null, bd = h * h;
  for (const s of fixed.values()) {
    if (s.id === exclude) continue;
    const dx = s.x - wx, dy = s.y - wy, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
function dropLinksTouching(starId) {
  for (const [lid, l] of links) {
    if (l.a === starId || l.b === starId) links.delete(lid);
  }
}
function addLink(a, b) {
  if (!a || !b || a === b) return;
  for (const l of links.values()) {
    if ((l.a === a && l.b === b) || (l.a === b && l.b === a)) return;
  }
  const l = { id: crypto.randomUUID().slice(0, 12), a, b, by: myId || "me", ts: Date.now() };
  links.set(l.id, l);
  soloSave();
  send({ t: "link", a, b });
  ping();
}

function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function dist2(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

addEventListener("pointerdown", (e) => {
  downTarget = e.target;
  if (e.target !== canvas) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const m = mid(a, b);
    pinch = { d0: dist2(a, b), z0: cam.z, wx: s2w(m.x, m.y)[0], wy: s2w(m.x, m.y)[1] };
    return;
  }
  const [wx, wy] = s2w(e.clientX, e.clientY);
  target = { x: wx, y: wy };
  downAt = performance.now();
  downX = e.clientX;
  downY = e.clientY;
  pendingStar = starAt(e.clientX, e.clientY);
  if (pendingStar) {
    linkTimer = setTimeout(() => {
      if (pointers.size === 1 && pendingStar) linking = pendingStar;
    }, 400);
  }
  pulses.push({ x: wx, y: wy, r: 0, life: 1, col: PALETTES[myColor].glow });
  send({ t: "pulse", x: wx, y: wy, c: myColor });
  ping();
  haptic();
});

addEventListener("pointermove", (e) => {
  if (mapDrag) {
    const r = map.getBoundingClientRect();
    const [wx, wy] = mapToWorld(e.clientX - r.left, e.clientY - r.top);
    target = { x: wx, y: wy };
    return;
  }
  if (linking) {
    linkTip = s2w(e.clientX, e.clientY);
    return;
  }
  if (pendingStar && Math.hypot(e.clientX - downX, e.clientY - downY) > 14) {
    pendingStar = null; // 星から動き出した＝長押しリンクではない
    clearTimeout(linkTimer);
  }
  const p = pointers.get(e.pointerId);
  if (p) {
    p.x = e.clientX;
    p.y = e.clientY;
  }
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const m = mid(a, b);
    cam.z = Math.min(100, Math.max(0.05, pinch.z0 * (dist2(a, b) / pinch.d0)));
    cam.cx = pinch.wx - (m.x - W / 2) / scalePx();
    cam.cy = pinch.wy - (m.y - H / 2) / scalePx();
    freeCam = true;
    return;
  }
  if (pointers.size <= 1) {
    target = { x: s2w(e.clientX, e.clientY)[0], y: s2w(e.clientX, e.clientY)[1] };
    freeCam = false;
  }
});

addEventListener("pointerup", (e) => {
  const wasPinch = pinch !== null;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  mapDrag = false;
  clearTimeout(linkTimer);
  if (linking) {
    const b = starAt(e.clientX, e.clientY, 22, linking.id);
    if (b) addLink(linking.id, b.id);
    linking = null;
    pendingStar = null;
    linkTip = null;
    return;
  }
  pendingStar = null;
  if (wasPinch || pointers.size > 0) return;
  if (downTarget !== canvas) return;

  const held = performance.now() - downAt;
  const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
  if (moved > 12) return;
  if (held >= 400) {
    placeStar(...s2w(e.clientX, e.clientY));
  } else {
    unstarAt(e.clientX, e.clientY);
  }
});
addEventListener("pointercancel", (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  mapDrag = false;
  clearTimeout(linkTimer);
  linking = pendingStar = linkTip = null;
});

addEventListener(
  "wheel",
  (e) => {
    if (e.target !== canvas) return;
    e.preventDefault();
    const [wx, wy] = s2w(e.clientX, e.clientY);
    cam.z = Math.min(100, Math.max(0.05, cam.z * Math.exp(-e.deltaY * 0.0012)));
    cam.cx = wx - (e.clientX - W / 2) / scalePx();
    cam.cy = wy - (e.clientY - H / 2) / scalePx();
    freeCam = true;
  },
  { passive: false }
);

addEventListener("contextmenu", (e) => e.preventDefault());
addEventListener("pointerdown", (e) => {
  if (help.classList.contains("open") && e.target !== helpBtn && !(e.target.closest && e.target.closest("#help"))) {
    help.classList.remove("open");
    localStorage.setItem("uchu-seen", "1");
  }
});

function placeStar(nx, ny) {
  const s = { id: crypto.randomUUID().slice(0, 12), x: nx, y: ny, c: myColor, by: myId || "me", ts: Date.now() };
  fixed.set(s.id, s);
  pairsDirty = true;
  soloSave();
  send({ t: "star", id: s.id, x: s.x, y: s.y });
}
function unstarAt(x, y) {
  const s = starAt(x, y, 20);
  if (s && (s.by === myId || s.by === "me")) {
    fixed.delete(s.id);
    dropLinksTouching(s.id);
    pairsDirty = true;
    soloSave();
    send({ t: "unstar", id: s.id });
  }
}

// Androidはnavigator.vibrate、iOS Safariはswitchハックで触覚を出す
let hapticEl = null;
function haptic() {
  try {
    if (navigator.vibrate && navigator.vibrate(12)) return;
  } catch {}
  try {
    if (!hapticEl) {
      hapticEl = document.createElement("input");
      hapticEl.type = "checkbox";
      hapticEl.setAttribute("switch", "");
      hapticEl.style.cssText = "position:fixed;top:-200px;opacity:0;pointer-events:none";
      document.body.appendChild(hapticEl);
    }
    hapticEl.click();
  } catch {}
}

let actx = null;
function ping() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
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

function glowGradient(x, y, radius, p, midAlpha) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
  g.addColorStop(0, p.core);
  g.addColorStop(0.3, `rgba(${p.glow.join(",")},${midAlpha})`);
  g.addColorStop(1, `rgba(${p.glow.join(",")},0)`);
  return g;
}

function hashPhase(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (h % 628) / 100;
}

// 点の見た目の大きさはズームの平方根でだけスケール（物理サイズではなく「見え方」優先）
function dotScale() {
  return Math.sqrt(cam.z);
}

function drawFixedStar(s, wx, wy, t) {
  const [x, y] = w2s(wx, wy);
  if (x < -30 || x > W + 30 || y < -30 || y > H + 30) return;
  const p = PALETTES[s.c % PALETTES.length] || PEER_COLOR;
  const tw = 0.7 + 0.3 * Math.sin(t * 0.002 + hashPhase(s.id) * 10);
  const r = 14 * dotScale();
  ctx.globalAlpha = 0.9 * tw;
  ctx.fillStyle = glowGradient(x, y, r, p, 0.28);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.core;
  ctx.beginPath();
  ctx.arc(x, y, 2.2 * dotScale(), 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

// ミニマップ：世界全体を俯瞰。星・他人・自分・今見ている範囲を描く
function drawMap() {
  let x0 = 0, y0 = 0, x1 = 1, y1 = 1;
  const corners = [s2w(0, 0), s2w(W, 0), s2w(W, H), s2w(0, H)];
  for (const s of fixed.values()) {
    if (s.x < x0) x0 = s.x; if (s.x > x1) x1 = s.x;
    if (s.y < y0) y0 = s.y; if (s.y > y1) y1 = s.y;
  }
  for (const p of peers.values()) {
    if (p.rx < x0) x0 = p.rx; if (p.rx > x1) x1 = p.rx;
    if (p.ry < y0) y0 = p.ry; if (p.ry > y1) y1 = p.ry;
  }
  for (const pt of [...corners, [player.x, player.y]]) {
    if (pt[0] < x0) x0 = pt[0]; if (pt[0] > x1) x1 = pt[0];
    if (pt[1] < y0) y0 = pt[1]; if (pt[1] > y1) y1 = pt[1];
  }
  const pad = 0.12 * Math.max(x1 - x0, y1 - y0);
  const s = Math.max(x1 - x0, y1 - y0) + pad * 2;
  mapBounds = { x0: (x0 + x1) / 2 - s / 2, y0: (y0 + y1) / 2 - s / 2, s };
  const M = (wx, wy) => [((wx - mapBounds.x0) / s) * MAP, ((wy - mapBounds.y0) / s) * MAP];

  mctx.clearRect(0, 0, MAP, MAP);
  mctx.fillStyle = "rgba(8, 12, 30, 0.55)";
  mctx.fillRect(0, 0, MAP, MAP);

  // 灯された星
  for (const st of fixed.values()) {
    const [x, y] = M(st.x, st.y);
    if (x < 0 || x > MAP || y < 0 || y > MAP) continue;
    const p = PALETTES[st.c % PALETTES.length];
    mctx.fillStyle = p.core;
    mctx.globalAlpha = 0.85;
    mctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
  }
  // 他の光
  for (const p of peers.values()) {
    const [x, y] = M(p.rx, p.ry);
    const pc = typeof p.c === "number" ? PALETTES[p.c % PALETTES.length] : PEER_COLOR;
    mctx.globalAlpha = 0.9;
    mctx.fillStyle = pc.core;
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
  const pal = PALETTES[myColor];
  mctx.fillStyle = pal.core;
  mctx.shadowColor = `rgb(${pal.glow.join(",")})`;
  mctx.shadowBlur = 5;
  mctx.beginPath();
  mctx.arc(px, py, 2.2, 0, Math.PI * 2);
  mctx.fill();
  mctx.shadowBlur = 0;
  mctx.globalAlpha = 1;
}

function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min((t - t0) / 16.7, 3) || 1;
  t0 = t;

  // --- player: バネでtargetへ（ワールド座標） ---
  const tgt = target || autopilot(t);
  player.px = player.x;
  player.py = player.y;
  const k = 0.028; // ワールド座標系なので画面サイズで割らない
  player.vx += (tgt.x - player.x) * k * dt;
  player.vy += (tgt.y - player.y) * k * dt;
  player.vx *= Math.pow(0.90, dt);
  player.vy *= Math.pow(0.90, dt);
  player.x += player.vx * dt;
  player.y += player.vy * dt;

  // 自分の光が画面端に行きそうならカメラが寄り添う（ズーム/地図操作中は解除）
  const [psx, psy] = w2s(player.x, player.y);
  if (!freeCam) {
    const mx = W * 0.22, my = H * 0.22;
    if (psx < mx) cam.cx -= (mx - psx) / scalePx();
    if (psx > W - mx) cam.cx += (psx - (W - mx)) / scalePx();
    if (psy < my) cam.cy -= (my - psy) / scalePx();
    if (psy > H - my) cam.cy += (psy - (H - my)) / scalePx();
  }

  if (t - lastSend > 80) {
    lastSend = t;
    sendPos();
  }

  const [ppsx, ppsy] = w2s(player.x, player.y);

  // --- 背景の星（スクリーン座標の静かな層） ---
  for (const s of stars) {
    s.tw += s.tws * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    if (s.x < 0) s.x += W;
    if (s.x > W) s.x -= W;
    if (s.y < 0) s.y += H;
    if (s.y > H) s.y -= H;

    const dx = ppsx - s.x;
    const dy = ppsy - s.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 160 * 160) {
      const d = Math.sqrt(d2) || 1;
      const f = (1 - d / 160) * 0.06;
      s.vx += (dx / d) * f * dt;
      s.vy += (dy / d) * f * dt;
      s.glow = Math.min(1, s.glow + (1 - d / 160) * 0.05 * dt);
    }
    for (const p of pulses) {
      const [qx, qy] = w2s(p.x, p.y);
      const pdx = s.x - qx;
      const pdy = s.y - qy;
      const pd = Math.sqrt(pdx * pdx + pdy * pdy) || 1;
      const pr = p.r * scalePx();
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

  // --- パルス ---
  for (let i = pulses.length - 1; i >= 0; i--) {
    const p = pulses[i];
    p.r += (6 / Math.min(W, H)) * dt;
    p.life -= 0.02 * dt;
    if (p.life <= 0) pulses.splice(i, 1);
  }

  // --- 描画 ---
  const bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
  bg.addColorStop(0, "#0a1028");
  bg.addColorStop(1, "#03040d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  for (const s of stars) {
    const a = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(s.tw)) + s.glow * 0.4;
    ctx.globalAlpha = Math.min(1, a);
    ctx.fillStyle = s.warm ? "#ffd9a8" : "#bcd3ff";
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r * (1 + s.glow * 1.6), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // --- 灯された星・星座・連星（ワールド座標） ---
  if (pairsDirty) {
    pairList = [];
    const arr = [...fixed.values()];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const d = Math.hypot(arr[i].x - arr[j].x, arr[i].y - arr[j].y);
        if (d < 0.10) pairList.push({ a: arr[i], b: arr[j], binary: d < 0.032 });
      }
    }
    pairsDirty = false;
  }

  ctx.strokeStyle = "rgba(200, 215, 255, 0.18)";
  ctx.lineWidth = 0.8 * dotScale();
  for (const pair of pairList) {
    if (pair.binary) continue;
    const [ax, ay] = w2s(pair.a.x, pair.a.y);
    const [bx, by] = w2s(pair.b.x, pair.b.y);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }

  const drawn = new Set();
  const orbitPos = new Map(); // 連星メンバーの今のワールド座標
  for (const pair of pairList) {
    if (!pair.binary) continue;
    const { a, b } = pair;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const r = Math.hypot(a.x - b.x, a.y - b.y) / 2 || 0.008;
    const ang = t * 0.0006 + hashPhase(a.id) + hashPhase(b.id);
    const ap = [mx + Math.cos(ang) * r, my + Math.sin(ang) * r];
    const bp = [mx - Math.cos(ang) * r, my - Math.sin(ang) * r];
    orbitPos.set(a.id, ap);
    orbitPos.set(b.id, bp);
    drawFixedStar(a, ap[0], ap[1], t);
    drawFixedStar(b, bp[0], bp[1], t);
    drawn.add(a.id);
    drawn.add(b.id);
  }
  for (const s of fixed.values()) {
    if (!drawn.has(s.id)) drawFixedStar(s, s.x, s.y, t);
  }

  // 手で引かれた線（意図の線。自動の星座線より少し明るい）
  ctx.strokeStyle = "rgba(225, 230, 255, 0.3)";
  ctx.lineWidth = 1 * dotScale();
  for (const l of links.values()) {
    const a = fixed.get(l.a), b = fixed.get(l.b);
    if (!a || !b) continue;
    const [ax, ay] = w2s(...(orbitPos.get(l.a) || [a.x, a.y]));
    const [bx, by] = w2s(...(orbitPos.get(l.b) || [b.x, b.y]));
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }
  // 引き途中の線
  if (linking && linkTip) {
    const [ax, ay] = w2s(linking.x, linking.y);
    const [bx, by] = w2s(linkTip[0], linkTip[1]);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(235, 240, 255, 0.55)";
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.restore();
  }

  // --- 他の光（実在の誰か、色つき） ---
  for (const p of peers.values()) {
    p.rx += (p.x - p.rx) * Math.min(1, 0.12 * dt);
    p.ry += (p.y - p.ry) * Math.min(1, 0.12 * dt);
    const [px, py] = w2s(p.rx, p.ry);
    if (px < -40 || px > W + 40 || py < -40 || py > H + 40) continue;
    const pc = typeof p.c === "number" ? PALETTES[p.c % PALETTES.length] : PEER_COLOR;
    const r = 18 * dotScale();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = glowGradient(px, py, r, pc, 0.3);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = pc.core;
    ctx.beginPath();
    ctx.arc(px, py, 1.8 * dotScale(), 0, Math.PI * 2);
    ctx.fill();
  }

  for (const p of pulses) {
    const [px, py] = w2s(p.x, p.y);
    ctx.strokeStyle = `rgba(${p.col.join(",")},${0.5 * p.life})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(px, py, p.r * scalePx(), 0, Math.PI * 2);
    ctx.stroke();
  }

  // player glow
  const pal = PALETTES[myColor];
  const pr = 26 * dotScale();
  ctx.fillStyle = glowGradient(ppsx, ppsy, pr, pal, 0.35);
  ctx.beginPath();
  ctx.arc(ppsx, ppsy, pr, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = pal.core;
  ctx.beginPath();
  ctx.arc(ppsx, ppsy, 2.6 * dotScale(), 0, Math.PI * 2);
  ctx.fill();

  drawMap();
}
requestAnimationFrame(frame);
