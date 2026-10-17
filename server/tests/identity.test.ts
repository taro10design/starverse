import { describe, expect, it } from "vitest";
import { ownerFromUid, safeEqual } from "../src/identity";

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
