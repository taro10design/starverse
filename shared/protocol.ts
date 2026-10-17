// クライアントとサーバーが共有する WebSocket プロトコルの型。
// 短い名前は通信量を抑えるため（p = position, c = color index, v = view, ps = presences）。
//
// メッセージを足すとき: ここに型を足す → サーバーは server/src/handlers.ts、
// クライアントは client/src/message-handlers.ts に処理を書く（足さないと型エラーになる）。
// 詳しくは docs/extending.md。

// サーバーは保存するときに born / origin / v を足すが、配信（welcome・star）には含めない（server/src/world.ts の StoredStar）
export interface StarData {
  id: string;
  x: number;
  y: number;
  c: number;
  by: string; // 持ち主 ID（uid の SHA-256。uid そのものではない）
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
//
// 持ち主の鍵 uid は秘密。接続の最初に `hello` で 1 回だけ送り、サーバーは SHA-256 で
// 持ち主 ID（StarData.by / LinkData.by）に変えて保存・配信する。uid そのものは保存も配信もしない。
// hello の前に送られた他のメッセージは無視され、違反として通算で数える（減らない。2 回目以降の hello も同じ）。
// 通算 20 回目で 1008 で切断される。形式に合わない uid の hello は即 1008。
// hello の処理中（ハッシュ計算の間）に届いたものは、welcome のあとに処理される。
export type ClientMessage =
  | { t: "hello"; uid: string }
  | { t: "p"; x: number; y: number; c: number; v?: View }
  | { t: "pulse"; x: number; y: number }
  | { t: "star"; id: string; x: number; y: number; c: number }
  | { t: "unstar"; id: string }
  // 同じ接続から同じ星へは 5 秒に 1 回。さらに星ごとに、星の ts（作成・前回のきらめき）から 60 秒は
  // 誰のきらめきも効かない。作成から 24 時間を過ぎた星も延びない（どれも黙って捨てられる）
  | { t: "admire"; id: string }
  | { t: "link"; id: string; a: string; b: string }
  | { t: "unlink"; id: string };

// サーバー → クライアント
export type ServerMessage =
  // hello への返事。me は自分の持ち主 ID（星の by と比べて「自分の星か」を判定する）
  | { t: "welcome"; id: string; me: string; sendMs: number; dots: PeerDot[]; stars: StarData[]; links: LinkData[] }
  // 空の人数が変わったときの、位置を送る間隔の指示（人が増えるほど間隔を広げる）
  | { t: "rate"; sendMs: number }
  // 上限超過（1 人 / 同じ接続元 / 全体）・他人の星の上書き・レート制限などで断った操作。
  // hello の処理中にあふれたものは welcome の直後に届く。クライアントは自分の画面の星 / 線を取り消す
  | { t: "reject"; kind: "star" | "link"; id: string }
  | { t: "ps"; d: PresenceTuple[] }
  | { t: "pulse"; x: number; y: number; c: number }
  | ({ t: "star" } & StarData)
  | { t: "unstar"; id: string }
  | { t: "admire"; id: string; ts: number } // 視界に関係なく全員に届く（どの手元でも星の寿命をそろえる）
  | ({ t: "link" } & LinkData)
  | { t: "unlink"; id: string }
  | { t: "leave"; id: string };

export type ClientMessageType = ClientMessage["t"];
export type ServerMessageType = ServerMessage["t"];
