import { PALETTES } from "./constants";
import { DPR } from "./env";
import { demoFrame, DEMO_MS, type DemoFrame, type DemoKind } from "./demo";

// ---------------------------------------------------------------------------
// DemoView — 見本の動き（demo.ts）を小さなキャンバスに描く
//
// 見えている間だけ requestAnimationFrame で回す（隠れたタブ・閉じたパネルでは止める）。
// 「視差効果を減らす」（prefers-reduced-motion）の設定がある人には、動かさずに要点の 1 コマを出す
// ---------------------------------------------------------------------------

const REDUCED_MOTION_AT = 0.62; // 動かさないときに出すコマ（どの見本でも結果が見えている時刻）
const STAR = PALETTES[0];
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export class DemoView {
  readonly canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D | null;
  private kind: DemoKind | null = null;
  private raf = 0;
  private t0 = 0;

  constructor(
    private w: number,
    private h: number,
  ) {
    this.canvas.className = "demo";
    this.canvas.width = w * DPR;
    this.canvas.height = h * DPR;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.setAttribute("aria-hidden", "true"); // 説明は隣の文が担う
    this.ctx = this.canvas.getContext("2d");
  }

  play(kind: DemoKind) {
    if (this.kind === kind && this.raf) return;
    this.stop();
    this.kind = kind;
    this.t0 = performance.now();
    if (reducedMotion()) {
      this.draw(demoFrame(kind, DEMO_MS * REDUCED_MOTION_AT));
      return;
    }
    const tick = (now: number) => {
      // パネルが閉じた・要素が外れたら止める（隠れたタブでは requestAnimationFrame 自体が止まる）
      if (!this.canvas.isConnected || this.kind !== kind) return this.stop();
      this.draw(demoFrame(kind, now - this.t0));
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.kind = null;
  }

  private draw(f: DemoFrame) {
    const { ctx, w, h } = this;
    if (!ctx) return;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = "#070b1c";
    ctx.fillRect(0, 0, w, h);
    // 拡大は小窓の中心を基準にする（星と線だけ。指は画面に対して動くので倍率を掛けない）
    const wx = (p: { x: number }) => (p.x - 0.5) * f.zoom * w + w / 2;
    const wy = (p: { y: number }) => (p.y - 0.5) * f.zoom * h + h / 2;
    const sx = (p: { x: number }) => p.x * w;
    const sy = (p: { y: number }) => p.y * h;
    const glow = STAR.glow.join(",");

    ctx.lineWidth = 1;
    for (const [a, b] of f.links) {
      ctx.strokeStyle = `rgba(${glow},0.55)`;
      ctx.beginPath();
      ctx.moveTo(wx(a), wy(a));
      ctx.lineTo(wx(b), wy(b));
      ctx.stroke();
    }
    if (f.preview) {
      const [a, b] = f.preview;
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = `rgba(${glow},0.4)`;
      ctx.beginPath();
      ctx.moveTo(wx(a), wy(a));
      ctx.lineTo(sx(b), sy(b));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const s of f.stars) {
      const r = 2.2 * Math.sqrt(f.zoom);
      ctx.fillStyle = s.ghost ? "rgba(170,185,230,0.25)" : `rgba(${glow},0.35)`;
      ctx.beginPath();
      ctx.arc(wx(s), wy(s), r * 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = s.ghost ? "rgba(200,210,240,0.35)" : STAR.core;
      ctx.beginPath();
      ctx.arc(wx(s), wy(s), r, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const r of f.ripples) {
      ctx.strokeStyle = `rgba(200,215,255,${0.6 * r.a})`;
      ctx.beginPath();
      ctx.arc(sx(r), sy(r), r.r * Math.min(w, h), 0, Math.PI * 2);
      ctx.stroke();
    }
    // 自分の光
    ctx.fillStyle = "rgba(255,200,130,0.3)";
    ctx.beginPath();
    ctx.arc(wx(f.light), wy(f.light), 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff8ec";
    ctx.beginPath();
    ctx.arc(wx(f.light), wy(f.light), 2.4, 0, Math.PI * 2);
    ctx.fill();
    // 指（押している間は小さく濃く）
    for (const g of f.fingers) {
      ctx.fillStyle = g.down ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.22)";
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.beginPath();
      ctx.arc(sx(g), sy(g), g.down ? 6 : 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}
