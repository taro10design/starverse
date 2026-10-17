// テストの設定。2 つのプロジェクトに分ける。
//
// - node:    純粋なロジックの単体テスト（server/tests/*.test.ts と client/tests）。Node で動く
// - runtime: 本物の Workers ランタイム（workerd）の上で、サーバーを WebSocket で叩く黒箱テスト
//            （server/tests/runtime）。@cloudflare/vitest-plugin が wrangler.jsonc を読んで Worker と
//            Durable Object を立ち上げる
//
// `npx vitest run` で両方、`npx vitest run --project runtime` でランタイム用だけを実行する。

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// 静的アセット（wrangler.jsonc の assets.directory = ./client/dist）はビルドしないと存在しない。
// テストではアセットを確かめないので、空の一時ディレクトリに差し替える（ビルドの有無で結果が変わらないように）
const emptyAssets = mkdtempSync(join(tmpdir(), "uchu-test-assets-"));

// /stats の確認に使うテスト専用のトークン（本物の値ではない。.dev.vars の値より優先される）。
// テストからは env.STATS_TOKEN で読む
const TEST_STATS_TOKEN = "runtime-test-stats-token";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["server/tests/*.test.ts", "client/tests/**/*.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              assets: { directory: emptyAssets, binding: "ASSETS" },
              bindings: { STATS_TOKEN: TEST_STATS_TOKEN },
            },
          }),
        ],
        test: {
          name: "runtime",
          include: ["server/tests/runtime/**/*.test.ts"],
          // 1 つの空（Durable Object）を共有するので、ファイルを並べて走らせない。
          // テストどうしの分離は、各テストのあとに全接続を閉じて reset() で Durable Object を消して行う
          fileParallelism: false,
          testTimeout: 20_000,
        },
      },
    ],
  },
});
