export interface Env {
  UNIVERSE: DurableObjectNamespace;
  ASSETS: Fetcher;
  // /stats を見るためのトークン（Worker のシークレット）。未設定なら /stats は誰にも返さない
  STATS_TOKEN?: string;
}
