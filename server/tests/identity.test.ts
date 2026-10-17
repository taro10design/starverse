import { describe, expect, it } from "vitest";
import {
  importIpSecret,
  ipKey,
  ipSubject,
  isLoopback,
  newIpSecret,
  ownerFromUid,
  safeEqual,
  storedIpSecret,
} from "../src/identity";

const UID_A = "abcdef12-3456-7890-abcd-ef1234567890";
const UID_B = "abcdef12-3456-7890-abcd-ef1234567891";

describe("ownerFromUid（uid → 持ち主 ID）", () => {
  it("同じ uid からは同じ持ち主 ID になる", async () => {
    expect(await ownerFromUid(UID_A)).toBe(await ownerFromUid(UID_A));
  });

  it("別の uid からは別の持ち主 ID になる", async () => {
    expect(await ownerFromUid(UID_A)).not.toBe(await ownerFromUid(UID_B));
  });

  it("32 文字の 16 進数で、uid そのものを含まない", async () => {
    const owner = await ownerFromUid(UID_A);
    expect(owner).toMatch(/^[0-9a-f]{32}$/);
    expect(owner).not.toContain(UID_A);
    expect(owner).not.toContain(UID_A.slice(0, 8));
  });

  it("SHA-256 の先頭 32 文字と一致する", async () => {
    // echo -n "abcdefgh" | sha256sum
    expect(await ownerFromUid("abcdefgh")).toBe("9c56cc51b374c3ba189210d5b6d4bf57");
  });
});

describe("ipSubject（数える単位への正規化）", () => {
  it("IPv4 はそのまま", () => {
    expect(ipSubject("203.0.113.7")).toBe("203.0.113.7");
  });

  it("IPv6 は /64（先頭 4 ブロック）にまとめる", () => {
    expect(ipSubject("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(ipSubject("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(ipSubject("2001:db8:1:2:ffff::")).toBe("2001:db8:1:2::/64");
  });

  it("`::` の展開・先頭の 0・大文字小文字の違いを吸収する", () => {
    expect(ipSubject("2001:DB8::1")).toBe("2001:db8:0:0::/64");
    expect(ipSubject("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8:0:0::/64");
    expect(ipSubject("2001:db8:0:0:1::")).toBe("2001:db8:0:0::/64");
  });

  it("IPv4-mapped IPv6 は IPv4 として扱う", () => {
    expect(ipSubject("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipSubject("::FFFF:cb00:7107")).toBe("203.0.113.7");
    expect(ipSubject("0:0:0:0:0:ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("形式の崩れた値は、小文字にしてそのまま使う（数えるための鍵なので落とさない）", () => {
    expect(ipSubject("not-an-ip")).toBe("not-an-ip");
    expect(ipSubject("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9");
    expect(ipSubject("1::2::3")).toBe("1::2::3");
    expect(ipSubject("300.1.1.1")).toBe("300.1.1.1");
  });
});

describe("ipKey（IP → 数える用の鍵。HMAC-SHA256）", () => {
  const secret = () => importIpSecret(new Uint8Array(32).fill(1));

  it("16 文字の 16 進数で、IP そのものを含まない", async () => {
    const k = await ipKey("203.0.113.7", await secret());
    expect(k).toMatch(/^[0-9a-f]{16}$/);
    expect(k).not.toContain("203.0.113.7");
  });

  it("正規化した値の HMAC-SHA256 の先頭 16 文字と一致する", async () => {
    // node -e "crypto.createHmac('sha256', Buffer.alloc(32, 1)).update(s).digest('hex').slice(0, 16)"
    expect(await ipKey("203.0.113.7", await secret())).toBe("8dcbe13a1d06d9b7");
    expect(await ipKey("::ffff:203.0.113.7", await secret())).toBe("8dcbe13a1d06d9b7");
    expect(await ipKey("2001:db8:1:2::99", await secret())).toBe("8eb04cbbd556f5ea");
  });

  it("同じ IP は同じ鍵、別の IP は別の鍵", async () => {
    const k = await secret();
    expect(await ipKey("203.0.113.7", k)).toBe(await ipKey("203.0.113.7", k));
    expect(await ipKey("203.0.113.7", k)).not.toBe(await ipKey("203.0.113.8", k));
  });

  it("同じ /64 の IPv6 は同じ鍵、別の /64 は別の鍵", async () => {
    const k = await secret();
    expect(await ipKey("2001:db8:1:2::1", k)).toBe(await ipKey("2001:db8:1:2:dead:beef::7", k));
    expect(await ipKey("2001:db8:1:2::1", k)).not.toBe(await ipKey("2001:db8:1:3::1", k));
  });

  it("秘密の鍵が違えば、同じ IP でも別の鍵になる（ソルトなしの辞書引きができない）", async () => {
    const other = await importIpSecret(new Uint8Array(32).fill(2));
    expect(await ipKey("203.0.113.7", await secret())).not.toBe(await ipKey("203.0.113.7", other));
  });

  it("秘密の鍵は 32 バイトでなければ受け付けない", async () => {
    await expect(importIpSecret(new Uint8Array(16))).rejects.toThrow();
  });
});

describe("storedIpSecret（storage から読んだ秘密の検証）", () => {
  it("32 バイトの Uint8Array・ArrayBuffer はそのまま使う", () => {
    const raw = new Uint8Array(32).fill(7);
    expect(storedIpSecret(raw)).toEqual(raw);
    expect(storedIpSecret(raw.buffer)).toEqual(raw);
  });

  it("無い・形が違うときは null（呼び出し側が作り直して保存する）", () => {
    expect(storedIpSecret(undefined)).toBeNull();
    expect(storedIpSecret(new Uint8Array(31))).toBeNull();
    expect(storedIpSecret("secret")).toBeNull();
    expect(storedIpSecret([1, 2, 3])).toBeNull();
  });

  it("newIpSecret は毎回違う 32 バイト", () => {
    const a = newIpSecret();
    expect(a.byteLength).toBe(32);
    expect(a).not.toEqual(newIpSecret());
  });
});

describe("isLoopback", () => {
  it("ローカル開発の接続元だけを true にする", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("::ffff:7f00:1")).toBe(true);
    expect(isLoopback("203.0.113.7")).toBe(false);
    expect(isLoopback("2001:db8::1")).toBe(false);
    expect(isLoopback("::2")).toBe(false);
    expect(isLoopback("127.example")).toBe(false);
  });
});

describe("safeEqual（定数時間の比較）", () => {
  it("同じ文字列だけ true", () => {
    expect(safeEqual("dev-stats-token", "dev-stats-token")).toBe(true);
    expect(safeEqual("dev-stats-token", "dev-stats-tokeN")).toBe(false);
  });

  it("長さが違えば false", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "a")).toBe(false);
  });

  it("空同士は true（呼び出し側で未設定を弾く）", () => {
    expect(safeEqual("", "")).toBe(true);
  });

  it("多バイト文字も比べられる", () => {
    expect(safeEqual("うちゅう", "うちゅう")).toBe(true);
    expect(safeEqual("うちゅう", "うちゅー")).toBe(false);
  });
});
