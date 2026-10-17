import type { Universe } from "./room";

export interface Env {
  UNIVERSE: DurableObjectNamespace<Universe>;
  ASSETS: Fetcher;
  // /stats を見るためのトークン（Worker のシークレット）。未設定なら /stats は誰にも返さない
  STATS_TOKEN?: string;
  // 接続元（IP）ごとの /ws の接続頻度（wrangler.jsonc の ratelimits）。無ければ制限しない（gateway.ts の allowConnectRate）
  CONNECT_LIMITER?: RateLimit;
}
