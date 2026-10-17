import { PALETTES, autopilot } from "./constants";
import type { Palette } from "./constants";
import { storage } from "./storage";
import { clampColor } from "./validate";

// ---------------------------------------------------------------------------
// Player — 自分の光。バネでターゲットへ向かう
// ---------------------------------------------------------------------------
export class Player {
  x = 0.5;
  y = 0.5;
  vx = 0;
  vy = 0;
  target: { x: number; y: number } | null = null; // ポインタが来るまでは自分で漂う
  colorIndex = 0;

  constructor() {
    this.colorIndex = clampColor(storage.get("uchu-color")); // 壊れた値でもパレットの範囲に収める
  }
  get palette(): Palette {
    return PALETTES[this.colorIndex];
  }
  setColor(i: number) {
    this.colorIndex = clampColor(i);
    storage.set("uchu-color", String(this.colorIndex));
  }
  update(dt: number, t: number) {
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
