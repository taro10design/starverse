# 0003. 位置の送信間隔をサーバーが指示する

- 状態: 採用（日付 2026-10-17）

## 背景

位置をサーバーへ送る量は、人数に比例して増える。1つの DO が捌ける量は約500〜1,000 req/s が目安で、
固定の送信間隔（10Hz）では、100人を超えたあたりで受信が予算を超える。
一方で人が少ないときは、細かく送ったほうが動きが滑らかになる。

## 検討した選択肢

- 固定 10Hz
  - 利点: 単純。少人数では最も滑らか。
  - 欠点: 人数が増えると受信が溢れる。ローカル実測では N=100 で崩壊した。
- クライアント任せのスロットル
  - 利点: サーバーに仕組みが要らない。
  - 欠点: 全クライアントの合計をサーバーが制御できない。改造されたクライアントには効かない。
- サーバーが人数に応じて指示する
  - 利点: 受信量の合計を予算に収められる。指示を変えるだけで調整できる。
  - 欠点: 通知メッセージが増える。人数が多いと動きが粗くなる。

## 決定

サーバー指示を採用する。受信量の予算を `LIMITS.inboundBudgetPerSec`（500）とし、
`sendMsFor(n)`（`server/src/config.ts`）が n×1000/500 ms を 50ms 刻みに切り上げ、100〜1000ms に収める。
値は接続時の `welcome` と、人数の変化で値が変わったときの `rate`（`room.ts` の `updateRate`）で全員に通知する。
クライアントは `Network.setSendInterval`（`client/src/network.ts`）で間隔を変える。
受信側は補間して、間隔が広がっても動きが滑らかに見えるようにする。

この方式は Rivet のレート制限の考え方に倣い、Liveblocks の既定（100ms）を下限の目安にした。

## 結果

実測（ローカル workerd。前後比較としてのみ使い、本番の保証値ではない）:

- 固定 10Hz: N=100 で崩壊
- サーバー指示: N=500 で p50=5ms / p95=34ms、N=1000 で p50=13ms / p95=46ms

- 良い点: 人数が増えても受信量が予算内に収まる。
- 良い点: 調整は `config.ts` の数値だけで済む。
- トレードオフ: 満員に近いと位置の更新が最大1秒おきになり、補間頼みの見た目になる。
- トレードオフ: 送信間隔が変わるたびに全員へ `rate` を送る。50ms 刻みにして頻度を抑えている。

## 参考

- https://rivet.dev/actors/learn/live-cursors
- https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- 実装: `server/src/config.ts`（`sendMsFor`）、`server/src/room.ts`（`updateRate`）、`client/src/network.ts`（`setSendInterval`）、`shared/protocol.ts`（`welcome`, `rate`）
