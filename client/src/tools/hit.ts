import { HIT_RADIUS } from "../constants";
import type { Camera } from "../camera";
import type { Universe, Star, Ghost } from "../universe";

// 当たり判定に使う点（ワールド座標）。PointerInfo をそのまま渡せる
export interface WorldPoint {
  wx: number;
  wy: number;
}

// ---------------------------------------------------------------------------
// HitTester — ある点に近い星 / 幽霊（画面上で hit px 以内）
//
// 位置はワールド座標で受け取る。押してから確定するまでの間（Input の遅延確定）にカメラが動いても、
// 押した時点の位置（PointerInfo の wx / wy）で判定できるように、スクリーン座標からは変換し直さない。
// 半径は今の倍率で px からワールド単位に直す
// ---------------------------------------------------------------------------
export class HitTester {
  constructor(
    private camera: Camera,
    private universe: Universe,
  ) {}

  star(p: WorldPoint, hit = HIT_RADIUS, exclude: string | null = null): Star | null {
    return this.universe.getStarAt(p.wx, p.wy, hit / this.camera.scalePx(), exclude);
  }
  ghost(p: WorldPoint, hit = 20): Ghost | null {
    return this.universe.getGhostAt(p.wx, p.wy, hit / this.camera.scalePx());
  }
}
