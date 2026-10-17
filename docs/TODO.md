# TODO

ブランチ `feat/scalable-server` で未完了のこと、次にやることのメモです。優先度は上ほど高いです。

## すぐにやる

- [ ] **N=500 で配信が止まる原因を調べる**
  - 再現: `npm run dev:server` を起動し、`npm run loadtest -- ws://localhost:8787/ws 500 10`
  - 結果: 451/500 人が接続したあと、測定中の受信が 0 になる（N=300 までは動く）
  - 仮説: ①ローカル workerd の接続数・CPU の限界 ②300 人を超えて 2 つ目の空（`space-2`）へ振り分けた経路の不具合 ③負荷生成側の限界
  - 切り分け: `LIMITS.roomCapacity` を 1000 にして 500 人が 1 つの空に入るかを見る。逆に 100 にして振り分けを確認する
- [ ] **Worker と Pages を同時にデプロイする**（未デプロイ）
  - 通信形式が変わった（位置の配信が `p` → `ps`）。どちらか片方だけだと、他の人の光が見えなくなる
  - 手順: `npm run deploy:server` と `npm run deploy` を続けて実行 → https://uchu.pages.dev で 2 つのタブから動作確認
  - 既存の星は旧形式（`stars` キー）から自動で移行される。デプロイ後に残っているか確認する
- [ ] **PC の操作を直感的にする**
  - 現状: ズームはホイールで OK。パン（視点移動）はドラッグが無く、カーソルを画面端に寄せるかミニマップしかない
  - やること: Space+ドラッグ / 中ボタンドラッグでパン、矢印キー / WASD でパン、+/− でズーム、0 で自分の光に戻る、1〜5 でツール切替、画面隅に「＋ − ⌂」ボタン、ヘルプに PC の操作を追記
  - 場所: [client/src/input.ts](../client/src/input.ts)、[client/src/camera.ts](../client/src/camera.ts)、[client/src/ui.ts](../client/src/ui.ts)

## スケールの改善

- [ ] **帯域を減らす**: 300 人で受信が約 5MB/s（全員合計）。粗い一覧の頻度・精度の調整、差分化、間引きを検討する
- [ ] **実環境で負荷を測る**: 今の数値はローカルの workerd。Cloudflare 上の検証用 Worker（本番とは別名）で、CPU 時間と遅延を測る
- [ ] **満員時の体験**: 別の空に入ったことを画面に出す。人数の偏りを見て振り分ける
- [ ] **1 つの空を保ったままスケールする設計**: 世界をタイルに分け、タイルごとに Durable Object を持つ。視界のタイルだけに接続する。課題は、タイルをまたぐ線、接続の張り替え、境界での位置の扱い
- [ ] **観測**: 空ごとの接続数・星の数・レート制限に当たった回数を返す `/stats` を用意する

## 品質

- [ ] **CI**: GitHub Actions で `typecheck` / `test` / `build` を実行する
- [ ] **クライアントのテスト**: `Universe` / `History` を単体で試せる形にして、テストを足す
- [ ] **結合テスト**: `wrangler dev` を起動して WebSocket で一連の流れ（welcome → star → link → 再接続）を確認するテスト
- [ ] **`uid` の扱い**: 星の持ち主を示す鍵が URL（`?key=`）や通信に出る。流出時の影響を整理し、署名付きトークンにするか検討する

## 公開前の確認

- [ ] コミットのメールアドレス（`h.hayashi055@gmail.com` が全コミットに入っている）。見せたくなければ GitHub の noreply アドレスに書き換える
- [ ] `workers.dev` のサブドメイン（`taroooo0w0`）が [constants.ts](../client/src/constants.ts) に出ている
- [ ] `docs/ai-refactoring-prompt.md` と `docs/refactoring-plan.md` は作業用のメモ。クラス分割は完了しているので、計画書は古い。削除するか `docs/archive/` に移す
- [ ] README にスクリーンショット / GIF を入れる

## 検討中のアイデア

- **Rust / WASM**: 速度目的ではまだ効果が薄い（処理は通信待ちが中心）。やるなら先に計測して、`World.prune()` の密集度計算だけを WASM 化して比べる。判断材料は `npm run loadtest` と Workers の CPU 時間
- **TS のメッセージ型からドキュメントを自動生成**する

## 開発環境メモ

- `wrangler dev` や `wrangler deploy --dry-run` が、バナーの直後に何も出さず終了コード 127 で落ちることがあった。`.wrangler/cache` を消すと直った（`.wrangler/` は gitignore 済みで、再生成される）
- Vite の出力先を `../dist` のように `..` を含むパスにすると、ビルドが途中で終了コード 127 で落ちた。現在は標準の `client/dist`
- ブラウザの検証用タブの表示サイズが 0×0 だと、座標が NaN になる。サーバー側の検証（`validate.ts`）が NaN を弾くので、状態は壊れない
