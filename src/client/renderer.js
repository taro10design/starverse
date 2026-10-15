import { PALETTES, PEER_COLOR, ttlFor, MAP_SIZE } from "../../constants.js";
import { DPR, SOLO } from "./env.js";

// ---------------------------------------------------------------------------
// Renderer — Canvas 描画（背景・星・線・他人・波紋・ミニマップ）
// ---------------------------------------------------------------------------
export class Renderer {
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
