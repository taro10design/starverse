// クライアントとサーバーが共有する WebSocket プロトコルの型。
// 短い名前は通信量を抑えるため（p = position, c = color index, v = view, ps = presences）。
//
// メッセージを足すとき: ここに型を足す → サーバーは src/server/handlers.ts、
// クライアントは src/client/message-handlers.ts に処理を書く（足さないと型エラーになる）。
// 詳しくは docs/extending.md。

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

// 視界（ワールド座標）[x0, y0, x1, y1]。サーバーは視界の近くの人だけに位置を送る
export type View = [x0: number, y0: number, x1: number, y1: number];

// 他の人の位置のタプル [id, x, y, color]（JSON を小さくするためオブジェクトにしない）
export type PresenceTuple = [id: string, x: number, y: number, c: number];

// クライアント → サーバー
export type ClientMessage =
  | { t: "p"; x: number; y: number; c: number; v?: View }
  | { t: "pulse"; x: number; y: number; c?: number }
  | { t: "star"; id: string; x: number; y: number; uid?: string }
  | { t: "unstar"; id: string; uid?: string }
  | { t: "admire"; id: string }
  | { t: "link"; id: string; a: string; b: string; uid?: string }
  | { t: "unlink"; id: string; uid?: string };

// サーバー → クライアント
export type ServerMessage =
  | { t: "welcome"; id: string; sendMs: number; dots: PeerDot[]; stars: StarData[]; links: LinkData[] }
  // 空の人数が変わったときの、位置を送る間隔の指示（人が増えるほど間隔を広げる）
  | { t: "rate"; sendMs: number }
  | { t: "ps"; d: PresenceTuple[] }
  | { t: "pulse"; x: number; y: number; c: number }
  | ({ t: "star" } & StarData)
  | { t: "unstar"; id: string }
  | { t: "admire"; id: string; ts: number }
  | ({ t: "link" } & LinkData)
  | { t: "unlink"; id: string }
  | { t: "leave"; id: string };

export type ClientMessageType = ClientMessage["t"];
export type ServerMessageType = ServerMessage["t"];
