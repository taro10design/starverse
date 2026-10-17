// 持ち主・接続元を表す鍵を作る純粋な関数。秘密の値（uid・IP）そのものは外に出さず、ハッシュだけを使う。

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

// --- 接続元（IP） ---

type ParsedIp = { v: 4; octets: number[] } | { v: 6; groups: number[] };

function parseV4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

// IPv6 を 8 つの 16 ビットの数に展開する（`::` の省略と、末尾の IPv4 表記に対応）
function parseV6(s: string): number[] | null {
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const side = (h: string): number[] | null => {
    if (h === "") return [];
    const out: number[] = [];
    const parts = h.split(":");
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (i === parts.length - 1 && p.includes(".")) {
        const v4 = parseV4(p);
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else if (/^[0-9a-f]{1,4}$/.test(p)) {
        out.push(parseInt(p, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const head = side(halves[0]);
  const tail = halves.length === 2 ? side(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function parseIp(raw: string): ParsedIp | null {
  const s = raw.trim().toLowerCase().split("%")[0]; // ゾーン ID（fe80::1%eth0）は数える単位に関係ない
  if (!s.includes(":")) {
    const octets = parseV4(s);
    return octets ? { v: 4, octets } : null;
  }
  const groups = parseV6(s);
  if (!groups) return null;
  // IPv4-mapped IPv6（::ffff:a.b.c.d）は IPv4 として扱う
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return { v: 4, octets: [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff] };
  }
  return { v: 6, groups };
}

// 接続元を数える単位。IPv4 はアドレスそのもの、IPv6 は /64（1 回線に /64 以上が割り当てられることが多く、
// 下位 64 ビットは利用者が自由に変えられるため）。読めない値は小文字にしてそのまま使う
export function ipSubject(ip: string): string {
  const p = parseIp(ip);
  if (!p) return ip.trim().toLowerCase();
  if (p.v === 4) return p.octets.join(".");
  return `${p.groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

const IP_SECRET_BYTES = 32;

// IP の鍵に使う秘密を新しく作る（初回起動時に storage へ保存する）
export function newIpSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(IP_SECRET_BYTES));
}

// storage から読んだ値が秘密として使えるか。使えなければ null（作り直す）
export function storedIpSecret(v: unknown): Uint8Array | null {
  const bytes = v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : null;
  return bytes && bytes.byteLength === IP_SECRET_BYTES ? bytes : null;
}

// IP の鍵に使う秘密（32 バイト）を HMAC の鍵にする。秘密は Durable Object の storage に置く（room.ts）
export async function importIpSecret(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== IP_SECRET_BYTES) throw new Error(`ip secret must be 32 bytes, got ${raw.byteLength}`);
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

// 同じ接続元を数えるための鍵。生の IP は持たない。HMAC なので、秘密を知らなければ
// IPv4 の全空間（約 43 億）を総当たりしても鍵から IP を引けない。数えるだけなので 16 文字で足りる
export async function ipKey(ip: string, secret: CryptoKey): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", secret, encoder.encode(ipSubject(ip)));
  return toHex(mac).slice(0, 16);
}

// ローカル開発（wrangler dev）の接続元。本番の CF-Connecting-IP がこれになることは無い
export function isLoopback(ip: string): boolean {
  const p = parseIp(ip);
  if (!p) return false;
  if (p.v === 4) return p.octets[0] === 127;
  return p.groups.slice(0, 7).every((g) => g === 0) && p.groups[7] === 1;
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
