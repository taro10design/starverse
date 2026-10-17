import { describe, expect, it } from "vitest";
import { randomUUID } from "../src/util";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomUUID", () => {
  it("crypto.randomUUID があればそれを使う", () => {
    const src = { getRandomValues: (a: Uint8Array<ArrayBuffer>) => a, randomUUID: () => "from-native" };
    expect(randomUUID(src)).toBe("from-native");
  });

  it("crypto.randomUUID が無い環境（http の LAN 開発）でも、getRandomValues で UUID v4 を作る", () => {
    let n = 0;
    const src = {
      getRandomValues: (a: Uint8Array<ArrayBuffer>) => {
        for (let i = 0; i < a.length; i++) a[i] = (n++ * 37 + 255) & 0xff;
        return a;
      },
    };
    const a = randomUUID(src);
    const b = randomUUID(src);
    expect(a).toMatch(UUID_V4);
    expect(b).toMatch(UUID_V4);
    expect(a).not.toBe(b);
    // 全部 0xff でも version と variant のビットは正しい
    expect(randomUUID({ getRandomValues: (x: Uint8Array<ArrayBuffer>) => x.fill(0xff) })).toBe(
      "ffffffff-ffff-4fff-bfff-ffffffffffff",
    );
  });

  it("既定では本物の crypto を使う", () => {
    expect(randomUUID()).toMatch(UUID_V4);
  });
});
