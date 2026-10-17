// サーバーの調整値。負荷や荒らしの傾向を見て、ここだけ触れば済むようにしておく。

export const LIMITS = {
  // --- 世界の容量 ---
  maxStars: 500,
  maxStarsPerUser: 64,
  maxLinks: 600,
  maxLinksPerUser: 96,

  // --- 部屋（空）のスケール ---
  roomCapacity: 300, // 1つの空に入れる人数。超えたら次の空へ振り分ける
  maxRooms: 8, // 振り分け先の空の数（space, space-2, ...）

  // --- 位置情報の配信 ---
  tickMs: 100, // 位置のまとめ配信の間隔（10Hz）
  coarseEveryTicks: 20, // 視界外も含めた粗い一覧を送る間隔（= 2秒）
  idleTicksBeforeSleep: 30, // 動きが無い状態がこの回数続いたらタイマーを止める（ハイバネート可能にする）
  viewMargin: 0.3, // 視界の外側にこの割合だけ余白を持たせて配信する
  maxPeersPerMessage: 150, // 1回の配信に載せる他人の最大数
  maxWelcomePeers: 300,

  // --- 後片付け ---
  pruneIntervalMs: 15_000,
  pruneMinGapMs: 1_000, // prune を連打されても、この間隔より短くは実行しない

  // --- 入力の制限 ---
  maxMessageBytes: 512,
  coordMax: 10_000, // ワールド座標の絶対値の上限
  maxColors: 16,
} as const;

// 接続ごとのレート制限（トークンバケット）。コストが大きい操作ほど重い
export const RATE = {
  capacity: 80, // 一度に使える量（バースト）
  refillPerSec: 40, // 毎秒の回復量
  closeAfterDrops: 200, // 連続でこの回数あふれたら切断する
} as const;

export const COST = {
  p: 1,
  pulse: 2,
  star: 2,
  unstar: 2,
  admire: 2,
  link: 2,
  unlink: 2,
} as const;

// 空の名前。先頭は従来の "space" のまま（既存データを引き継ぐため）
export function roomName(index: number): string {
  return index === 0 ? "space" : `space-${index + 1}`;
}
