// クライアントとサーバーが共有する WebSocket プロトコルの型。
// 短い名前は通信量を抑えるため（p = position, c = color index）。

export interface StarData {
  id: string;
  x: number;
  y: number;
  c: number;
  by: string;
  ts: number;
}

// 誰かが意図して引いた線。星 a と星 b を結ぶ
export interface LinkData {
  id: string;
  a: string;
  b: string;
  by: string;
  ts: number;
}

export interface PeerDot {
  id: string;
  x: number;
  y: number;
  c: number;
}

// クライアント → サーバー
export type ClientMessage =
  | { t: "p"; x: number; y: number; c: number }
  | { t: "pulse"; x: number; y: number; c?: number }
  | { t: "star"; id: string; x: number; y: number; uid?: string }
  | { t: "unstar"; id: string; uid?: string }
  | { t: "admire"; id: string }
  | { t: "link"; id: string; a: string; b: string; uid?: string }
  | { t: "unlink"; id: string; uid?: string };

// サーバー → クライアント
export type ServerMessage =
  | { t: "welcome"; id: string; dots: PeerDot[]; stars: StarData[]; links: LinkData[] }
  | { t: "p"; id: string; x: number; y: number; c: number }
  | { t: "pulse"; x: number; y: number; c: number }
  | ({ t: "star" } & StarData)
  | { t: "unstar"; id: string }
  | { t: "admire"; id: string; ts: number }
  | ({ t: "link" } & LinkData)
  | { t: "unlink"; id: string }
  | { t: "leave"; id: string };
