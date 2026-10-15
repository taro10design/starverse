# アーキテクチャ

```
ブラウザ ──HTTP──▶ Worker ──env.ASSETS──▶ public/ (静的ファイル)
   │
   └──WebSocket /ws──▶ Worker ──▶ Durable Object "Universe"（全員が1つの部屋を共有）
                                      └─ storage: 星 / 線を永続化
```

| 要素 | 役割 |
| --- | --- |
| Cloudflare Pages | `public/` を配信（`uchu.pages.dev`） |
| Workers | `/ws` への WebSocket アップグレードを Durable Object に中継。それ以外は静的アセットを返す（[src/worker.ts](src/worker.ts)） |
| Durable Objects | 部屋の状態（接続中の全員の位置、星、線）を単一インスタンスで管理し、全員にブロードキャストする。SQLite バックエンド（[wrangler.jsonc](wrangler.jsonc) の `new_sqlite_classes`） |

実装上のポイント:

- **Hibernation API**: `ctx.acceptWebSocket()` で接続を受け、`webSocketMessage` などのハンドラで処理しています。アイドル時は Durable Object がメモリから退避され、課金・リソースを抑えられます。
- **接続ごとの状態は `serializeAttachment`**: 退避から復帰しても各接続の ID・位置・色が失われません。
- **永続化**: 星と線は `storage.put` で保存し、コンストラクタの `blockConcurrencyWhile` で復元してから最初のリクエストを処理します。
- **接続先の切り替え**: `workers.dev` で開いた場合は同一オリジンに、それ以外（Pages やローカル）では Worker のホストへ接続します（[script.js](public/script.js) の `WS_HOST`）。

### スパム・荒らし対策

匿名で誰でも書き込めるため、サーバー側で次の制限をかけています。

- 星は全体で 500、線は 600 まで。1ユーザーあたり星 64、線 96 まで
- **混雑ペナルティ**: 周囲 (半径 0.06) の星の数で寿命が変わり、孤立した星は 3 時間、密集した星は最短 1 分で自然消滅する（密集スパムの自壊）
- 星が消えるとその星につながる線も同時に消える
- 同じ 2 点を結ぶ線は 1 本だけ
- 持ち主はセッションではなくブラウザ固有の ID で判定する。線は持ち主しか消せず、星は誰でも消せる代わりに持ち主が復活できる

### 通信メッセージ

JSON を WebSocket で送受信します。`t` が種別です。

| クライアント → サーバー | 意味 |
| --- | --- |
| `p` | 自分の光の位置・色 |
| `pulse` | 波紋を出す |
| `star` / `unstar` | 星を灯す / 消す |
| `admire` | 星にきらめきを送る（寿命リセット） |
| `link` / `unlink` | 線を引く / 消す |

サーバーは接続直後に `welcome`（現在の全員・星・線）を送り、以降は差分（`p`、`star`、`unstar`、`link`、`unlink`、`admire`、`leave`）をブロードキャストします。

### 技術スタック

- フロントエンド: 素の JavaScript + Canvas 2D（ライブラリ・ビルド工程なし）。毎フレームのグラデーション生成を避けるため色ごとのスプライトを使い回しています
- バックエンド: TypeScript、Cloudflare Workers + Durable Objects
- ツール: Wrangler

### ローカル実行・デプロイ

```bash
# 静的ファイルのみ確認（リアルタイム同期は本番の Worker に接続される）
npx serve public

# デプロイ
npx wrangler pages deploy public --project-name uchu   # 静的ファイル
npx wrangler deploy                                    # Worker を変えたとき
```
