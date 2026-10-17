// ---------------------------------------------------------------------------
// 見本の動き — ヘルプの各項目と、初めての人への案内に出す小さなアニメーション
//
// 動画ファイルではなく、その場で描く（撮り直しが要らず、見た目の変更に追従し、数 KB で済む）。
// 各フレームは「種類と時刻」だけから決まる純粋な関数 demoFrame で作り、描画（demo-view.ts）と分ける。
// 座標は小窓の中の 0〜1。zoom は描画のときに中心を基準に掛ける
// ---------------------------------------------------------------------------

export const DEMO_KINDS = ["tap", "star", "trace", "line", "erase", "revive", "pinch"] as const;
export type DemoKind = (typeof DEMO_KINDS)[number];

export const DEMO_MS = 2400; // 一周の長さ

export interface Point {
  x: number;
  y: number;
}
export interface DemoFrame {
  light: Point; // 自分の光
  fingers: (Point & { down: boolean })[]; // 指（down = 押している）
  stars: (Point & { ghost?: boolean })[];
  links: [Point, Point][]; // 引いた線
  preview: [Point, Point] | null; // 引いている途中の線
  ripples: (Point & { r: number; a: number })[]; // 波紋（半径・不透明度）
  zoom: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ease = (v: number) => (v < 0.5 ? 2 * v * v : 1 - (-2 * v + 2) ** 2 / 2);
// 区間 [a, b] の中での進み具合（0〜1）
const span = (p: number, a: number, b: number) => clamp01((p - a) / (b - a));
const lerp = (a: Point, b: Point, v: number): Point => ({ x: a.x + (b.x - a.x) * v, y: a.y + (b.y - a.y) * v });
const within = (p: number, a: number, b: number) => p >= a && p < b;

const HOME: Point = { x: 0.15, y: 0.8 }; // 見本の中の自分の光の定位置

// 押した所から広がる波紋（[a, a + 0.35] の間）
function ripple(at: Point, p: number, a: number) {
  const v = span(p, a, a + 0.35);
  return within(p, a, a + 0.35) ? [{ ...at, r: 0.04 + 0.16 * v, a: 1 - v }] : [];
}

// 指: [show, hide) の間だけ見え、[down, up) の間だけ押している
function finger(at: Point, p: number, show: number, down: number, up: number, hide: number) {
  return within(p, show, hide) ? [{ ...at, down: within(p, down, up) }] : [];
}

function base(): DemoFrame {
  return { light: HOME, fingers: [], stars: [], links: [], preview: null, ripples: [], zoom: 1 };
}

const FRAMES: Record<DemoKind, (p: number) => DemoFrame> = {
  // 空をタップ → 波紋が出て、光がそこへ向かう
  tap(p) {
    const from: Point = { x: 0.3, y: 0.62 };
    const to: Point = { x: 0.72, y: 0.35 };
    return {
      ...base(),
      light: lerp(from, to, ease(span(p, 0.28, 0.7))),
      fingers: finger(to, p, 0.12, 0.22, 0.32, 0.5),
      ripples: ripple(to, p, 0.22),
    };
  },

  // 星ツールでタップ → 星が 1 つ置かれる
  star(p) {
    const at: Point = { x: 0.55, y: 0.45 };
    return {
      ...base(),
      fingers: finger(at, p, 0.12, 0.25, 0.35, 0.5),
      stars: within(p, 0.25, 0.9) ? [at] : [],
      ripples: ripple(at, p, 0.25),
    };
  },

  // 星ツールでなぞる → なぞった道に沿って星が続けて置かれる
  trace(p) {
    const path = (v: number): Point => ({ x: 0.2 + 0.6 * v, y: 0.6 - 0.2 * v - 0.12 * Math.sin(Math.PI * v) });
    const v = span(p, 0.2, 0.7);
    const placed = within(p, 0.2, 0.9) ? Math.floor(v * 5) + 1 : 0;
    return {
      ...base(),
      fingers: finger(path(v), p, 0.1, 0.2, 0.7, 0.8),
      stars: Array.from({ length: placed }, (_, i) => path(i / 5)),
    };
  },

  // 線ツールで星から星へなぞる → 線ができる
  line(p) {
    const a: Point = { x: 0.25, y: 0.62 };
    const b: Point = { x: 0.75, y: 0.38 };
    const tip = lerp(a, b, ease(span(p, 0.22, 0.6)));
    const dragging = within(p, 0.22, 0.6);
    return {
      ...base(),
      fingers: finger(tip, p, 0.1, 0.22, 0.6, 0.72),
      stars: [a, b],
      preview: dragging ? [a, tip] : null,
      links: within(p, 0.6, 0.9) ? [[a, b]] : [],
    };
  },

  // 消ツールで星をタップ → その星が消える
  erase(p) {
    const stars: Point[] = [
      { x: 0.3, y: 0.55 },
      { x: 0.55, y: 0.4 },
      { x: 0.75, y: 0.6 },
    ];
    const target = stars[1];
    const gone = within(p, 0.35, 0.9);
    return {
      ...base(),
      fingers: finger(target, p, 0.15, 0.3, 0.4, 0.55),
      stars: gone ? stars.filter((s) => s !== target) : stars,
      ripples: ripple(target, p, 0.35),
    };
  },

  // 光モードで幽霊（消えた自分の星）をタップ → 星に戻る
  revive(p) {
    const at: Point = { x: 0.55, y: 0.45 };
    return {
      ...base(),
      fingers: finger(at, p, 0.15, 0.3, 0.4, 0.55),
      stars: [{ ...at, ghost: !within(p, 0.4, 0.9) }],
      ripples: ripple(at, p, 0.4),
    };
  },

  // 2 本の指を広げる → 拡大する（離すと見本だけ元の倍率に戻る）
  pinch(p) {
    const spread = ease(span(p, 0.2, 0.7));
    const back = ease(span(p, 0.75, 0.95));
    const d = 0.08 + 0.22 * spread;
    const down = within(p, 0.2, 0.75);
    const shown = within(p, 0.1, 0.85);
    return {
      ...base(),
      fingers: shown
        ? [
            { x: 0.5 - d, y: 0.5 + d * 0.4, down },
            { x: 0.5 + d, y: 0.5 - d * 0.4, down },
          ]
        : [],
      stars: [
        { x: 0.45, y: 0.47 },
        { x: 0.53, y: 0.52 },
        { x: 0.5, y: 0.44 },
      ],
      zoom: 1 + spread * (1 - back),
    };
  },
};

export function demoFrame(kind: DemoKind, tMs: number): DemoFrame {
  const p = (((tMs % DEMO_MS) + DEMO_MS) % DEMO_MS) / DEMO_MS;
  return FRAMES[kind](p);
}
