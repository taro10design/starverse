// クライアントとサーバーで共有する「宇宙のルール」。
// 片方だけ書き換えて食い違うことがないよう、定義はここ1か所に置く。

export const STAR_TTL = 3 * 60 * 60 * 1000; // 孤立した星の寿命（3時間）
export const CROWD_R = 0.06; // 「混んでる」とみなす近傍半径（ワールド座標）

// 周囲の星の数で寿命が決まる。密集スパムは1分で自壊する
export function ttlFor(crowd: number): number {
  if (crowd >= 8) return 60 * 1000; // 1分
  if (crowd >= 5) return 5 * 60 * 1000; // 5分
  if (crowd >= 2) return 30 * 60 * 1000; // 30分
  return STAR_TTL; // 3時間
}
