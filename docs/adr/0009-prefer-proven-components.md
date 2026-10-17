# 0009. 自作を減らし、実績のある部品に置き換える

- 状態: 採用（日付 2026-10-17）

## 背景

独立コードレビューを 3 回行い、重大・高の指摘が 1 回目 6 件、2 回目 1 件、3 回目 1 件（直前の修正が生んだ退行）と続いた。
指摘の多くは、**自作した部分**にあった。

- Durable Object の接続管理とハイバネート復帰（`room.ts` の接続の再構築、`drop`、alarm の締め切り）
- クライアントの再接続の状態機械（二重接続、古い接続のイベント、half-open、バックオフの戻し方）
- 手書きの入力検証と、型の二重定義
- IP ごとの制限（接続数、接続頻度、星の上限、HMAC）

リアルタイム通信と認証まわりは、直すたびに新しい穴が見つかりやすい。「指摘 0」は現実的な目標にならない。
そこで、**実績のある部品に置き換えて、自作のコードを減らす**。コードが無くなれば、指摘の元も無くなる。

## 検討した選択肢

調査した一次情報とメタデータ（2026-10-17 時点）:

| 部品 | 役割 | ライセンス | 最終更新 | 判断 |
| --- | --- | --- | --- | --- |
| [PartyServer](https://github.com/cloudflare/partykit/tree/main/packages/partyserver) 0.5.10 | Durable Object の WebSocket 部屋。接続状態・broadcast・ハイバネートの統一 API | ISC | 2026-08 | **採用**（Cloudflare 公式リポジトリ） |
| [PartySocket](https://github.com/cloudflare/partykit/tree/main/packages/partysocket) 1.3.0 | 再接続する WebSocket（バックオフ、接続タイムアウト、最大リトライ） | MIT | 2026-06 | **採用** |
| [Valibot](https://valibot.dev) 1.5.0 | スキーマ検証。スキーマから型を導出 | MIT | 2026-09 | **採用** |
| [@cloudflare/vitest-plugin](https://developers.cloudflare.com/workers/testing/vitest-integration/) 1.4.4 | Workers ランタイム上でテスト（Vitest 5 対応） | MIT | 2026-10 | **採用**（`room.ts` に単体テストが無かった） |
| [Rate Limiting バインディング](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) | Worker からのレート制限 | — | — | **見送り**。プランでの利用可否が公式資料で確認できず、デプロイ時に失敗する恐れがある。場所ごとの近似であり、正確な計数には向かない |
| Cloudflare のエッジのレート制限ルール（WAF） | IP ごとの接続頻度の制限 | — | — | **採用**（コードの外。設定手順を [TODO](../TODO.md) に書く） |

## 決定

- Durable Object を **PartyServer** の `Server` に載せ替える。接続の管理・ハイバネートからの復帰・broadcast は部品に任せる。
  残すのは、アプリ固有の部分（hello の握手、世界のルール、視界配信、満員の振り分け）。
- クライアントの接続を **PartySocket** に載せ替える。再接続・バックオフ・接続タイムアウトは部品に任せる。
  残すのは、hello の送信、死活監視の ping、隠れたタブの切断、サーバーが指示した送信間隔。
- メッセージのスキーマを **Valibot** で `shared/` に 1 か所で定義する。サーバーの入力検証と、型の導出に使う（手書きの検証と型の二重定義をやめる）。
- **IP に関する自作コードを削除する**（接続元の HMAC、同一 IP の接続数・接続頻度・星の上限）。IP ごとの制限は、エッジの
  レート制限ルールで行う。サーバーに残る防御は、接続ごとのトークンバケット、1 人あたりと全体の上限、混雑ペナルティ。
- `room.ts` を含むサーバーのテストを、**@cloudflare/vitest-plugin** で Workers ランタイム上で行う。

## 結果

- 良い点: 指摘の元になっていた自作コード（接続の再構築、再接続の状態機械、手書きの検証、IP の管理）が減る。
- 良い点: 実績のある部品が、既知の問題を直し続けてくれる。バグの報告先もある。
- トレードオフ: 依存が増える（PartyServer は 0.x。API が変わる可能性がある）。バージョンを固定し、Dependabot で追う。
- トレードオフ: IP ごとの制限はコードの外（Cloudflare の設定）に出る。設定しないと、1 つの IP から多数の接続ができる。
- 方針: 「自作は、使える部品が無いときだけ」（`research-reuse` スキル）。

## 参考

- 調べた一次情報は上の表のリンク。知識ベース: `~/.claude/skills/knowledge-upkeep/references/`
- 関連: ADR 0003（送信間隔）、ADR 0007（hello と持ち主 ID）、ADR 0008（コスト）
