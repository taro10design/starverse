// 持ち主を表す鍵を作る純粋な関数と、秘密の比較。秘密の値（uid）そのものは外に出さず、ハッシュだけを使う。
// 接続元（IP）は扱わない（同じ接続元ごとの制限は Cloudflare のエッジで行う。ADR 0009）。

const encoder = new TextEncoder();

const toHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

// 持ち主 ID（StarData.by / LinkData.by）。uid の SHA-256 の先頭 32 文字（128 ビット）。
// 配信される値から uid は逆算できないので、他人の星の by を見ても持ち主になりすませない
export async function ownerFromUid(uid: string): Promise<string> {
  return (await sha256Hex(uid)).slice(0, 32);
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
