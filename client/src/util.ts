// 小さな幾何ヘルパー
export interface Point {
  x: number;
  y: number;
}

export const snap = (s: { id: string; x: number; y: number; c: number }) => ({ id: s.id, x: s.x, y: s.y, c: s.c });
export const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

// UUID v4 を作る。crypto.randomUUID は安全なコンテキスト（https・localhost）でしか使えないので、
// http の LAN 開発（スマホから PC の IP で開くなど）では crypto.getRandomValues で同じ形を作る（本番は https）
export interface UuidSource {
  getRandomValues(array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
  randomUUID?: () => string;
}
export function randomUUID(src: UuidSource = crypto): string {
  if (typeof src.randomUUID === "function") return src.randomUUID();
  const b = src.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx（RFC 4122）
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// null / undefined なら理由つきで例外にする（存在するはずのものを `!` で黙って断定しない）
export function must<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error(`${what} が見つかりません`);
  return value;
}
