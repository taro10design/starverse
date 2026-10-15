// 小さな幾何ヘルパー
export const snap = (s) => ({ id: s.id, x: s.x, y: s.y, c: s.c });
export const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
