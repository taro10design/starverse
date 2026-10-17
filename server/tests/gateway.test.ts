// Worker の入口の判定（server/src/gateway.ts）の単体テスト。Origin の許可・ヘッダーの除去・接続頻度の制限。

import { describe, expect, it } from "vitest";
import { allowConnectRate, isAllowedOrigin, isWebSocketUpgrade, toRoomRequest } from "../src/gateway";

const WORKER = "https://universe.example.workers.dev/ws";

describe("isAllowedOrigin", () => {
  const cases: [origin: string | null, requestUrl: string, allowed: boolean, why: string][] = [
    // 許可
    ["https://uchu.pages.dev", WORKER, true, "本番の Pages"],
    ["https://abc123.uchu.pages.dev", WORKER, true, "Pages のプレビュー"],
    ["https://fix-review.uchu.pages.dev", WORKER, true, "ブランチのプレビュー"],
    ["https://universe.example.workers.dev", WORKER, true, "自分自身の workers.dev（同じオリジン）"],
    ["http://localhost:5173", WORKER, true, "Vite の開発サーバー"],
    ["http://localhost:8787", WORKER, true, "wrangler dev"],
    ["http://localhost", WORKER, true, "localhost（ポート無し）"],
    ["http://127.0.0.1:4173", WORKER, true, "127.0.0.1"],
    ["http://uchu.test", "http://uchu.test/ws", true, "テスト環境の同じオリジン"],
    [null, WORKER, true, "Origin が無い（ブラウザ以外）"],
    ["HTTPS://UCHU.PAGES.DEV", WORKER, true, "大文字（URL として同じ）"],
    ["https://universe.EXAMPLE.workers.dev", WORKER, true, "ホストの大文字小文字は区別しない"],
    // 拒否
    ["https://evil.com", WORKER, false, "知らないサイト"],
    ["https://uchu.pages.dev.evil.com", WORKER, false, "末尾に別のドメイン"],
    ["https://eviluchu.pages.dev", WORKER, false, "区切りの無い前方一致"],
    ["https://a.b.uchu.pages.dev", WORKER, false, "2 段以上のサブドメイン"],
    ["https://.uchu.pages.dev", WORKER, false, "空のラベル"],
    ["http://uchu.pages.dev", WORKER, false, "http の Pages"],
    ["https://uchu.pages.dev:8443", WORKER, false, "Pages に別のポート"],
    ["https://localhost:5173", WORKER, false, "https の localhost（許可は http だけ）"],
    ["http://localhost.evil.com", WORKER, false, "localhost で始まる別のホスト"],
    ["http://127.0.0.2:8787", WORKER, false, "127.0.0.1 以外のループバック"],
    ["https://other.example.workers.dev", WORKER, false, "別の workers.dev"],
    ["http://universe.example.workers.dev", WORKER, false, "同じホストでも http（別のオリジン）"],
    ["null", WORKER, false, "不透明なオリジン（sandbox の iframe・file://）"],
    ["", WORKER, false, "空の Origin"],
    ["uchu.pages.dev", WORKER, false, "スキームの無いもの"],
    ["https://uchu.pages.dev/", WORKER, false, "パス付き（Origin の形でない）"],
    ["https://user@uchu.pages.dev", WORKER, false, "ユーザー情報付き"],
  ];

  it.each(cases)("%s（%s）→ %s: %s", (origin, requestUrl, allowed) => {
    expect(isAllowedOrigin(origin, requestUrl)).toBe(allowed);
  });
});

describe("isWebSocketUpgrade", () => {
  it.each([
    ["websocket", true],
    ["WebSocket", true],
    ["WEBSOCKET", true],
    ["h2c", false],
  ])("Upgrade: %s → %s", (value, expected) => {
    const req = new Request("https://x/ws", { headers: { Upgrade: value } });
    expect(isWebSocketUpgrade(req)).toBe(expected);
  });

  it("Upgrade ヘッダーが無ければ false", () => {
    expect(isWebSocketUpgrade(new Request("https://x/ws"))).toBe(false);
  });
});

describe("toRoomRequest", () => {
  it("x-partykit- で始まるヘッダーを大文字小文字を問わず全部消し、ほかは残す", () => {
    const req = new Request("https://x/ws?a=1", {
      headers: {
        Upgrade: "WebSocket",
        "X-PartyKit-Props": "!!!not-base64",
        "x-partykit-room": "space-8",
        "x-partykit-namespace": "other",
        "x-partykit-anything": "1",
        "CF-Connecting-IP": "203.0.113.9",
        "x-partykitish": "keep",
      },
    });
    const out = toRoomRequest(req);
    const names = [...out.headers.keys()];
    expect(names.filter((n) => n.startsWith("x-partykit-"))).toEqual([]);
    expect(out.headers.get("cf-connecting-ip")).toBe("203.0.113.9");
    expect(out.headers.get("x-partykitish")).toBe("keep");
    expect(out.url).toBe("https://x/ws?a=1");
  });

  it("Upgrade は小文字の websocket にそろえる（PartyServer の失敗時の分岐が完全一致で比べるため）", () => {
    const out = toRoomRequest(new Request("https://x/ws", { headers: { Upgrade: "WebSocket" } }));
    expect(out.headers.get("upgrade")).toBe("websocket");
  });

  it("元のリクエストは変えない", () => {
    const req = new Request("https://x/ws", { headers: { "x-partykit-props": "e30=" } });
    toRoomRequest(req);
    expect(req.headers.get("x-partykit-props")).toBe("e30=");
  });
});

describe("allowConnectRate", () => {
  // 偽の limit。呼ばれた key を覚え、決めた結果を返す
  function fakeLimiter(success: boolean) {
    const keys: string[] = [];
    return {
      keys,
      limiter: {
        limit: ({ key }: { key: string }) => {
          keys.push(key);
          return Promise.resolve({ success });
        },
      },
    };
  }

  it("制限内なら通し、接続元の IP をキーにする", async () => {
    const f = fakeLimiter(true);
    expect(await allowConnectRate(f.limiter, "203.0.113.5")).toBe(true);
    expect(f.keys).toEqual(["ws:203.0.113.5"]);
  });

  it("超えたら通さない", async () => {
    const f = fakeLimiter(false);
    expect(await allowConnectRate(f.limiter, "203.0.113.5")).toBe(false);
  });

  it("IP が分からなければ制限しない（limit を呼ばない）", async () => {
    const f = fakeLimiter(false);
    expect(await allowConnectRate(f.limiter, null)).toBe(true);
    expect(await allowConnectRate(f.limiter, "")).toBe(true);
    expect(f.keys).toEqual([]);
  });

  it("接続元が loopback（ローカルの wrangler dev）なら制限しない。本番では loopback にならない", async () => {
    const f = fakeLimiter(false);
    for (const ip of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) {
      expect(await allowConnectRate(f.limiter, ip)).toBe(true);
    }
    expect(f.keys).toEqual([]);
    // 紛らわしいが loopback ではないもの
    expect(await allowConnectRate(f.limiter, "128.0.0.1")).toBe(false);
    expect(await allowConnectRate(f.limiter, "::2")).toBe(false);
  });

  it("バインディングが無ければ（テスト・ローカル）制限しない", async () => {
    expect(await allowConnectRate(undefined, "203.0.113.5")).toBe(true);
  });
});
