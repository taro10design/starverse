// クライアントとサーバーで同じ値を使う上限・形式。片方だけ変えて食い違わないよう、ここ 1 か所に置く。

export const PALETTE_COUNT = 8; // 光の色の数
export const MAX_STARS_PER_USER = 64; // 1 人が同時に灯せる星の数
export const MAX_LINKS_PER_USER = 96; // 1 人が同時に引ける線の数

// 持ち主の鍵（uid）の形式。クライアントが作り、サーバーは検証するだけ（切り詰めない）
export const UID_PATTERN = /^[\w-]{8,64}$/;
