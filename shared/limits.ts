// クライアントとサーバーで同じ値を使う上限・形式。片方だけ変えて食い違わないよう、ここ 1 か所に置く。

export const PALETTE_COUNT = 8; // 光の色の数
export const MAX_STARS_PER_USER = 64; // 1 人が同時に灯せる星の数
export const MAX_LINKS_PER_USER = 96; // 1 人が同時に引ける線の数

// 持ち主の鍵（uid）の形式。クライアントが作り、サーバーは検証するだけ（切り詰めない）
export const UID_PATTERN = /^[\w-]{8,64}$/;

// サーバーが作る持ち主 ID（uid の SHA-256 の先頭 32 文字の 16 進数）。
// これに合わない `by` は、uid が混ざっている可能性があるので、読み込み時に捨てる
export const OWNER_ID_PATTERN = /^[0-9a-f]{32}$/;

// ワールド座標の絶対値の上限。これを超える座標のメッセージは無視する
export const COORD_MAX = 10_000;
// 星・線の id の長さの上限。長い id は切り詰める（uid は切り詰めない。UID_PATTERN で検証する）
export const ID_MAX_LENGTH = 24;
