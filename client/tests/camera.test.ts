import { describe, expect, it } from "vitest";
import { Camera } from "../src/camera";
import type { Player } from "../src/player";

const cam = () => {
  const c = new Camera();
  c.resize(1000, 700);
  return c;
};

describe("Camera", () => {
  it("ワールド座標とスクリーン座標が相互に変換できる", () => {
    const c = cam();
    c.cx = 0.3;
    c.cy = 0.8;
    c.z = 2.5;
    const [sx, sy] = c.worldToScreen(0.45, 0.6);
    const [wx, wy] = c.screenToWorld(sx, sy);
    expect(wx).toBeCloseTo(0.45, 10);
    expect(wy).toBeCloseTo(0.6, 10);
  });

  it("カメラの中心は画面の中心に映る", () => {
    const c = cam();
    c.cx = 1.2;
    c.cy = -0.4;
    expect(c.worldToScreen(1.2, -0.4)).toEqual([500, 350]);
  });

  it("zoomAt はカーソル下のワールド座標を動かさない", () => {
    const c = cam();
    const before = c.screenToWorld(300, 200);
    c.zoomAt(1.8, 300, 200);
    const after = c.screenToWorld(300, 200);
    expect(after[0]).toBeCloseTo(before[0], 10);
    expect(after[1]).toBeCloseTo(before[1], 10);
    expect(c.z).toBeCloseTo(1.8, 10);
  });

  it("倍率は範囲内に収まる", () => {
    const c = cam();
    c.setZoom(1e9);
    expect(c.z).toBe(100);
    c.setZoom(1e-9);
    expect(c.z).toBe(0.05);
  });

  it("pan はドラッグした分だけ世界が動く向き（右へ 70px ドラッグ → 中心が左へ）", () => {
    const c = cam();
    c.pan(70, -35);
    expect(c.cx).toBeCloseTo(0.5 - 70 / 700, 10);
    expect(c.cy).toBeCloseTo(0.5 + 35 / 700, 10);
    expect(c.free).toBe(true);
  });

  it("focusOn は倍率を戻して中心を合わせ、追従を再開する", () => {
    const c = cam();
    c.zoomBy(3);
    c.pan(100, 100);
    c.focusOn(0.2, 0.9);
    expect(c.z).toBe(1);
    expect([c.cx, c.cy]).toEqual([0.2, 0.9]);
    expect(c.free).toBe(false);
  });

  it("追従: 光が画面端に近づくとカメラが寄り添う。free のときは動かない", () => {
    const c = cam();
    const player = { x: 1.2, y: 0.5 } as Player; // 画面の外へ出ようとしている
    c.free = true;
    c.follow(player);
    expect(c.cx).toBe(0.5);
    c.free = false;
    c.follow(player);
    expect(c.cx).toBeGreaterThan(0.5);
  });
});
