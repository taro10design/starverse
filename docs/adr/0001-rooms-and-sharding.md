# 0001. 満員の空を次の空へ振り分ける

- 状態: 採用（日付 2026-10-17）

## 背景

最初は全員を1つの Durable Object（以下 DO）に入れていた。1つの DO が処理できる量には上限があり、
公式資料では1 DO あたり約500〜1,000 req/s が目安とされている。人が増えるほど、1つの DO に
受信・配信が集中する。公式のルールも「DO は自然な単位で分ける」ことを勧めている。
他社の例として、Figma も表示するカーソルを最大200に制限している。

## 検討した選択肢

- 単一 DO のまま
  - 利点: 実装が最も単純。全員が同じ空を見る。
  - 欠点: 人数に上限があり、超えると全体が遅くなる。
- 満員になったら次の空へ振り分ける（`space`, `space-2`, …）
  - 利点: Worker で DO を順に試すだけで済む。空ごとに状態が独立し、障害も閉じ込められる。
  - 欠点: 別の空にいる人同士は会えない。「1つの共有された空」ではなくなる。
- 世界をタイルに分け、タイルごとに DO を割り当てる
  - 利点: 1つの空を保ったまま水平に伸ばせる。
  - 欠点: タイルをまたぐ線、接続の張り替え、境界での位置の扱いが難しい。今回は見送り（docs/TODO.md に記載）。

## 決定

空の振り分けを採用する。`LIMITS.roomCapacity`（300人）に達した空は 503 と `x-room-full` ヘッダーで
断り、Worker（`server/src/index.ts` の `connect`）が次の空を順に試す。空は最大 `LIMITS.maxRooms`（8）。
名前は `roomName`（`server/src/config.ts`）で決め、先頭だけは従来の `space` のままにして既存データを引き継ぐ。
2番目以降は `space-2`, `space-3`, … 。

後方互換は取らない方針（ADR 0006）だが、先頭の名前を変えると既存の星が失われるため、この名前だけは維持する。

## 結果

- 良い点: 満員の空が他の空へ影響しない。上限は設定値（`config.ts`）の変更だけで調整できる。
- 良い点: `/stats` で空ごとの接続数を観測できる。
- トレードオフ: 空をまたいだ出会いや線はできない。最大収容は 300 × 8 人で、それを超えると 503 を返す。
- トレードオフ: 満員時は Worker が複数の DO に順に問い合わせるため、接続までの往復が増える。
- 将来: タイル分割は TODO として残す。

## 参考

- https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- https://help.figma.com/hc/en-us/articles/1500006775761
- 実装: `server/src/index.ts`、`server/src/config.ts`（`roomName`, `LIMITS.roomCapacity`, `LIMITS.maxRooms`）、`server/src/room.ts`（`fetch`）
