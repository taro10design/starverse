import type { Universe } from "./room";

export interface Env {
  UNIVERSE: DurableObjectNamespace<Universe>;
  ASSETS: Fetcher;
  // /stats を見るためのトークン（Worker のシークレット）。未設定なら /stats は誰にも返さない
  STATS_TOKEN?: string;
}
