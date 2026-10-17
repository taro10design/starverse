# 0004. 共有プロトコルと、型で網羅するハンドラ表

- 状態: 採用（日付 2026-10-17）

## 背景

クライアントとサーバーは WebSocket のメッセージで話す。メッセージを足すとき、
型の定義・検証・サーバー側の処理・クライアント側の処理の4か所を直す必要があり、
どれかを書き忘れても気づきにくい。

## 検討した選択肢

- `if` / `switch` の連鎖
  - 利点: 単純で、読みやすい。
  - 欠点: 新しいメッセージの処理を書き忘れてもコンパイルが通る。
- 型で網羅するハンドラ表
  - 利点: メッセージ型を足すと、表に項目が無い箇所が型エラーになる。
  - 欠点: 型が少し複雑になる。
- スキーマ生成（zod など）
  - 利点: 型と検証を1つの定義から作れる。
  - 欠点: 依存が増え、バンドルが大きくなる。メッセージが少ない今の規模には過剰。

## 決定

メッセージ型は `shared/protocol.ts` に1か所で定義し、両側から読む。
処理は表にする。サーバーは `server/src/handlers.ts` の `handlers`、
クライアントは `client/src/message-handlers.ts` の `serverHandlers` で、どちらも
`{ [K in MessageType]: Handler<K> }` の形にする。メッセージを足して処理を書き忘れると、型エラーになる。

入力はサーバーの境界（`server/src/validate.ts` の `parseClientMessage`）で、型・範囲・長さを検証する。
検証を通らないもの、未知のメッセージは無視する（`default` で `null` を返す）。
検証は手書きで、スキーマ生成は使わない。

## 結果

- 良い点: メッセージ追加時の漏れをコンパイラが見つける。
- 良い点: 型の定義が1か所なので、両側のずれが起きにくい。
- 良い点: 不正な入力が内部に入らない。
- トレードオフ: 検証コードは手書きで、型と二重になる。メッセージが増えたらスキーマ生成を再検討する。
- トレードオフ: 未知のメッセージは黙って捨てるため、綴りの間違いは気づきにくい。
- Worker と Pages の同時デプロイで新旧のメッセージが一時的に混ざる件は ADR 0006 を参照。

## 参考

- 実装: `shared/protocol.ts`（`ClientMessageType`, `ServerMessageType`）、`server/src/handlers.ts`（`handlers`, `dispatch`）、`client/src/message-handlers.ts`（`serverHandlers`, `handleServerMessage`）、`server/src/validate.ts`（`parseClientMessage`）
- テスト: `server/tests/validate.test.ts`、`client/tests/message-handlers.test.ts`
