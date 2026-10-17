// サーバーの調整値。負荷や荒らしの傾向を見て、ここだけ触れば済むようにしておく。
// クライアントと同じ値を使うもの（1 人あたりの上限・色の数・uid の形式）は shared/limits.ts にある。

import { MAX_LINKS_PER_USER, MAX_STARS_PER_USER } from "../../shared/limits";

export const LIMITS = {
  // --- 世界の容量 ---
  maxStars: 500,
  maxStarsPerUser: MAX_STARS_PER_USER, // 持ち主（= 1 接続）ごとに数える
  maxLinks: 600,
  maxLinksPerUser: MAX_LINKS_PER_USER,

  // --- 部屋（空）のスケール ---
  roomCapacity: 300, // 1つの空に入れる人数。超えたら次の空へ振り分ける
  maxConnsPerIp: 4, // 1つの空に同じ接続元から入れる数。超えたら断る（次の空には回さない）
  maxRooms: 8, // 振り分け先の空の数（space, space-2, ...）

  // --- 受信量の予算 ---
  // Cloudflare の公式資料では、1 つの Durable Object は検証つきの処理で約 500〜750 req/s。
  // 位置メッセージの合計をこの目安に収めるため、人数に応じて各クライアントの送信間隔を指示する
  inboundBudgetPerSec: 500,
  sendMsMin: 100, // 少人数のときの間隔（10Hz）
  sendMsMax: 1000, // 満員でもこれより遅くはしない

  // --- 位置情報の配信 ---
  tickMs: 100, // 位置のまとめ配信の間隔（10Hz）。下の表で人数に応じて広げる
  // [この人数まで, 間隔ms]。多いほど間隔を広げて、1 回の処理が間に合うようにする
  tickMsByConnections: [
    [100, 100],
    [200, 150],
    [Number.POSITIVE_INFINITY, 250],
  ] as readonly (readonly [number, number])[],
  coarseEveryTicks: 20, // 視界外も含めた粗い一覧を送る間隔（= 2秒）
  idleTicksBeforeSleep: 30, // 動きが無い状態がこの回数続いたらタイマーを止める（ハイバネート可能にする）
  viewMargin: 0.3, // 視界の外側にこの割合だけ余白を持たせて配信する
  maxPeersPerMessage: 150, // 1回の配信に載せる他人の最大数
  maxWelcomePeers: 300,

  // --- 後片付け ---
  pruneIntervalMs: 30_000,
  pruneMinGapMs: 1_000, // prune を連打されても、この間隔より短くは実行しない

  // --- 入力の制限 ---
  maxMessageBytes: 512,
  coordMax: 10_000, // ワールド座標の絶対値の上限
  helloTimeoutMs: 10_000, // 接続してからこの時間内に hello が来なければ切断する
  maxBacklogWhileIdentifying: 32, // hello のハッシュ計算中に届いたメッセージを貯めておく数
} as const;

// 接続ごとのレート制限（トークンバケット）。コストが大きい操作ほど重い
export const RATE = {
  // 一度に使える量（バースト）。「自分の星を全部消す」「幽霊を全部復活」で 1 人あたりの上限ぶん(64 個)を
  // 一気に送っても捨てられないよう、星 64 個ぶんのコスト（2×64）に余裕を足した値にしている
  capacity: 200,
  refillPerSec: 40, // 毎秒の回復量
  closeAfterDrops: 200, // 連続でこの回数あふれたら切断する
} as const;

export const COST = {
  p: 1,
  pulse: 4, // 視界内の全員に配るので重め
  star: 2,
  unstar: 1, // 消す操作は軽い
  admire: 2,
  link: 2,
  unlink: 1,
} as const;

// 空の名前。先頭は従来の "space" のまま（既存データを引き継ぐため）
export function roomName(index: number): string {
  return index === 0 ? "space" : `space-${index + 1}`;
}

// 人数 n の空で、各クライアントが位置を送る間隔（ms）。50ms 刻みに丸めて、頻繁に変わらないようにする
export function sendMsFor(n: number): number {
  const raw = (Math.max(1, n) * 1000) / LIMITS.inboundBudgetPerSec;
  const stepped = Math.ceil(raw / 50) * 50;
  return Math.min(LIMITS.sendMsMax, Math.max(LIMITS.sendMsMin, stepped));
}
