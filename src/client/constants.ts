// universe — 定数定義

export type RGB = [number, number, number];
export interface Palette {
  core: string;
  glow: RGB;
}
export type ToolName = "move" | "star" | "line" | "erase" | "ghost";

// 色パレット
export const PALETTES: Palette[] = [
  { core: "#fff8ec", glow: [255, 200, 130] }, // あかり
  { core: "#ffd9d4", glow: [255, 90, 70] },   // 赤
  { core: "#fff3c4", glow: [255, 200, 60] },  // 金
  { core: "#e3ffd8", glow: [90, 230, 110] },  // 緑
  { core: "#d8fbff", glow: [80, 210, 255] },  // 水
  { core: "#dce4ff", glow: [90, 120, 255] },  // 青
  { core: "#f0e0ff", glow: [180, 110, 255] }, // 藤
  { core: "#ffe0ee", glow: [255, 120, 180] }, // 桃
];

export const PEER_COLOR: Palette = { core: "#dfe9ff", glow: [160, 190, 255] };

// 寿命・TTL
export const STAR_TTL = 3 * 60 * 60 * 1000; // 孤立した星の寿命（3時間）
export const CROWD_R = 0.06; // 「混んでる」とみなす近傍半径
export const GHOST_TTL = 24 * 60 * 60 * 1000; // 幽霊が覚えている期間（24時間）

// 密集による寿命短縮
export function ttlFor(crowd: number): number {
  if (crowd >= 8) return 60 * 1000; // 1分
  if (crowd >= 5) return 5 * 60 * 1000; // 5分
  if (crowd >= 2) return 30 * 60 * 1000; // 30分
  return STAR_TTL; // 3時間
}

// WebSocket
export const WS_HOST = location.hostname.endsWith("workers.dev")
  ? location.host
  : "universe.taroooo0w0.workers.dev";

// ミニマップ
export const MAP_SIZE = 108;

// UI SVG
export const TOOL_SVG: Record<ToolName, string> = {
  move: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 3 L14.2 9.8 L21 12 L14.2 14.2 L12 21 L9.8 14.2 L3 12 L9.8 9.8 Z" fill="currentColor"/></svg>',
  line: '<svg viewBox="0 0 24 24"><path d="M4 20 L20 4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="4" cy="20" r="2.4" fill="currentColor"/><circle cx="20" cy="4" r="2.4" fill="currentColor"/></svg>',
  erase: '<svg viewBox="0 0 24 24"><path d="M5 19 L13 5 L19 11 L11 19 Z" fill="currentColor"/><path d="M4 21 L20 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  ghost: '<svg viewBox="0 0 24 24"><path d="M12 3 C7 3 4 7 4 12 L4 20 L7 18 L9.5 20.5 L12 18 L14.5 20.5 L17 18 L20 20 L20 12 C20 7 17 3 12 3 Z" fill="currentColor"/><circle cx="9.5" cy="11" r="1.5" fill="#040612"/><circle cx="14.5" cy="11" r="1.5" fill="#040612"/></svg>',
};

export const TOOL_TIPS: Record<ToolName, string> = {
  move: "光を動かす",
  star: "星を置く",
  line: "線を引く",
  erase: "星を消す",
  ghost: "幽霊を忘れる",
};

// ヒット判定
export const HIT_RADIUS = 18;

// 自動パイロット（ポインタがない時の漂い）
export function autopilot(t: number): { x: number; y: number } {
  const s = t * 0.00022;
  return {
    x: 0.5 + Math.sin(s) * 0.12 + Math.sin(s * 2.7) * 0.04,
    y: 0.5 + Math.cos(s * 0.8) * 0.1 + Math.cos(s * 2.1) * 0.04,
  };
}
