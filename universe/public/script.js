// universe — 言葉のない空間。あなたは一点の光。他の光もいる。
const canvas = document.getElementById("space");
const ctx = canvas.getContext("2d");
const trail = document.createElement("canvas");
const tctx = trail.getContext("2d");

const DPR = Math.min(window.devicePixelRatio || 1, 2);
let W = 0, H = 0;

const player = { x: 0, y: 0, vx: 0, vy: 0, px: 0, py: 0 };
let target = null;
let stars = [];
let pulses = [];
let t0 = 0;

// --- 光の色パレット（自分の色を選べる） ---
const PALETTES = [
  { core: "#fff8ec", glow: [255, 190, 120] }, // あかり
  { core: "#ffe2da", glow: [255, 110, 90] },  // 朱
  { core: "#e2f6ff", glow: [110, 200, 255] }, // 水
  { core: "#e8ffe9", glow: [110, 230, 160] }, // 若葉
  { core: "#f4e8ff", glow: [190, 140, 255] }, // 藤
  { core: "#fff4c8", glow: [255, 205, 90] },  // 金
];
const PEER_COLOR = { core: "#dfe9ff", glow: [160, 190, 255] }; // 無色の他人用
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
    pulses.push({ x: player.x, y: player.y, r: 0, life: 1 });
    sendPos();
  });
  paletteEl.appendChild(b);
});
document.body.appendChild(paletteEl);

function resize() {
  W = innerWidth;
  H = innerHeight;
  for (const c of [canvas, trail]) {
    c.width = W * DPR;
    c.height = H * DPR;
  }
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  tctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
addEventListener("resize", resize);
resize();

player.x = W / 2;
player.y = H / 2;
player.px = player.x;
player.py = player.y;

const STAR_N = 140;
for (let i = 0; i < STAR_N; i++) {
  stars.push({
    x: Math.random() * W,
    y: Math.random() * H,
    vx: (Math.random() - 0.5) * 0.06,
    vy: (Math.random() - 0.5) * 0.06,
    r: 0.4 + Math.random() * 1.4,
    tw: Math.random() * Math.PI * 2,
    tws: 0.008 + Math.random() * 0.02,
    glow: 0,
    warm: Math.random() < 0.12,
  });
}

// --- 他の光たち（本物の人間） ---
const peers = new Map(); // id -> {x,y,rx,ry,c} 正規化座標
const fixed = new Map(); // id -> FixedStar 灯された星（正規化座標）
let pairsDirty = true;
let pairList = []; // [{a,b,binary}]
let ws = null;
let myId = null;
let retry = 1500;
let lastSend = 0;

const WS_HOST = location.hostname.endsWith("workers.dev")
  ? location.host
  : "universe.taroooo0w0.workers.dev";

function connect() {
  if (location.protocol === "file:") return;
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
      pairsDirty = true;
    } else if (m.t === "pulse") {
      pulses.push({ x: m.x * W, y: m.y * H, r: 0, life: 0.8 });
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

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function sendPos() {
  send({ t: "p", x: player.x / W, y: player.y / H, c: myColor });
}

// ポインタが来るまでは自分で漂う
function autopilot(t) {
  const s = t * 0.00022;
  return {
    x: W / 2 + Math.sin(s) * W * 0.18 + Math.sin(s * 2.7) * W * 0.06,
    y: H / 2 + Math.cos(s * 0.8) * H * 0.14 + Math.cos(s * 2.1) * H * 0.05,
  };
}

// 長押しで星を灯す / 自分の星をタップで消す
function placeStar(nx, ny) {
  const s = { id: crypto.randomUUID().slice(0, 12), x: nx, y: ny, c: myColor, by: myId || "me", ts: Date.now() };
  fixed.set(s.id, s);
  pairsDirty = true;
  send({ t: "star", id: s.id, x: s.x, y: s.y });
}
function unstarAt(x, y) {
  for (const s of fixed.values()) {
    const dx = s.x * W - x;
    const dy = s.y * H - y;
    if (dx * dx + dy * dy < 20 * 20 && (s.by === myId || s.by === "me")) {
      fixed.delete(s.id);
      pairsDirty = true;
      send({ t: "unstar", id: s.id });
      return;
    }
  }
}

let downAt = 0, downX = 0, downY = 0;
addEventListener("pointermove", (e) => {
  target = { x: e.clientX, y: e.clientY };
});
addEventListener("pointerdown", (e) => {
  target = { x: e.clientX, y: e.clientY };
  downAt = performance.now();
  downX = e.clientX;
  downY = e.clientY;
  pulses.push({ x: e.clientX, y: e.clientY, r: 0, life: 1 });
  send({ t: "pulse", x: e.clientX / W, y: e.clientY / H });
  ping();
  haptic();
});
addEventListener("pointerup", (e) => {
  if (e.target.closest && e.target.closest("#palette")) return;
  const held = performance.now() - downAt;
  const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
  if (moved > 12) return;
  if (held >= 400) {
    placeStar(e.clientX / W, e.clientY / H);
  } else {
    unstarAt(e.clientX, e.clientY);
  }
});

addEventListener("contextmenu", (e) => e.preventDefault());

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

// パルスの余韻としてほんのり鳴る音
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

function drawFixedStar(s, x, y, t) {
  const p = PALETTES[s.c % PALETTES.length] || PEER_COLOR;
  const tw = 0.7 + 0.3 * Math.sin(t * 0.002 + hashPhase(s.id) * 10);
  ctx.globalAlpha = 0.9 * tw;
  ctx.fillStyle = glowGradient(x, y, 14, p, 0.28);
  ctx.beginPath();
  ctx.arc(x, y, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.core;
  ctx.beginPath();
  ctx.arc(x, y, 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min((t - t0) / 16.7, 3) || 1;
  t0 = t;

  // --- player: バネでtargetへ ---
  const tgt = target || autopilot(t);
  player.px = player.x;
  player.py = player.y;
  player.vx += (tgt.x - player.x) * 0.028 * dt;
  player.vy += (tgt.y - player.y) * 0.028 * dt;
  player.vx *= Math.pow(0.90, dt);
  player.vy *= Math.pow(0.90, dt);
  player.x += player.vx * dt;
  player.y += player.vy * dt;

  // 位置を世界に送る（80ms間隔で十分滑らかに見える）
  if (t - lastSend > 80) {
    lastSend = t;
    sendPos();
  }

  // --- 軌跡レイヤー（残像） ---
  const pal = PALETTES[myColor];
  tctx.fillStyle = "rgba(4, 6, 18, 0.09)";
  tctx.fillRect(0, 0, W, H);
  const speed = Math.hypot(player.vx, player.vy);
  if (speed > 0.3) {
    tctx.strokeStyle = `rgba(${pal.glow.join(",")},0.55)`;
    tctx.lineWidth = 4.5;
    tctx.lineCap = "round";
    tctx.beginPath();
    tctx.moveTo(player.px, player.py);
    tctx.lineTo(player.x, player.y);
    tctx.stroke();
    tctx.strokeStyle = pal.core;
    tctx.lineWidth = 1.2;
    tctx.beginPath();
    tctx.moveTo(player.px, player.py);
    tctx.lineTo(player.x, player.y);
    tctx.stroke();
  }

  // --- 星 ---
  for (const s of stars) {
    s.tw += s.tws * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    if (s.x < 0) s.x += W;
    if (s.x > W) s.x -= W;
    if (s.y < 0) s.y += H;
    if (s.y > H) s.y -= H;

    // 近くを通ると吸い寄せられる（蛾みたいに）
    const dx = player.x - s.x;
    const dy = player.y - s.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 160 * 160) {
      const d = Math.sqrt(d2) || 1;
      const f = (1 - d / 160) * 0.06;
      s.vx += (dx / d) * f * dt;
      s.vy += (dy / d) * f * dt;
      s.glow = Math.min(1, s.glow + (1 - d / 160) * 0.05 * dt);
    }
    // パルスで弾かれる
    for (const p of pulses) {
      const pdx = s.x - p.x;
      const pdy = s.y - p.y;
      const pd = Math.sqrt(pdx * pdx + pdy * pdy) || 1;
      if (Math.abs(pd - p.r) < 30 && p.life > 0) {
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
    p.r += 6 * dt;
    p.life -= 0.02 * dt;
    if (p.life <= 0) pulses.splice(i, 1);
  }

  // --- 描画 ---
  const bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
  bg.addColorStop(0, "#0a1028");
  bg.addColorStop(1, "#03040d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.drawImage(trail, 0, 0, W, H);

  for (const s of stars) {
    const a = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(s.tw)) + s.glow * 0.4;
    ctx.globalAlpha = Math.min(1, a);
    ctx.fillStyle = s.warm ? "#ffd9a8" : "#bcd3ff";
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r * (1 + s.glow * 1.6), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // --- 灯された星・星座・連星 ---
  if (pairsDirty) {
    pairList = [];
    const arr = [...fixed.values()];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const dx = (arr[i].x - arr[j].x) * W;
        const dy = (arr[i].y - arr[j].y) * H;
        const d = Math.hypot(dx, dy);
        if (d < 110) pairList.push({ a: arr[i], b: arr[j], binary: d < 36 });
      }
    }
    pairsDirty = false;
  }

  // 星座線（連星は除く）
  ctx.strokeStyle = "rgba(200, 215, 255, 0.18)";
  ctx.lineWidth = 0.8;
  for (const pair of pairList) {
    if (pair.binary) continue;
    ctx.beginPath();
    ctx.moveTo(pair.a.x * W, pair.a.y * H);
    ctx.lineTo(pair.b.x * W, pair.b.y * H);
    ctx.stroke();
  }

  const drawn = new Set();
  for (const pair of pairList) {
    if (!pair.binary) continue;
    const { a, b } = pair;
    const mx = ((a.x + b.x) / 2) * W;
    const my = ((a.y + b.y) / 2) * H;
    const r = (Math.hypot((a.x - b.x) * W, (a.y - b.y) * H) / 2) || 8;
    const ang = t * 0.0006 + hashPhase(a.id) + hashPhase(b.id);
    drawFixedStar(a, mx + Math.cos(ang) * r, my + Math.sin(ang) * r, t);
    drawFixedStar(b, mx - Math.cos(ang) * r, my - Math.sin(ang) * r, t);
    drawn.add(a.id);
    drawn.add(b.id);
  }
  for (const s of fixed.values()) {
    if (!drawn.has(s.id)) drawFixedStar(s, s.x * W, s.y * H, t);
  }

  // --- 他の光（実在の誰か、色つき） ---
  for (const p of peers.values()) {
    p.rx += (p.x - p.rx) * Math.min(1, 0.12 * dt);
    p.ry += (p.y - p.ry) * Math.min(1, 0.12 * dt);
    const px = p.rx * W;
    const py = p.ry * H;
    const pc = typeof p.c === "number" ? PALETTES[p.c % PALETTES.length] : PEER_COLOR;
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = glowGradient(px, py, 18, pc, 0.3);
    ctx.beginPath();
    ctx.arc(px, py, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = pc.core;
    ctx.beginPath();
    ctx.arc(px, py, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const p of pulses) {
    ctx.strokeStyle = `rgba(255, 230, 200, ${0.5 * p.life})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // player glow
  ctx.fillStyle = glowGradient(player.x, player.y, 26, pal, 0.35);
  ctx.beginPath();
  ctx.arc(player.x, player.y, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = pal.core;
  ctx.beginPath();
  ctx.arc(player.x, player.y, 2.6, 0, Math.PI * 2);
  ctx.fill();
}
requestAnimationFrame(frame);
