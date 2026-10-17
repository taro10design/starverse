// 小さな幾何ヘルパー
export interface Point {
  x: number;
  y: number;
}

export const snap = (s: { id: string; x: number; y: number; c: number }) => ({ id: s.id, x: s.x, y: s.y, c: s.c });
export const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
