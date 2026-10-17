// サーバーの調整値。負荷や荒らしの傾向を見て、ここだけ触れば済むようにしておく。
// クライアントと同じ値を使うもの（1 人あたりの上限・色の数・uid の形式・座標と id の範囲）は shared/limits.ts にある。
// 同じ接続元（IP）ごとの制限は、ここではなく Cloudflare のエッジのレート制限ルールで行う（ADR 0009）。

import { MAX_LINKS_PER_USER, MAX_STARS_PER_USER } from "../../shared/limits";

export const LIMITS = {
  // --- 世界の容量 ---
  maxStars: 500,
  maxStarsPerUser: MAX_STARS_PER_USER, // 持ち主（= 1 接続）ごとに数える
  maxLinks: 600,
  maxLinksPerUser: MAX_LINKS_PER_USER,

  // --- 部屋（空）のスケール ---
  roomCapacity: 300, // 1つの空に入れる人数。超えたら次の空へ振り分ける
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
  helloTimeoutMs: 10_000, // 接続してからこの時間内に hello が来なければ切断する
  maxBacklogWhileIdentifying: 32, // hello のハッシュ計算中に届いたメッセージを貯めておく数
  maxRejectsWhileIdentifying: 256, // 貯めきれなかった星・線の reject を、welcome のあとに返す数
  maxProtocolViolations: 20, // hello 前の hello 以外・2 回目以降の hello がこの回数に達したら 1008 で切断する

  // --- きらめき（admire） ---
  admireCooldownMs: 5000, // 同じ接続が同じ星をきらめかせられる間隔
  admireMinIntervalMs: 60_000, // 星ごとの全体の間隔。星の ts（作成・前回のきらめき）からこの時間は誰がきらめいても延びない
  admireCooldownEntries: 256, // 接続ごとに覚えておく星の数（メモリの上限）
  maxStarAgeMs: 24 * 60 * 60 * 1000, // きらめきで寿命が延びるのは、星の作成（保存した born）からこの時間まで

  // --- 受信のあふれ ---
  rateWindowMs: 10_000, // あふれの割合を数える直近の窓（1 秒刻み）
} as const;

// 接続ごとのレート制限（トークンバケット）。コストが大きい操作ほど重い
export const RATE = {
  // 一度に使える量（バースト）。「自分の星を全部消す」「幽霊を全部復活」で 1 人あたりの上限ぶん(64 個)を
  // 一気に送っても捨てられないよう、星 64 個ぶんのコスト（2×64）に余裕を足した値にしている
  capacity: 200,
  refillPerSec: 40, // 毎秒の回復量
  // 直近 rateWindowMs の中で、あふれた割合が closeOverflowRatio 以上、かつあふれが closeMinDrops 以上なら切断する。
  // 許容量の 2 倍で送り続けると、あふれの割合はちょうど 0.5 になる（「超え」では切れない）ので「以上」で判定する
  closeOverflowRatio: 0.5,
  closeMinDrops: 100,
} as const;

// 1 通ごとに、JSON を読む前に 1 トークン取る。読んだあとは COST との差だけ追加で取る（inbound.ts）
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

// 人数 n の空で、各クライアントが位置を送る間隔（ms）。50ms 刻みに丸めて、頻繁に変わらないようにする。
// 1 人以下のときは誰にも見えないので最長にする（受信メッセージは 20 通 = 1 リクエストで課金される。ADR 0008）
export function sendMsFor(n: number): number {
  if (n <= 1) return LIMITS.sendMsMax;
  const raw = (n * 1000) / LIMITS.inboundBudgetPerSec;
  const stepped = Math.ceil(raw / 50) * 50;
  return Math.min(LIMITS.sendMsMax, Math.max(LIMITS.sendMsMin, stepped));
}
