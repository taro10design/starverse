# アーキテクチャ

```
ブラウザ ──HTTP──▶ Worker ──env.ASSETS──▶ client/dist（静的ファイル）
   │
   └──WebSocket /ws──▶ Worker ──▶ 空き容量のある「空」(Durable Object: space, space-2, ...)
                                      ├─ World   星・線とルール（純粋なクラス）
                                      ├─ 視界ベースの位置配信（まとめて送る）
                                      └─ storage: 星 / 線を 1 件 1 キーで差分保存
```

設計判断とその理由は [adr/](adr/README.md)、仕様は [specs/](specs/README.md) にあります。この文書は「どこに何があるか」の地図です。

## リポジトリ構成

```
client/    ブラウザ側（Vite + TypeScript + Canvas 2D）
  src/       app / camera / player / universe / network / renderer / ui / history / input
             tools/            ツールごとの操作（Strategy）。Input は振り分けだけ
             message-handlers  サーバーからのメッセージごとの処理（型で網羅を強制）
             storage / util / constants / env
  tests/     Camera・History・メッセージ処理・ツールの単体テスト
  public/    OGP 画像、_headers（セキュリティヘッダ・キャッシュ）
server/    Cloudflare Workers 側
  src/       index.ts（入口・空の振り分け・/stats）/ room.ts（Durable Object）/ world.ts（ルール）
             handlers.ts / validate.ts / rate-limit.ts / spatial.ts / config.ts / env.ts
  tests/     World・検証・レート制限・空間ハッシュ・設定の単体テスト
shared/    クライアントとサーバーが共有する型とルール
             protocol.ts（WebSocket のメッセージ型）/ rules.ts（星の寿命ルール）
scripts/   e2e.mjs（動作確認）/ loadtest.mjs（負荷テスト）
docs/      adr（設計判断）/ specs（仕様）/ qa（実機確認）/ TODO.md / この文書 / extending.md
```

ルートには `package.json`・`tsconfig.json`・`wrangler.jsonc`・`eslint.config.mjs` など設定だけを置きます。

依存の向きは `client → shared ← server`。クライアントとサーバーは互いを直接 import しません。

## 設計方針（スケールのために）

| 課題 | 対策 | 詳細 |
| --- | --- | --- |
| 位置の全員配信が O(n²) | **視界ベースの配信**。クライアントが見ている範囲 `v` を送り、サーバーは視界の近くの動いた人だけを 1 通にまとめて送る。視界外は粗い一覧（ミニマップ用） | [ADR 0002](adr/0002-interest-management-presence.md) |
| 1 つの Durable Object が受けられる量には限りがある（目安 約 500〜1,000 req/s） | **サーバーが人数に応じて各クライアントの位置の送信間隔を指示**（100〜1000ms）。受信量を予算（500 通/秒）に収める | [ADR 0003](adr/0003-server-directed-send-rate.md) |
| 1 つの Durable Object の限界 | **満員（300 人）になったら次の空へ振り分け**（最大 8 空）。先頭の `space` は従来の名前のまま | [ADR 0001](adr/0001-rooms-and-sharding.md) |
| 星の保存のたびに全件をシリアライズ | **1 件 1 キー（`s:<id>` / `l:<id>`）で、変わった分だけ保存** | [ADR 0005](adr/0005-world-as-pure-class.md) |
| 密集度の計算が O(n²) | **空間ハッシュ**で近傍だけを数える。実行は 1 秒以上あけ、30 秒ごとのアラームでも実行 | [spatial.ts](../server/src/spatial.ts) |
| 不正な値・連打・他人の星の上書き・なりすまし | **入力検証**、**接続ごとのトークンバケット**、他人の星は上書き不可、**持ち主の鍵は秘密にして SHA-256 の ID だけを配信**、同一 IP の接続数の上限 | [validate.ts](../server/src/validate.ts) / [rate-limit.ts](../server/src/rate-limit.ts) |
| 誰も動かないのにタイマーが回り続ける | 動きが無い間は配信タイマーを止め、Durable Object がハイバネートできるようにする | [room.ts](../server/src/room.ts) |
| クライアントとサーバーでルールがずれる | メッセージ型と星の寿命ルールを `shared/` の 1 か所に置く。ハンドラ表で処理の書き忘れを型エラーにする | [ADR 0004](adr/0004-shared-protocol-and-handler-tables.md) |

調整値はすべて [server/src/config.ts](../server/src/config.ts) にあります。

### 世界のルール（スパム・荒らし対策）

- 星は全体で 500、線は 600 まで。1 ユーザーあたり星 64、線 96 まで
- **混雑ペナルティ**: 周囲（半径 0.06）の星の数で寿命が変わり、孤立した星は 3 時間、密集した星は最短 1 分で自然消滅する
- 星が消えるとその星につながる線も消える。同じ 2 点を結ぶ線は 1 本だけ
- 持ち主はセッションではなくブラウザ固有の ID で判定する。線は持ち主しか消せない。星は誰でも消せる代わりに、持ち主が幽霊から復活できる

## 通信メッセージ

JSON を WebSocket で送受信します。`t` が種別で、通信量を抑えるため短い名前を使っています（`p` = position、`v` = view、`ps` = presences）。型は [shared/protocol.ts](../shared/protocol.ts) が唯一の定義です。

| クライアント → サーバー | 意味 |
| --- | --- |
| `hello` | 接続の最初に 1 回。持ち主の秘密の鍵 `uid`（保存も配信もされない） |
| `p` | 自分の位置・色・視界。動いたときだけ、サーバーが指示した間隔で |
| `pulse` | 波紋を出す |
| `star` / `unstar` | 星を灯す / 消す |
| `admire` | 星にきらめきを送る（寿命リセット） |
| `link` / `unlink` | 線を引く / 消す |
| `"ping"`（文字列） | 死活監視。Durable Object を起こさずに `"pong"` が返る |

| サーバー → クライアント | 意味 |
| --- | --- |
| `welcome` | `hello` への返事。自分の id・持ち主 ID `me`・位置の送信間隔・今いる人・全ての星・全ての線 |
| `reject` | 断った `star` / `link`（上限超過・レート制限など）。クライアントは自分の画面から取り消す |
| `rate` | 空の人数が変わったときの、位置の送信間隔の指示 |
| `ps` | 他の人の位置のまとめ（`[id, x, y, color]` の配列） |
| `pulse` | 視界内で起きた波紋 |
| `star` / `unstar` / `link` / `unlink` | 星・線の変化（全員に） |
| `admire` | きらめき（星の位置が視界内の人にだけ。同じ接続が同じ星へは 5 秒に 1 回） |
| `leave` | 誰かが抜けた |

未知のメッセージは、サーバー・クライアントのどちらも無視します。

## 実装上のポイント

- **Hibernation API**: `ctx.acceptWebSocket()` で接続を受け、アイドル時は Durable Object がメモリから退避される。復帰時は `serializeAttachment` の内容から接続を取り込み直す
- **永続化**: `blockConcurrencyWhile` で保存済みの星・線を復元してから最初のリクエストを処理する。保存は変わった分だけ
- **死活監視**: クライアントが 25 秒ごとに `"ping"` を送り、70 秒何も届かなければつなぎ直す。再接続の待ち時間にはジッターを入れる。タブが 30 秒隠れたら切断して空きを返し、戻ったらつなぎ直す
- **接続先の切り替え**: `workers.dev` と `wrangler dev`（8787）では同一オリジン、`?ws=localhost:8787` で手元の Worker に上書き可能（`uid` の流出を避けるため localhost のみ許可）、それ以外は本番の Worker（[constants.ts](../client/src/constants.ts) の `WS_HOST`）
- **ツール（Strategy）**: 操作はツールごとのクラス（`client/src/tools/`）。ツールは `ToolContext`（必要なものだけ）を受け取り、ドラッグ中の連続操作は自分で 1 つの履歴にまとめる
- **ストレージ**: `localStorage` の失敗は [storage.ts](../client/src/storage.ts) の 1 か所だけで握りつぶす
- **観測**: `GET /stats`（`x-stats-token` ヘッダが `STATS_TOKEN` と一致したときだけ。それ以外は 404）が空ごとの接続数・星の数・送信間隔を返す

## 負荷テスト

`npm run loadtest -- ws://localhost:8787/ws <人数> <秒>` で、N 人が世界に散らばって動き続けた状態の配信量と、別の 2 接続による波紋の往復遅延（プローブ）を測ります。クライアントはサーバーが指示した送信間隔に従います。**ローカルの `wrangler dev`（workerd）に向けて**使い、本番には向けません。

ローカル（Windows、同一マシンで負荷生成、10 秒間の測定）での結果です。

| 人数 | 位置を全員 10Hz で送る設計 | サーバーが送信間隔を指示する設計 |
| --- | --- | --- |
| 50 | 遅延 p50=55ms | — |
| 100 | 配信が崩壊（理想値の約 8%）、プローブが届かない | p50=3ms / p95=19ms |
| 200 | 51/200 人しか接続できない | — |
| 300 | p50=45〜241ms、p95=1.7〜3.5 秒（不安定） | p50=3.9ms / p95=39ms |
| 500 | 配信が約 5 秒遅れる | p50=5ms / p95=34ms |
| 1000 | — | p50=13ms / p95=46ms |

ローカルのランタイムは本番と違い、メッセージ 1 通あたりの固定コストが大きく、全ての空が 1 つのスレッドを共有します。**絶対値ではなく、前後の比較**として読んでください。

## 動作確認（E2E）

```bash
npm run dev:server                                  # 別のターミナルで起動
node scripts/e2e.mjs http://localhost:8787 --full   # ローカル向け（書き込みあり。作った星は後片付けする）
node scripts/e2e.mjs https://uchu.pages.dev         # 本番向け（読み取りだけ）
```

## ローカル実行・デプロイ

```bash
npm install
npm run dev            # クライアントの開発サーバー（本番の Worker に接続）
npm run dev:server     # Worker + 静的ファイルをローカルで起動（http://localhost:8787）
npm run check          # 型チェック・lint・整形チェック・単体テスト
npm run build          # client/dist/ に出力

# デプロイ
npm run deploy         # ビルド + Pages へ配信
npm run deploy:server  # Worker（Durable Object）
```

> 注意: `wrangler dev` を起動したままビルドしないでください（`client/dist` を監視しているため、ビルドが失敗することがあります）。また、通信形式が変わったときは Worker と Pages を続けてデプロイしてください（[ADR 0006](adr/0006-no-backward-compatibility.md)）。
