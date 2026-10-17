import type { Player } from "./player";
// ---------------------------------------------------------------------------
// Camera — ワールド座標(0..1正規化)とスクリーン座標の変換
// ---------------------------------------------------------------------------
export type Vec2 = [number, number];

export class Camera {
  cx = 0.5;
  cy = 0.5;
  z = 1;
  W = 0;
  H = 0;
  free = false; // ズーム/地図操作中は自分の光を追わない

  resize(W: number, H: number) {
    this.W = W;
    this.H = H;
  }
  scalePx(): number {
    return this.z * Math.min(this.W, this.H);
  }
  worldToScreen(x: number, y: number): Vec2 {
    const s = this.scalePx();
    return [(x - this.cx) * s + this.W / 2, (y - this.cy) * s + this.H / 2];
  }
  screenToWorld(x: number, y: number): Vec2 {
    const s = this.scalePx();
    return [(x - this.W / 2) / s + this.cx, (y - this.H / 2) / s + this.cy];
  }
  // 点の見た目の大きさはズームの平方根でだけスケール（物理サイズではなく「見え方」優先）
  dotScale(): number {
    return Math.sqrt(this.z);
  }
  setZoom(z: number) {
    this.z = Math.min(100, Math.max(0.05, z));
  }
  // ワールド座標(wx,wy)がスクリーン座標(sx,sy)に来るようにカメラ中心を合わせる
  anchor(wx: number, wy: number, sx: number, sy: number) {
    const s = this.scalePx();
    this.cx = wx - (sx - this.W / 2) / s;
    this.cy = wy - (sy - this.H / 2) / s;
    this.free = true;
  }
  // 画面上で (dxPx, dyPx) ぶん動かす（ドラッグした分だけ世界が動く向き）
  pan(dxPx: number, dyPx: number) {
    const s = this.scalePx();
    this.cx -= dxPx / s;
    this.cy -= dyPx / s;
    this.free = true;
  }
  // 画面の中心を基準にズーム（ボタン・キー用）
  zoomBy(factor: number) {
    this.zoomAt(factor, this.W / 2, this.H / 2);
  }
  // 自分の光を中心に戻し、倍率も初期値へ
  focusOn(x: number, y: number) {
    this.setZoom(1);
    this.cx = x;
    this.cy = y;
    this.free = false;
  }
  zoomAt(factor: number, sx: number, sy: number) {
    const [wx, wy] = this.screenToWorld(sx, sy);
    this.setZoom(this.z * factor);
    this.anchor(wx, wy, sx, sy);
  }
  // 自分の光が画面端に行きそうならカメラが寄り添う
  follow(player: Player) {
    if (this.free) return;
    const [px, py] = this.worldToScreen(player.x, player.y);
    const mx = this.W * 0.22,
      my = this.H * 0.22;
    const s = this.scalePx();
    if (px < mx) this.cx -= (mx - px) / s;
    if (px > this.W - mx) this.cx += (px - (this.W - mx)) / s;
    if (py < my) this.cy -= (my - py) / s;
    if (py > this.H - my) this.cy += (py - (this.H - my)) / s;
  }
}
