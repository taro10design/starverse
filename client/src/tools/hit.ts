import { HIT_RADIUS } from "../constants";
import type { Camera } from "../camera";
import type { Universe, Star, Ghost } from "../universe";

// ---------------------------------------------------------------------------
// HitTester — 画面上の点に近い星 / 幽霊（hit px 以内）
// ---------------------------------------------------------------------------
export class HitTester {
  constructor(
    private camera: Camera,
    private universe: Universe,
  ) {}

  star(sx: number, sy: number, hit = HIT_RADIUS, exclude: string | null = null): Star | null {
    const [wx, wy] = this.camera.screenToWorld(sx, sy);
    return this.universe.getStarAt(wx, wy, hit / this.camera.scalePx(), exclude);
  }
  ghost(sx: number, sy: number, hit = 20): Ghost | null {
    const [wx, wy] = this.camera.screenToWorld(sx, sy);
    return this.universe.getGhostAt(wx, wy, hit / this.camera.scalePx());
  }
}
