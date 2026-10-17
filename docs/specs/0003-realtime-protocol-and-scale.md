# 0003 通信とスケール

## 目的

人が増えても、1 つの空（Durable Object）が受け取るメッセージ量を一定の予算に収め、全員の画面で光が滑らかに見えるようにする。
通信が切れても、画面を隠しても、不正な入力が来ても、体験が壊れないようにする。

## やらないこと

- 世界を分割して 1 つの空を保ったままスケールすること（タイル分割）。[TODO](../TODO.md) の将来課題。
- 古いクライアントとの互換（[ADR 0006](../adr/0006-no-backward-compatibility.md)）。ただし未知のメッセージは無視する。
- 500 人以上の同時接続の保証。N=500 の負荷試験は未解決（TODO）。

## インターフェース

### メッセージ（shared/protocol.ts）

| 向き | t | 内容 |
| --- | --- | --- |
| C→S | `hello` | 接続の最初に 1 回。持ち主の秘密の鍵 `uid`。サーバーはこれを SHA-256 にして持ち主 ID にする。hello の前のメッセージは無視される（違反として数える）。10 秒以内に来ない、または形式が合わないと 1008 で切断 |
| C→S | `p` | 位置 x, y・色 c・視界 v（任意） |
| C→S | `pulse` / `star` / `unstar` / `admire` / `link` / `unlink` | 波紋・星の配置（色 c を含む）と削除・きらめき・線の作成と削除。uid は載せない |
| S→C | `welcome` | hello への返事。自分の id と持ち主 ID `me`・送信間隔 sendMs・他人の点 dots・星・線 |
| S→C | `reject` | 上限超過・レート制限などで断った star / link。クライアントは自分の画面から取り消す |
| S→C | `rate` | 人数が変わったときの送信間隔の指示 |
| S→C | `ps` | 他人の位置 `[id, x, y, c]` の配列 |
| S→C | `pulse` / `star` / `unstar` / `admire` / `link` / `unlink` / `leave` | 他人の操作の反映と退出。`admire` は `{id, ts}` |

- メッセージの追加は shared/protocol.ts に Valibot のスキーマを足し（型はスキーマから導く）、サーバーは handlers.ts、クライアントは message-handlers.ts に処理を書く。足さないと型エラーになる。
- 位置の配信は、視界（`v`）に余白 30%（`viewMargin`）を足した範囲の人にだけ送る。波紋（`pulse`）も視界内の人にだけ送る。星・線・きらめき（`admire`）・退出は全員に送る（きらめきは視界外の人の手元でも寿命を合わせるため）。
- 2 秒ごと（`coarseEveryTicks` = 20 tick）に、視界外も含めた粗い一覧を全員へ送る（ミニマップ用）。1 回に載せる人数は 150 人まで（`maxPeersPerMessage`）。人数が多いときは窓をずらして全員が順に載る。

### 送信間隔・レート・容量（server/src/config.ts）

- 送信間隔 `sendMsFor(n)` = n 人 × 1000 / 500（`inboundBudgetPerSec`）ms を 50ms 刻みに切り上げ、100ms（`sendMsMin`）〜1000ms（`sendMsMax`）に収める。50 人まで 100ms、100 人で 200ms、300 人で 600ms。**空に 1 人だけのときは 1000ms**（誰にも見えないので、課金対象の受信メッセージを減らす。[ADR 0008](../adr/0008-cost-aware-message-budget.md)）。
- クライアントはこの指示に従う（`welcome.sendMs` と `rate`）。動いたときだけ送る（動かない間は何も送らない。死活監視は ping に任せる）。
- 配信の tick は 100 人まで 100ms、200 人まで 150ms、それ以上は 250ms。動きが 30 tick 無ければタイマーを止める（ハイバネート可能にする）。
- レート制限はトークンバケット（接続ごと）。容量 200、毎秒 40 回復。コストは `p`=1、`pulse`=4、`star`=2、`unstar`=1、`admire`=2、`link`=2、`unlink`=1。メッセージは JSON を読む前に 1 トークンを取り（足りなければ捨てる）、処理の前に `COST` との差を追加で取る。
- **切断の条件**: 直近 10 秒（`rateWindowMs`）の窓で、あふれた通数が 100 以上（`closeMinDrops`）かつ、あふれ ÷（通った + あふれ）が 0.5 以上（`closeOverflowRatio`）のとき 1008 で切断する。許容量の 2 倍で送り続けるとちょうど 0.5 になるので「以上」で判定する。短いバーストや通常の連打では切れない。
- **違反の数え方**: hello の前の hello 以外、2 回目以降の hello を「手順の違反」として、接続ごとに通算で数える（間に正しいメッセージがあっても減らさない）。20 回目（`maxProtocolViolations`）で 1008 で切断する。形式の合わない uid の hello は 1 回で切断する。
- **きらめきの間隔**: 同じ接続が同じ星へは 5 秒に 1 回（`admireCooldownMs`、星 256 件まで覚える）。さらに星ごとに、星の `ts`（作成・前回のきらめき）から 60 秒（`admireMinIntervalMs`）は誰がきらめいても延びない。寿命が延びるのは、星の作成（保存した `born`）から 24 時間（`maxStarAgeMs`）まで。
- **保存レコード**: 星は作成時刻 `born` と版 `v: 2` を持つ。線も `v: 2`。版が合わない旧形式のレコードは起動時に捨てる。持ち主が同じ id で置き直したときは `ts` と `born` を据え置く。
- **IP ごとの制限は薄く持つ**: 接続頻度は Worker の入口（Rate Limiting バインディング、60 秒に 60 回）、同時接続数は空ごとに 32 本（メモリ上だけで数え、IP は保存しない）。IPv6 は /64 ごと。それ以上はエッジのレート制限ルールに任せる（[ADR 0009](../adr/0009-prefer-proven-components.md)。設定は [TODO](../TODO.md)）。
- 容量は 1 つの空に 300 人（`roomCapacity`）、空は最大 8 つ（`maxRooms`）。空の名前は `space`, `space-2`, ...

## 受け入れ条件

確認方法: 自動 = server/tests / client/tests（Node）、ランタイム = server/tests/runtime/*.test.ts（Workers ランタイム上。`npm run test:runtime`）、e2e = `scripts/e2e.mjs`、負荷 = `scripts/loadtest.mjs`（ローカルの `wrangler dev` に向ける）、手動 = [device-checklist](../qa/device-checklist.md)

| # | 条件 | 確認 |
| --- | --- | --- |
| 1 | 300 人の空で、全員が指示の間隔で送ったときの受信が 500 通/秒以内に収まる | config.test「全員が送ったときの合計が予算に収まる」/ 負荷 |
| 2 | 送信間隔は人数が増えるほど広がり（単調増加）、50ms 刻みで、1000ms を超えない | config.test |
| 3 | 人数が変わって送信間隔が変わると、全員に `rate` が届き、クライアントは間隔を更新する | message-handlers.test「rate」 |
| 4 | 空が 300 人で満員のとき、次の空（`space-2`）に入れる。全部満員なら 503 | 負荷（手動で `roomCapacity` を下げて確認） |
| 5 | 先頭の空の名前は `space` のまま（既存の星を引き継ぐ） | config.test「roomName」 |
| 6 | 視界の遠い相手には、近くの波紋が届かない | e2e |
| 7 | 他の人の位置は、視界内の人にだけ届く。自分の位置は返らない | e2e / message-handlers.test「ps」 |
| 8 | 不正な入力（範囲外の座標・未知の種類・大きすぎるメッセージ）のあとも接続が保たれる | validate.test / runtime robustness.test / e2e |
| 9 | 操作が連続して多すぎると、超えた分は捨てられ、あふれ続けると切断される（直近 10 秒で、あふれ 100 通以上かつ割合 0.5 以上）。上限ぶんの一括操作（星 64 個の全消去・全復活）は、クライアントが 1 秒に 20 件ずつに小分けして送る（`client/src/op-pacer.ts`）ので捨てられない | rate-limit.test / inbound.test / config.test「レート制限の設定」 / runtime robustness.test |
| 10 | 1 つのハンドラが例外を起こしても、部屋全体は止まらない | 手動（room.ts の try/catch） |
| 11 | `ping` に `pong` が返る（サーバーを起こさない） | e2e / runtime robustness.test |
| 12 | `/stats` が空ごとの接続数・星の数・送信間隔を返す（token が無い・違うときは 404）。10 秒キャッシュされる | e2e / runtime robustness.test |
| 13 | 誰かが抜けると `leave` が届き、画面から光が消える | e2e / message-handlers.test「leave」 / runtime lifecycle.test |
| 19 | hello を送るまで welcome は来ず、hello 前のメッセージは無視される。hello が 10 秒来ない・形式が合わない・違反が続く接続は 1008 で切られる | inbound.test / runtime handshake.test |
| 20 | 星・線は保存され、全員が切断しても、Durable Object が退避されても残る。ハイバネートから復帰しても持ち主・位置の配信が保たれる。旧形式のデータは起動時に捨てられる | world.test / runtime lifecycle.test |
| 21 | 星・線・きらめきの配信、他人の星の上書き拒否、1 人 64 個の上限が、実際のランタイムで動く | runtime world.test |
| 22 | 視界・波紋・送信間隔の指示（1 人のとき 1000ms、2 人で 100ms）が、実際のランタイムで動く | runtime presence.test |
| 23 | きらめきは全員に配られ、同じ接続は同じ星へ 5 秒、星ごとに全体で 60 秒の間隔がある。作成から 24 時間を過ぎた星は延びない | handlers.test / world.test / runtime world.test |

### 再接続・死活監視・隠れたタブ（client/src/network.ts）

| # | 条件 | 確認 |
| --- | --- | --- |
| 14 | 切断されると、PartySocket が自動でつなぎ直す。待ちは最小 1.5 秒（端末ごとに 1.0〜1.5 倍）、×1.6 ずつ、最大 15 秒。接続が 5 秒続くと待ちが戻る | network.test（設定値）/ 手動 |
| 15 | 切断中は他人の光が消え、星・線・消去などの編集はできない。切断中の操作は再接続後に送らない（`maxEnqueuedMessages: 0`）。再接続すると welcome で星・線・他人が入り直す | network.test / 手動 |
| 16 | 10 秒ごとに `ping` を送り、25 秒間何も受け取れなければ切れているとみなしてつなぎ直す。開いて 10 秒 welcome が来なければつなぎ直す | network.test / 手動 |
| 17 | タブが 30 秒隠れ続けたら切断して空きを返し、表示に戻ったらつなぎ直す。30 秒以内に戻れば切断しない | network.test / 手動 |
| 18 | `file:` で開いたとき、`?solo` のときは接続しない | 手動 |
| 24 | サーバーが 1008 で切ったときは、PartySocket の再接続を止め、30〜45 秒待ってからつなぎ直す | network.test / 手動 |

## リスク

- 300 人を超える負荷はローカルでしか測っていない。N=500 では配信が止まる（原因調査中、TODO）。実環境（Cloudflare）での CPU 時間は未測定。
- 300 人で送信間隔が 600ms になるため、光の動きはカクつく。クライアントは補間して滑らかに見せるが、体感は実機で確認する。
- 同じ接続元（IP）ごとの制限は、エッジのレート制限ルールを設定するまで無い（[TODO](../TODO.md)）。設定するまでは、1 つの接続ごとの制限だけが効く。
- 通信形式を変える変更は、Worker と Pages を同時にデプロイしないと他人の光が見えなくなる。
