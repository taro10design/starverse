// 実行環境（ページごとに一度だけ決まる値）
export const DPR = Math.min(window.devicePixelRatio || 1, 2);
export const SOLO = new URLSearchParams(location.search).has("solo");
