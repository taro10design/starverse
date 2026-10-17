// 実行環境（ページごとに一度だけ決まる値）
export const DPR = Math.min(window.devicePixelRatio || 1, 2);
export const SOLO = new URLSearchParams(location.search).has("solo");
export const DEBUG = new URLSearchParams(location.search).has("debug"); // 動作確認用。通常は何も公開しない
