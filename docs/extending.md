# 拡張ガイド

機能を足すときの手順です。**仕様 → テスト → 実装**の順で進めます（[specs/README.md](specs/README.md)）。型エラーが「足りない場所」を教えてくれるように作ってあります。

## 0. 先にやること

1. [specs/](specs/README.md) に、何を・なぜ・受け入れ条件を書く（小さな変更なら数行でよい）
2. 設計判断が要るなら [adr/](adr/README.md) に 1 本書く
3. テストを先に書く（赤を確認する）

## 新しいメッセージを足す（例: `emote`）

1. **[shared/protocol.ts](../shared/protocol.ts)** に型を足す
   - クライアント → サーバーなら `ClientMessage`、逆なら `ServerMessage` のユニオンに追加
2. **[server/src/validate.ts](../server/src/validate.ts)** の `parseClientMessage` に `case "emote"` を足す
   - 型・範囲・長さを検証して、通ったものだけを返す。ここを通らないものは状態に触れない
3. **[server/src/config.ts](../server/src/config.ts)** の `COST` にレート制限のコストを足す（足さないと型エラー）
4. **[server/src/handlers.ts](../server/src/handlers.ts)** の `handlers` に処理を足す（足さないと型エラー）
   - 部屋への操作は `RoomApi`（`broadcast` / `broadcastNear` / `persist` など）だけを使う
5. サーバーから返すメッセージがあれば、**[client/src/message-handlers.ts](../client/src/message-handlers.ts)** の `serverHandlers` に処理を足す（足さないと型エラー）
6. **[server/tests/](../server/tests/)** と **[client/tests/](../client/tests/)** にテストを足す。通しの確認は `scripts/e2e.mjs` に足す

## 世界のルールを変える（例: 星の上限、寿命）

- 数値は [server/src/config.ts](../server/src/config.ts)（上限・レート・配信間隔）か [shared/rules.ts](../shared/rules.ts)（寿命。クライアントの表示にも使う）
- ルール自体は [server/src/world.ts](../server/src/world.ts)。Cloudflare に依存しない純粋なクラスなので、`server/tests/world.test.ts` にテストを足してから変える

## クライアントにツールを足す（例: 「色を塗る」）

1. [client/src/constants.ts](../client/src/constants.ts) の `ToolName`・`TOOL_SVG`・`TOOL_TIPS` に足す
2. **[client/src/tools/](../client/src/tools/)** に `Tool`（[tool.ts](../client/src/tools/tool.ts)）を実装したクラスを足す
   - `down` / `move` / `up` / `cancel`。ドラッグ中の連続操作は自分で 1 つの履歴（`history.pushOp`）にまとめる
   - 必要なものは `ToolContext` から受け取る（`App` 全体には触れない）
3. [tools/index.ts](../client/src/tools/index.ts) の `createTools` に登録する（足さないと型エラー）
4. ショートカットのキーを割り当てるなら [input.ts](../client/src/input.ts) の `TOOL_ORDER`
5. 状態を変える操作は [universe.ts](../client/src/universe.ts) のメソッドにして、`send` でサーバーへ送る。描画は [renderer.ts](../client/src/renderer.ts)
6. [client/tests/tools.test.ts](../client/tests/tools.test.ts) にテストを足す

## 空の振り分けや規模を変える

- 1 つの空の人数: `LIMITS.roomCapacity`、空の数: `LIMITS.maxRooms`
- 位置の送信間隔の指示: `LIMITS.inboundBudgetPerSec`（受信量の予算）と `sendMsFor()`
- 新しい空は最初は空っぽ（先頭の `space` だけが既存データを持つ）

## 変更するときの確認

```bash
npm run check                # 型チェック・lint・整形チェック・単体テスト
npm run build
npm run dev:server           # 手元の Worker を起動し、http://localhost:8787 をブラウザで確認
node scripts/e2e.mjs http://localhost:8787 --full
npm run loadtest -- ws://localhost:8787/ws 200 10   # 負荷の確認（ローカルに向けること）
```

実機で動かす機能（触覚・音・タッチなど）は [qa/device-checklist.md](qa/device-checklist.md) に確認結果を残します。
