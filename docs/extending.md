# 拡張ガイド

機能を足すときの手順です。**仕様 → テスト → 実装**の順で進めます（[specs/README.md](specs/README.md)）。型エラーが「足りない場所」を教えてくれるように作ってあります。

## 0. 先にやること

1. [specs/](specs/README.md) に、何を・なぜ・受け入れ条件を書く（小さな変更なら数行でよい）
2. 設計判断が要るなら [adr/](adr/README.md) に 1 本書く
3. テストを先に書く（赤を確認する）

## 新しいメッセージを足す（例: `emote`）

1. **[shared/protocol.ts](../shared/protocol.ts)** に Valibot のスキーマを足す
   - クライアント → サーバーなら `ClientMessageSchema` のユニオンに、逆なら `ServerMessage` に追加する。型 `ClientMessage` はスキーマから導かれる
   - 型・範囲・長さの検証はスキーマに書く（`Coord` / `Color` / `Id` などの部品がある）。ここを通らないものは状態に触れない
2. **[server/src/config.ts](../server/src/config.ts)** の `COST` にレート制限のコストを足す（足さないと型エラー）
3. **[server/src/handlers.ts](../server/src/handlers.ts)** の `handlers` に処理を足す（足さないと型エラー）
   - 受信の経路は、PartyServer の `onMessage`（[room.ts](../server/src/room.ts)）→ `screenRaw`（JSON を読む前のトークン）→ `parseClientMessage`（[validate.ts](../server/src/validate.ts)。スキーマで検証）→ `classify`（hello の前後の振り分け）→ `COST` の追加分 → `dispatch`（`handlers`）。`validate.ts` に `case` を足す必要は無い
   - 部屋への操作は `RoomApi`（`send` / `broadcastAll` / `broadcastNear` / `persist` など）だけを使う
4. サーバーから返すメッセージがあれば、**[client/src/message-handlers.ts](../client/src/message-handlers.ts)** の `serverHandlers` に処理を足す（足さないと型エラー）
5. テストを足す。純粋なロジック（検証・ハンドラ・World）は **[server/tests/](../server/tests/)**（node）と **[client/tests/](../client/tests/)**。実際の接続・配信・永続化の流れは **[server/tests/runtime/](../server/tests/runtime/)**（Workers ランタイム上。`helpers.ts` の接続の補助を使う）。通しの確認は `scripts/e2e.mjs` に足す

## 世界のルールを変える（例: 星の上限、寿命）

- 数値は [server/src/config.ts](../server/src/config.ts)（上限・レート・配信間隔）か [shared/rules.ts](../shared/rules.ts)（寿命。クライアントの表示にも使う）
- ルール自体は [server/src/world.ts](../server/src/world.ts)。Cloudflare に依存しない純粋なクラスなので、`server/tests/world.test.ts` にテストを足してから変える
- 保存する形（星の `born`・版 `v`）を変えるときは `STORE_VERSION` を上げる。版の合わない旧形式のレコードは起動時に捨てられる（[ADR 0006](adr/0006-no-backward-compatibility.md)）
- 位置の配信（誰に・何を送るか）は [server/src/presence.ts](../server/src/presence.ts)（純粋なロジック。`server/tests/presence.test.ts`）
- 同じ接続元（IP）ごとの制限を増やすときは、IP を保存しない形にする。接続元を数える単位は `gateway.ts` の `addressKey`（IPv6 は /64）にそろえる（[ADR 0009](adr/0009-prefer-proven-components.md)）

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
npm run check                # 型チェック・lint・整形チェック・ライセンス表記・テスト（node + ランタイム）
npm run test:unit            # node の単体テストだけ
npm run test:runtime         # Workers ランタイム上のテストだけ
npm run build
npm run dev:server           # 手元の Worker を起動し、http://localhost:8787 をブラウザで確認
node scripts/e2e.mjs http://localhost:8787 --full
npm run loadtest -- ws://localhost:8787/ws 200 10   # 負荷の確認（ローカルに向けること）
```

依存を足したり変えたりしたら `npm run notices` で `THIRD_PARTY_NOTICES` を更新する（`npm run check` が最新かを検査する）。

実機で動かす機能（触覚・音・タッチなど）は [qa/device-checklist.md](qa/device-checklist.md) に確認結果を残します。
