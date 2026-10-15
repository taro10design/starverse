import { PALETTES, autopilot } from "../../constants.js";

// ---------------------------------------------------------------------------
// Player — 自分の光。バネでターゲットへ向かう
// ---------------------------------------------------------------------------
export class Player {
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
