// ランタイム用テストが使うバインディングの型（cloudflare:workers の env）。
// 実装（server/src）の型には依存しない。wrangler.jsonc と vitest.config.ts のバインディングだけを書く。
// Cloudflare.Env は全体で 1 つにまとめられる（server/src の Env と合流する）ので、実装の型と矛盾しないよう
// 最小限の形にする（STATS_TOKEN は本番で未設定のことがあるので省略可能）。

/// <reference types="@cloudflare/vitest-plugin/types" />

declare namespace Cloudflare {
  interface Env {
    UNIVERSE: DurableObjectNamespace;
    STATS_TOKEN?: string;
  }
}
