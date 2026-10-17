# 0005. 世界のルールを純粋なクラスに分ける

- 状態: 採用（日付 2026-10-17）

## 背景

星・線・寿命・上限といった世界のルールを、WebSocket や永続化を扱う Durable Object
（`server/src/room.ts`）に直接書くと、ルールの確認に Cloudflare の実行環境が要る。
通信・保存・ルールが混ざると、変更のたびに影響範囲も読みにくい。

## 検討した選択肢

- DO クラスに直接書く
  - 利点: ファイルが少なく、最初は速く書ける。
  - 欠点: 単体テストに実行環境のモックが要る。責務が混ざる。
- Cloudflare に依存しない純粋なクラスに分ける
  - 利点: 普通の関数呼び出しでテストできる。ルールだけを読める。
  - 欠点: 呼び出し側が戻り値を受けて配信・保存する手間が増える。

## 決定

純粋なクラス `World`（`server/src/world.ts`）を作る。星と線の操作は戻り値で結果を返し
（`placeStar`, `removeStar` など）、配信と永続化は `room.ts` が行う。

永続化は差分で行う。星は `s:<id>`、線は `l:<id>` の1件1キーで保存し、
変更は `World.drainChanges()` が `put` / `del` としてまとめて返す。`room.ts` の `persist` が
128件ずつに分けて書く。

密集度の計算には空間ハッシュ（`server/src/spatial.ts` の `crowdCounts`）を使い、全組み合わせ O(n²) を避けて、
近傍だけを見る O(n) にする。

旧形式の保存データは、後方互換を取らない方針（ADR 0006）に従い、1回限りの移行だけを残す。

## 結果

- 良い点: `server/tests/world.test.ts` と `server/tests/spatial.test.ts` で、環境なしにルールを検証できる。
- 良い点: 1件1キーなので、変更した分だけ書ける。全件を毎回書き直さない。
- トレードオフ: 戻り値を受けて配信・保存するコードが `room.ts` に残り、呼び忘れの余地がある。
- トレードオフ: 空間ハッシュのセルは固定幅なので、極端に偏った分布では効果が落ちる。

## 参考

- 実装: `server/src/world.ts`（`World`, `drainChanges`, `starKey`, `linkKey`）、`server/src/spatial.ts`（`crowdCounts`）、`server/src/room.ts`（`persist`）
- テスト: `server/tests/world.test.ts`、`server/tests/spatial.test.ts`
