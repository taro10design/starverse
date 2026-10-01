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
const peers = new Map(); // id -> {x,y,rx,ry} 正規化座標
let ws = null;
let myId = null;
let retry = 1500;
let lastSend = 0;

function connect() {
  if (location.protocol === "file:") return;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${scheme}://${location.host}/ws`);

  ws.onopen = () => {
    retry = 1500;
    sendPos();
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "welcome") {
      myId = m.id;
      for (const d of m.dots) peers.set(d.id, { x: d.x, y: d.y, rx: d.x, ry: d.y });
    } else if (m.t === "p") {
      const p = peers.get(m.id) || { x: m.x, y: m.y, rx: m.x, ry: m.y };
      p.x = m.x;
      p.y = m.y;
      peers.set(m.id, p);
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
  send({ t: "p", x: player.x / W, y: player.y / H });
}

// ポインタが来るまでは自分で漂う
function autopilot(t) {
  const s = t * 0.00022;
  return {
    x: W / 2 + Math.sin(s) * W * 0.18 + Math.sin(s * 2.7) * W * 0.06,
    y: H / 2 + Math.cos(s * 0.8) * H * 0.14 + Math.cos(s * 2.1) * H * 0.05,
  };
}

addEventListener("pointermove", (e) => {
  target = { x: e.clientX, y: e.clientY };
});
addEventListener("pointerdown", (e) => {
  target = { x: e.clientX, y: e.clientY };
  pulses.push({ x: e.clientX, y: e.clientY, r: 0, life: 1 });
  send({ t: "pulse", x: e.clientX / W, y: e.clientY / H });
  ping();
  haptic();
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
  tctx.fillStyle = "rgba(4, 6, 18, 0.09)";
  tctx.fillRect(0, 0, W, H);
  const speed = Math.hypot(player.vx, player.vy);
  if (speed > 0.3) {
    tctx.strokeStyle = "rgba(255, 214, 170, 0.55)";
    tctx.lineWidth = 4.5;
    tctx.lineCap = "round";
    tctx.beginPath();
    tctx.moveTo(player.px, player.py);
    tctx.lineTo(player.x, player.y);
    tctx.stroke();
    tctx.strokeStyle = "rgba(255, 245, 230, 0.9)";
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

  // --- 他の光（実在の誰か） ---
  for (const p of peers.values()) {
    p.rx += (p.x - p.rx) * Math.min(1, 0.12 * dt);
    p.ry += (p.y - p.ry) * Math.min(1, 0.12 * dt);
    const px = p.rx * W;
    const py = p.ry * H;
    const g = ctx.createRadialGradient(px, py, 0, px, py, 18);
    g.addColorStop(0, "rgba(210, 228, 255, 0.8)");
    g.addColorStop(0.3, "rgba(160, 190, 255, 0.25)");
    g.addColorStop(1, "rgba(140, 170, 255, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#dfe9ff";
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
  const g = ctx.createRadialGradient(player.x, player.y, 0, player.x, player.y, 26);
  g.addColorStop(0, "rgba(255, 244, 225, 0.95)");
  g.addColorStop(0.25, "rgba(255, 190, 120, 0.35)");
  g.addColorStop(1, "rgba(255, 160, 90, 0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(player.x, player.y, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff8ec";
  ctx.beginPath();
  ctx.arc(player.x, player.y, 2.6, 0, Math.PI * 2);
  ctx.fill();
}
requestAnimationFrame(frame);
