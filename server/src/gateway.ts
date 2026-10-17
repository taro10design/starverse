// Worker の入口（index.ts）で使う判定。副作用を持たない関数にして、単体テストできるようにする。

import { ALLOWED_ORIGINS, CONNECT_LIMIT_KEY_PREFIX } from "./config";

// Upgrade ヘッダーは大文字小文字を区別しない（RFC 9110。`WebSocket` と送る実装もある）
export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

// Origin を許可するか。null（ヘッダーが無い = ブラウザ以外）は許可する。
// Origin は「スキーム://ホスト[:ポート]」だけの形のはずなので、URL として読み直した origin と一致しないもの
// （パス・ユーザー情報付き、"null"、スキーム無し）は拒否する
export function isAllowedOrigin(origin: string | null, requestUrl: string): boolean {
  if (origin === null) return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false; // URL として読めない Origin（"null" など）は許可しない
  }
  if (u.origin.toLowerCase() !== origin.toLowerCase()) return false;
  // 自分自身（同じオリジン）
  if (u.origin === new URL(requestUrl).origin) return true;
  return ALLOWED_ORIGINS.some((p) => {
    if (u.protocol !== p.protocol) return false;
    if (!p.anyPort && u.port !== "") return false;
    if (!p.subdomain) return u.hostname === p.host;
    const suffix = "." + p.host;
    if (!u.hostname.endsWith(suffix)) return false;
    const label = u.hostname.slice(0, -suffix.length);
    return /^[a-z0-9-]+$/.test(label);
  });
}

// 空（Durable Object）に転送するリクエスト。クライアントが付けた x-partykit-* ヘッダーは PartyServer の内部用
// （props の base64 デコードの失敗でスタックトレースが返る、部屋の名前の上書き）なので、全部消す。
// Upgrade は小文字にそろえる（PartyServer の失敗時の分岐が "websocket" と完全一致で比べるため）
export function toRoomRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (name.startsWith("x-partykit-")) headers.delete(name);
  }
  if (headers.has("Upgrade")) headers.set("Upgrade", "websocket");
  return new Request(request, { headers });
}

// Workers の Rate Limiting バインディングの、ここで使う部分だけ（@cloudflare/workers-types の RateLimit と同じ形）
export interface ConnectLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

// 接続元（IP）ごとの接続の頻度。超えたら false。
// バインディングが無い（テスト・ローカルで外した）とき、IP が分からないときは制限しない。
// 公式資料のとおり、場所（データセンター）ごとの近似で、正確な計数ではない
// ローカルの wrangler dev では接続元が loopback になる。E2E や負荷テストで 1 台から多数つなぐので、制限しない
// （本番の Cloudflare では、接続元が loopback になることはない）
function isLoopback(ip: string): boolean {
  return ip.startsWith("127.") || ip === "::1" || ip.startsWith("::ffff:127.");
}

export async function allowConnectRate(limiter: ConnectLimiter | undefined, ip: string | null): Promise<boolean> {
  if (limiter === undefined || !ip || isLoopback(ip)) return true;
  const { success } = await limiter.limit({ key: CONNECT_LIMIT_KEY_PREFIX + ip });
  return success;
}
