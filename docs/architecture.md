# アーキテクチャ

```
ブラウザ ──HTTP──▶ Worker ──env.ASSETS──▶ client/dist（静的ファイル）
   │
   └──WebSocket /ws──▶ Worker ──▶ 空き容量のある「空」(Durable Object: space, space-2, ...)
                                      ├─ World   星・線とルール（純粋なクラス）
                                      ├─ 視界ベースの位置配信（10Hz でまとめて送る）
                                      └─ storage: 星 / 線を 1 件 1 キーで差分保存
```

## リポジトリ構成

```
client/    ブラウザ側（Vite + TypeScript + Canvas 2D）
  src/       app / camera / player / universe / network / input / renderer / ui / history
             message-handlers.ts … サーバーからのメッセージごとの処理
  public/    OGP 画像など
server/    Cloudflare Workers 側
  src/       index.ts（入口）/ room.ts（Durable Object）/ world.ts（ルール）
             handlers.ts / validate.ts / rate-limit.ts / spatial.ts / config.ts
  tests/     World・検証・レート制限・空間ハッシュの単体テスト
shared/    クライアントとサーバーが共有する型とルール
             protocol.ts（WebSocket のメッセージ型）/ rules.ts（星の寿命ルール）
scripts/   負荷テスト
docs/      ドキュメント
wrangler.jsonc, package.json, tsconfig.json   ルートには設定だけを置く
```

依存の向きは `client → shared ← server`。クライアントとサーバーは互いを直接 import しません。

## 設計方針（スケールのために）

| 課題 | 対策 | 場所 |
| --- | --- | --- |
| 位置の全員配信が O(n²)（500 人で毎秒約 300 万送信） | **視界ベースの配信**。クライアントが見ている範囲 `v` を送り、サーバーは視界の近くの動いた人だけを 100ms ごとに 1 通へまとめて送る。視界外は 2 秒ごとの粗い一覧（ミニマップ用） | [room.ts](../server/src/room.ts) の `tick()` |
| 星の保存のたびに全件をシリアライズ | **1 件 1 キー（`s:<id>` / `l:<id>`）で、変わった分だけ保存**。旧形式は初回起動時に自動で移行 | [world.ts](../server/src/world.ts) の `drainChanges()` |
| 密集度の計算が O(n²) で、接続のたびに実行 | **空間ハッシュ**で近傍だけを数える。実行は 1 秒以上あけ、15 秒ごとのアラームでも実行 | [spatial.ts](../server/src/spatial.ts) |
| 不正な値・連打・他人の星の上書き | **入力検証**（型・範囲・長さ）、**接続ごとのトークンバケット**（操作ごとにコスト）、他人の星は上書き不可 | [validate.ts](../server/src/validate.ts) / [rate-limit.ts](../server/src/rate-limit.ts) |
| 1 つの Durable Object の限界 | **満員（300 人）になったら次の空へ振り分け**（最大 8 空）。先頭の `space` は従来の名前のまま、既存データを引き継ぐ | [index.ts](../server/src/index.ts) |
| 誰も動かないのにタイマーが回り続ける | 動きが無い間は配信タイマーを止め、Durable Object がハイバネートできるようにする | `room.ts` |
| クライアントとサーバーでルールがずれる | 星の寿命ルールを [shared/rules.ts](../shared/rules.ts) に 1 つだけ置く | |

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
| `p` | 自分の位置・色・視界。動いたときだけ（動かなくても 5 秒に 1 回） |
| `pulse` | 波紋を出す |
| `star` / `unstar` | 星を灯す / 消す |
| `admire` | 星にきらめきを送る（寿命リセット） |
| `link` / `unlink` | 線を引く / 消す |

| サーバー → クライアント | 意味 |
| --- | --- |
| `welcome` | 接続直後に 1 回。今いる人・全ての星・全ての線 |
| `ps` | 他の人の位置のまとめ（`[id, x, y, color]` の配列） |
| `pulse` | 視界内で起きた波紋 |
| `star` / `unstar` / `link` / `unlink` / `admire` | 星・線の変化（全員に） |
| `leave` | 誰かが抜けた |

未知のメッセージは、サーバー・クライアントのどちらも無視します（新旧のバージョンが混在しても落ちないように）。

## 実装上のポイント

- **Hibernation API**: `ctx.acceptWebSocket()` で接続を受け、アイドル時は Durable Object がメモリから退避される。復帰時は `serializeAttachment` の内容から接続を取り込み直す
- **永続化**: `blockConcurrencyWhile` で保存済みの星・線を復元してから最初のリクエストを処理する
- **接続先の切り替え**: `workers.dev` と `wrangler dev`（8787）では同一オリジン、`?ws=localhost:8787` で手元の Worker に上書き可能（`uid` の流出を避けるため localhost のみ許可）、それ以外は本番の Worker（[constants.ts](../client/src/constants.ts) の `WS_HOST`）
- **型による網羅性**: メッセージを足すと、ハンドラ表が足りない箇所が型エラーになる（[extending.md](extending.md)）

## 負荷テスト

`npm run loadtest -- ws://localhost:8787/ws <人数> <秒>` で、N 人が世界に散らばって動き続けた状態の配信量と、別の 2 接続による波紋の往復遅延（プローブ）を測ります。**ローカルの `wrangler dev`（workerd）に向けて**使い、本番には向けません。

ローカル（Windows、同一マシンで負荷生成）での結果。10 秒間の測定です。

| 人数 | 旧実装 | 新実装 |
| --- | --- | --- |
| 50 | 23,151 msg/s、遅延 p50=55ms | 515 msg/s、遅延 p50=13ms / p95=29ms |
| 100 | 7,782 msg/s（理想値の約 8%）、プローブが届かない | 1,060 msg/s、p50=4ms / p95=20ms |
| 200 | 51/200 人しか接続できない | 200/200 接続、p50=13ms / p95=54ms |
| 300 | — | 300/300 接続、p50=65ms / p95=138ms |
| 500 | — | 451/500 接続後に配信が止まる（[TODO](TODO.md) に調査項目） |

負荷生成側のイベントループ遅延は p95 約 20ms で、計測側は飽和していません。実環境（Cloudflare のエッジ）の値ではない点に注意してください。

## 技術スタック

- フロントエンド: TypeScript + Canvas 2D（Vite でビルド、ライブラリ依存なし）
- バックエンド: TypeScript、Cloudflare Workers + Durable Objects
- テスト: Vitest（`npm test`）

## ローカル実行・デプロイ

```bash
npm install
npm run dev            # クライアントの開発サーバー（本番の Worker に接続）
npm run dev:server     # Worker + 静的ファイルをローカルで起動（http://localhost:8787）
npm run typecheck      # クライアント・サーバーの型チェック
npm test               # 単体テスト
npm run build          # client/dist/ に出力

# デプロイ
npm run deploy         # ビルド + Pages へ配信
npm run deploy:server  # Worker（Durable Object）
```

> 注意: 今回の変更でクライアントとサーバーの通信形式が変わりました（`p` の配信が `ps` に）。Worker と Pages は**同じタイミングで**デプロイしてください。
