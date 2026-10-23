# アーキテクチャ

```
ブラウザ ──HTTP──▶ Worker ──env.ASSETS──▶ client/dist（静的ファイル）
   │
   └──WebSocket /ws──▶ Worker ──▶ 空き容量のある「空」(Durable Object: space, space-2, ...)
                                      │          PartyServer の Server（接続の受け付け・ハイバネート復帰）
                                      ├─ World   星・線とルール（純粋なクラス）
                                      ├─ 視界ベースの位置配信（まとめて送る）
                                      └─ storage: 星 / 線を 1 件 1 キーで差分保存
```

設計判断とその理由は [adr/](adr/README.md)、仕様は [specs/](specs/README.md) にあります。この文書は「どこに何があるか」の地図です。

## リポジトリ構成

```
client/    ブラウザ側（Vite + TypeScript + Canvas 2D）
  src/       app / camera / player / universe / network / renderer / ui / history / input / keys
             tools/            ツールごとの操作（Strategy）。Input は振り分けだけ
             message-handlers  サーバーからのメッセージごとの処理（型で網羅を強制）
             onboarding        初めての人への 1 行の案内（純粋な状態。表示は ui）
             demo / demo-view  ヘルプと案内の見本の動き（フレームは純粋な関数、描画は別）
             storage / util / constants / env
  tests/     Camera・History・入力・Network（PartySocket の設定）・メッセージ処理・検証・ツール・案内・見本の動きの単体テスト
  public/    OGP 画像、_headers（セキュリティヘッダ・キャッシュ）、THIRD_PARTY_NOTICES.txt（生成物）
server/    Cloudflare Workers 側
  src/       index.ts（入口・空の振り分け・/stats）/ room.ts（Durable Object。PartyServer の Server）
             world.ts（ルール）/ handlers.ts（メッセージごとの処理）/ inbound.ts（受信の関門）
             presence.ts（位置の配信の純粋なロジック）/ validate.ts / rate-limit.ts / spatial.ts
             identity.ts（持ち主 ID の作成と定数時間の比較だけ）/ config.ts / env.ts
  tests/     World・検証・受信の関門・レート制限・配信・空間ハッシュ・設定・持ち主 ID の単体テスト（Node で動く）
  tests/runtime/  本物の Workers ランタイム（workerd）の上で、WebSocket から叩く黒箱テスト
shared/    クライアントとサーバーが共有する型とルール
             protocol.ts（WebSocket のメッセージの Valibot スキーマと、そこから導いた型）/ rules.ts（星の寿命ルール）/ limits.ts（上限・uid の形式）
scripts/   e2e.mjs（動作確認）/ loadtest.mjs（負荷テスト）/ latency.mjs（実環境の遅延を 2 接続で測る）/ notices.mjs（ライセンス表記の生成）
docs/      adr（設計判断）/ specs（仕様）/ qa（実機確認）/ TODO.md / この文書 / extending.md
```

ルートには、ツールがルートで探す設定だけを置きます（`package.json`・`tsconfig.json`・`wrangler.jsonc`・`vitest.config.ts`・`eslint.config.mjs`・`.gitignore`・`.gitattributes`）。Prettier の設定は `package.json` の `prettier` に置きます。使っている部品のライセンス表記は `client/public/THIRD_PARTY_NOTICES.txt`（`npm run notices` で生成し、サイトでも配信）です。

依存の向きは `client → shared ← server`。クライアントとサーバーは互いを直接 import しません。

## 設計方針（スケールのために）

| 課題 | 対策 | 詳細 |
| --- | --- | --- |
| 位置の全員配信が O(n²) | **視界ベースの配信**。クライアントが見ている範囲 `v` を送り、サーバーは視界の近くの動いた人だけを 1 通にまとめて送る。視界外は粗い一覧（ミニマップ用） | [ADR 0002](adr/0002-interest-management-presence.md) |
| 1 つの Durable Object が受けられる量には限りがある（目安 約 500〜1,000 req/s） | **サーバーが人数に応じて各クライアントの位置の送信間隔を指示**（100〜1000ms）。受信量を予算（500 通/秒）に収める | [ADR 0003](adr/0003-server-directed-send-rate.md) |
| 1 つの Durable Object の限界 | **満員（300 人）になったら次の空へ振り分け**（最大 8 空）。先頭の `space` は従来の名前のまま | [ADR 0001](adr/0001-rooms-and-sharding.md) |
| 星の保存のたびに全件をシリアライズ | **1 件 1 キー（`s:<id>` / `l:<id>`）で、変わった分だけ保存** | [ADR 0005](adr/0005-world-as-pure-class.md) |
| 密集度の計算が O(n²) | **空間ハッシュ**で近傍だけを数える。実行は 1 秒以上あけ、30 秒ごとのアラームでも実行 | [spatial.ts](../server/src/spatial.ts) |
| 不正な値・連打・他人の星の上書き・なりすまし | **Valibot のスキーマで入力検証**、**接続ごとのトークンバケット**、他人の星は上書き不可、**持ち主の鍵は秘密にして SHA-256 の ID だけを配信** | [protocol.ts](../shared/protocol.ts) / [validate.ts](../server/src/validate.ts) / [rate-limit.ts](../server/src/rate-limit.ts) |
| 同じ接続元（IP）からの大量の接続・連打 | Worker の入口で **Rate Limiting バインディング**（60 秒に 60 回）、空の中で同時接続数（32 本、メモリ上だけで数える）。IPv6 は /64 ごと。根本の対策は **Cloudflare のエッジのレート制限ルール**（設定は [TODO](TODO.md)） | [ADR 0009](adr/0009-prefer-proven-components.md) |
| 自作の部品が増えて保守できなくなる | 実績のある部品に置き換える: サーバーの接続管理は **PartyServer**、クライアントの再接続は **PartySocket**、入力検証は **Valibot** | [ADR 0009](adr/0009-prefer-proven-components.md) |
| 誰も動かないのにタイマーが回り続ける | 動きが無い間は配信タイマーを止め、Durable Object がハイバネートできるようにする | [presence.ts](../server/src/presence.ts) / [room.ts](../server/src/room.ts) |
| クライアントとサーバーでルールがずれる | メッセージ型と星の寿命ルールを `shared/` の 1 か所に置く。ハンドラ表で処理の書き忘れを型エラーにする | [ADR 0004](adr/0004-shared-protocol-and-handler-tables.md) |

調整値はすべて [server/src/config.ts](../server/src/config.ts) にあります。

### 世界のルール（スパム・荒らし対策）

- 星は全体で 500、線は 600 まで。1 ユーザーあたり星 64、線 96 まで
- **混雑ペナルティ**: 周囲（半径 0.06）の星の数で寿命が変わり、孤立した星は 3 時間、密集した星は最短 1 分で自然消滅する
- 星が消えるとその星につながる線も消える。同じ 2 点を結ぶ線は 1 本だけ
- 持ち主はセッションではなくブラウザ固有の ID で判定する。線は持ち主しか消せない。星は誰でも消せる代わりに、持ち主が幽霊から復活できる
- **きらめき（admire）の制限**: 同じ接続が同じ星へは 5 秒に 1 回、星ごとの全体では星の `ts`（作成・前回のきらめき）から 60 秒は誰がきらめいても延びない。寿命が延びるのは、星の作成（保存した `born`）から 24 時間まで
- **保存レコード**: 星には作成時刻 `born` と版 `v: 2` を持たせる。版が合わない旧形式のレコードは起動時に捨てる。持ち主が同じ id で置き直したときは位置・色だけを変え、`ts` と `born` は据え置く

## 通信メッセージ

JSON を WebSocket で送受信します。`t` が種別で、通信量を抑えるため短い名前を使っています（`p` = position、`v` = view、`ps` = presences）。型は [shared/protocol.ts](../shared/protocol.ts) が唯一の定義です。

| クライアント → サーバー | 意味 |
| --- | --- |
| `hello` | 接続の最初に 1 回。持ち主の秘密の鍵 `uid`（保存も配信もされない）。10 秒以内に来ない、または形式が合わないと 1008 で切断 |
| `p` | 自分の位置・色・視界。動いたときだけ、サーバーが指示した間隔で |
| `pulse` | 波紋を出す |
| `star` / `unstar` | 星を灯す / 消す |
| `admire` | 星にきらめきを送る（寿命を延ばす。同じ接続は同じ星へ 5 秒に 1 回、星ごとに全体で 60 秒に 1 回） |
| `link` / `unlink` | 線を引く / 消す |
| `"ping"`（文字列） | 死活監視。Durable Object を起こさずに `"pong"` が返る（`setWebSocketAutoResponse`） |

| サーバー → クライアント | 意味 |
| --- | --- |
| `welcome` | `hello` への返事。自分の id・持ち主 ID `me`・位置の送信間隔・今いる人・全ての星・全ての線 |
| `reject` | 断った `star` / `link`（上限超過・レート制限など）。クライアントは自分の画面から取り消す |
| `rate` | 空の人数が変わったときの、位置の送信間隔の指示 |
| `ps` | 他の人の位置のまとめ（`[id, x, y, color]` の配列） |
| `pulse` | 視界内で起きた波紋 |
| `star` / `unstar` / `link` / `unlink` | 星・線の変化（全員に） |
| `admire` | きらめき（`{id, ts}`。**全員に**。視界外の人の手元でも寿命を合わせる） |
| `leave` | 誰かが抜けた |

形と範囲の検証は `shared/protocol.ts` の Valibot スキーマ（`ClientMessageSchema`）が決め、型はそこから導きます。未知のメッセージは、サーバー・クライアントのどちらも無視します。

## 実装上のポイント

- **Hibernation**: 接続の受け付けとハイバネートからの復帰は PartyServer（`Server`、`static options = { hibernate: true }`）が担う。接続ごとに残す最小の情報（id・持ち主 ID・位置・色）は `connection.setState` に書き、起きたらそこからメモリ上の状態（トークンバケットなど）を作り直す
- **永続化**: `onStart`（PartyServer が `blockConcurrencyWhile` の中で呼ぶ）で保存済みの星・線を復元してから最初のリクエストを処理する。保存は変わった分だけ。旧形式のレコードはこのときに捨てる
- **受信の関門**: 1 通ごとに、JSON を読む前に 1 トークン取る（[inbound.ts](../server/src/inbound.ts)）。hello の前後で振り分け、処理の前に `COST` との差を追加で取る。直近 10 秒の窓で、あふれた割合が 0.5 以上かつあふれが 100 通以上なら 1008 で切断。hello 前の hello 以外・2 回目以降の hello は通算 20 回目で 1008 で切断
- **接続元（IP）**: IP は保存しない。Worker の入口で接続頻度（Rate Limiting バインディング、60 秒に 60 回）を、空の中で同時接続数（32 本、メモリ上だけ）を数える。IPv6 は /64 ごと。多数の IP を使う相手への根本の対策は、Cloudflare のエッジのレート制限ルールで行う
- **再接続（クライアント）**: PartySocket（`partysocket/ws`）に任せる。待ちは最小 1.5 秒（端末ごとに 1.0〜1.5 倍ずらす）、×1.6 ずつ、最大 15 秒。接続が 5 秒続くと待ちが戻る。送信バッファは使わない（`maxEnqueuedMessages: 0`）。1008 で切られたら 30〜45 秒待つ。開いて 10 秒 welcome が来なければつなぎ直す
- **死活監視**: クライアントが 10 秒ごとに `"ping"` を送り、25 秒何も届かなければ（ping 2 回に答えが無い）切れているとみなしてつなぎ直す。タブが 30 秒隠れたら切断して空きを返し、戻ったらつなぎ直す
- **切断中**: 切断中・welcome 前は編集操作（星・線・消去・アンドゥ）をしない（`App.canEdit`）。切断中の操作は後から送らず捨てる
- **接続先の切り替え**: `workers.dev` と `wrangler dev`（8787）では同一オリジン、`?ws=localhost:8787` で手元の Worker に上書き可能（`uid` の流出を避けるため localhost のみ許可）、それ以外は本番の Worker（[constants.ts](../client/src/constants.ts) の `WS_HOST`）
- **ツール（Strategy）**: 操作はツールごとのクラス（`client/src/tools/`）。ツールは `ToolContext`（必要なものだけ）を受け取り、ドラッグ中の連続操作は自分で 1 つの履歴にまとめる
- **ストレージ**: `localStorage` の失敗は [storage.ts](../client/src/storage.ts) の 1 か所だけで握りつぶす
- **観測**: `GET /stats`（`x-stats-token` ヘッダが `STATS_TOKEN` と一致したときだけ。それ以外は 404）が空ごとの接続数・星の数・送信間隔を返す

## テスト

| 種類 | 場所 | 実行 | 内容 |
| --- | --- | --- | --- |
| 単体（node） | `server/tests/*.test.ts` / `client/tests/**/*.test.ts` | `npm run test:unit` | 純粋なロジック。Node で動く |
| ランタイム | `server/tests/runtime/*.test.ts` | `npm run test:runtime` | 本物の Workers ランタイム（workerd）上で Worker と Durable Object を立ち上げ、WebSocket で叩く黒箱テスト（`@cloudflare/vitest-plugin`） |
| 両方 | — | `npm test` | `vitest run`（`vitest.config.ts` の 2 つのプロジェクト `node` と `runtime`） |

ランタイムテストは `handshake`（hello・welcome・切断）、`world`（星・線・きらめき・上限）、`presence`（位置・波紋・送信間隔）、`lifecycle`（永続化・ハイバネート復帰・旧形式データ）、`robustness`（不正な入力・ping・レート制限・`/stats`）に分かれます。1 つの空を共有するので、ファイルは並べて走らせず、各テストのあとに全接続を閉じて Durable Object を消します。静的アセットは空の一時ディレクトリに差し替えるので、ビルドしなくても動きます。

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

ブラウザを使わず、WebSocket で実際のサーバーに対して通しの流れを確かめるスクリプトです（ブラウザ上の操作の自動テストは [TODO](TODO.md)）。

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
npm run build          # 型チェック + client/dist/ に出力
npm run typecheck      # 型チェック（tsc -b）
npm run lint           # ESLint
npm run format         # Prettier で整形 / npm run format:check で確認だけ
npm test               # 単体 + ランタイム / test:unit（node だけ）/ test:runtime（workerd だけ）
npm run notices        # THIRD_PARTY_NOTICES を生成 / npm run notices:check で最新か確認
npm run check          # 型チェック・lint・整形チェック・ライセンス表記・テスト（両方）
npm run e2e            # scripts/e2e.mjs（上の「動作確認」）
npm run loadtest       # scripts/loadtest.mjs（上の「負荷テスト」）
npm run latency        # scripts/latency.mjs（実環境の遅延を 2 接続で測る）

# デプロイ
npm run deploy         # ビルド + Pages へ配信
npm run deploy:server  # Worker（Durable Object）
```

> 注意: `wrangler dev` を起動したままビルドしないでください（`client/dist` を監視しているため、ビルドが失敗することがあります）。また、通信形式が変わったときは Worker と Pages を続けてデプロイしてください（[ADR 0006](adr/0006-no-backward-compatibility.md)）。
