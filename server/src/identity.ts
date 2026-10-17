// 持ち主・接続元を表す鍵を作る純粋な関数。秘密の値（uid・IP）そのものは外に出さず、ハッシュだけを使う。

const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// 持ち主 ID（StarData.by / LinkData.by）。uid の SHA-256 の先頭 32 文字（128 ビット）。
// 配信される値から uid は逆算できないので、他人の星の by を見ても持ち主になりすませない
export async function ownerFromUid(uid: string): Promise<string> {
  return (await sha256Hex(uid)).slice(0, 32);
}

// 同じ接続元からの接続数を数えるための鍵。生の IP は持たない（数えるだけなので 16 文字で足りる）
export async function ipKey(ip: string): Promise<string> {
  return (await sha256Hex(ip)).slice(0, 16);
}

// ローカル開発（wrangler dev）の接続元。本番の CF-Connecting-IP がこれになることは無い
export function isLoopback(ip: string): boolean {
  return ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.");
}

// 定数時間の文字列比較。秘密のトークンを、一致した長さから推測されないようにする
export function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
