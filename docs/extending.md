# 拡張ガイド

機能を足すときの手順です。型エラーが「足りない場所」を教えてくれるように作ってあります。

## 新しいメッセージを足す（例: `emote`）

1. **[shared/protocol.ts](../shared/protocol.ts)** に型を足す
   - クライアント → サーバーなら `ClientMessage`、逆なら `ServerMessage` のユニオンに追加
2. **[server/src/validate.ts](../server/src/validate.ts)** の `parseClientMessage` に `case "emote"` を足す
   - 型・範囲・長さを検証して、通ったものだけを返す。ここを通らないものは状態に触れない
3. **[server/src/config.ts](../server/src/config.ts)** の `COST` にレート制限のコストを足す
   - 足さないと型エラー。重い操作ほどコストを大きくする
4. **[server/src/handlers.ts](../server/src/handlers.ts)** の `handlers` に処理を足す
   - 足さないと型エラー。部屋への操作は `RoomApi`（`broadcast` / `broadcastNear` / `persist` など）だけを使う
5. サーバーから返すメッセージがあれば、**[client/src/message-handlers.ts](../client/src/message-handlers.ts)** の `serverHandlers` に処理を足す
   - 足さないと型エラー
6. **[server/tests/](../server/tests/)** に検証と挙動のテストを足す

## 世界のルールを変える（例: 星の上限、寿命）

- 数値は [server/src/config.ts](../server/src/config.ts)（上限・レート・配信間隔）か [shared/rules.ts](../shared/rules.ts)（寿命。クライアントの表示にも使う）
- ルール自体は [server/src/world.ts](../server/src/world.ts)。Cloudflare に依存しない純粋なクラスなので、`server/tests/world.test.ts` にテストを足してから変える

## クライアントにツールを足す（例: 「色を塗る」）

1. [client/src/constants.ts](../client/src/constants.ts) の `ToolName`・`TOOL_SVG`・`TOOL_TIPS` に足す
2. [client/src/input.ts](../client/src/input.ts) のポインタ処理に分岐を足す（連続操作は `*Batch` でまとめてアンドゥに載せる）
3. 状態を変える操作は [client/src/universe.ts](../client/src/universe.ts) のメソッドにして、`send` でサーバーへ送る
4. 描画は [client/src/renderer.ts](../client/src/renderer.ts) に足す

## 空の振り分けや規模を変える

- 1 つの空の人数: `LIMITS.roomCapacity`、空の数: `LIMITS.maxRooms`
- 空の名前の付け方: `roomName()`。新しい空は最初は空っぽ（先頭の `space` だけが既存データを持つ）

## 変更するときの確認

```bash
npm run typecheck && npm test && npm run build
npm run dev:server           # 手元の Worker を起動して、ブラウザで http://localhost:8787 を確認
npm run loadtest -- ws://localhost:8787/ws 200 10   # 負荷の確認（ローカルに向けること）
```
