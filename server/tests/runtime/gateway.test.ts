// Worker の入口（server/src/index.ts）の黒箱テスト。本物の Workers ランタイム上で /ws と /stats を叩く。
// Origin の許可リスト・Upgrade の大文字小文字・x-partykit-* ヘッダーの除去・接続頻度の制限・/stats。
// 道具はこのファイルの中だけに置く（helpers.ts に依存しない）。

import { SELF, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

const BASE = "http://uchu.test";

// テストごとに別の接続元（IP）。頻度の制限が他のテストに漏れないよう、helpers.ts（203.0.113.x）とも分ける
let ipCounter = 1;
const nextIp = () => `198.51.100.${ipCounter++}`;

const opened: WebSocket[] = [];

afterEach(async () => {
  for (const ws of opened.splice(0)) ws.close(1000, "test done");
  await reset();
});

function upgrade(headers: Record<string, string>): Promise<Response> {
  return SELF.fetch(`${BASE}/ws`, { headers: { Upgrade: "websocket", "CF-Connecting-IP": nextIp(), ...headers } });
}

// 101 で開いた WebSocket に hello を送り、最初に届いたフレーム（文字列）を返す
async function helloAndFirstFrame(res: Response): Promise<string> {
  const ws = res.webSocket;
  if (res.status !== 101 || ws === null) throw new Error(`Upgrade に失敗した: ${res.status} ${await res.text()}`);
  ws.accept();
  opened.push(ws);
  const first = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("3 秒以内にフレームが届かなかった")), 3000);
    ws.addEventListener("message", (e) => {
      clearTimeout(timer);
      resolve(typeof e.data === "string" ? e.data : "<binary>");
    });
  });
  ws.send(JSON.stringify({ t: "hello", uid: crypto.randomUUID() }));
  return first;
}

const isWelcome = (frame: string) => (JSON.parse(frame) as { t?: unknown }).t === "welcome";

describe("Origin の許可リスト", () => {
  it.each(["https://evil.example", "https://uchu.pages.dev.evil.com", "null"])("%s からは 403", async (origin) => {
    const res = await upgrade({ Origin: origin });
    expect(res.status).toBe(403);
    expect(res.webSocket).toBeNull();
  });

  it.each(["https://uchu.pages.dev", "https://abc123.uchu.pages.dev", "http://localhost:5173", BASE])(
    "%s からは接続でき、welcome が届く",
    async (origin) => {
      const frame = await helloAndFirstFrame(await upgrade({ Origin: origin }));
      expect(isWelcome(frame)).toBe(true);
    },
  );

  it("Origin が無い接続（ブラウザ以外）は通す", async () => {
    expect(isWelcome(await helloAndFirstFrame(await upgrade({})))).toBe(true);
  });
});

describe("Upgrade ヘッダー", () => {
  it("Upgrade: WebSocket（大文字まじり）でも接続できる", async () => {
    const frame = await helloAndFirstFrame(await upgrade({ Upgrade: "WebSocket" }));
    expect(isWelcome(frame)).toBe(true);
  });
});

describe("x-partykit-* ヘッダー", () => {
  it("壊れた x-partykit-props を付けても、500 もスタックトレースも返らず、普通に接続できる", async () => {
    const res = await upgrade({ "x-partykit-props": "%%%not-base64%%%", "x-partykit-room": "evil-room" });
    expect(res.status).toBe(101);
    const frame = await helloAndFirstFrame(res);
    expect(frame).not.toContain("error");
    expect(frame).not.toMatch(/\bat\s/);
    expect(isWelcome(frame)).toBe(true);
  });

  it("Upgrade: WebSocket と壊れた props の組み合わせでもスタックトレースを返さない", async () => {
    const res = await upgrade({ Upgrade: "WebSocket", "x-partykit-props": "{broken json" });
    expect(res.status).toBe(101);
    expect(isWelcome(await helloAndFirstFrame(res))).toBe(true);
  });
});

describe("接続頻度の制限（CONNECT_LIMITER）", () => {
  it("同じ IP から連続で接続すると 429 になり、別の IP は影響を受けない", async () => {
    const ip = "198.51.100.250";
    // 不許可の Origin（403）で数える。Durable Object に届かないので接続の後片付けが要らない。
    // 制限の窓の境目をまたいでも 1 つの窓で上限（60 秒に 20 回）を超えるよう、上限の 2 倍 + 1 回送る
    const statuses: number[] = [];
    for (let i = 0; i < 41; i++) {
      const res = await SELF.fetch(`${BASE}/ws`, {
        headers: { Upgrade: "websocket", "CF-Connecting-IP": ip, Origin: "https://evil.example" },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 1)).toEqual([403]);
    expect(statuses).toContain(429);
    expect(statuses.every((s) => s === 403 || s === 429)).toBe(true);
    // 別の IP からは通る
    expect(isWelcome(await helloAndFirstFrame(await upgrade({})))).toBe(true);
  });
});

describe("/stats", () => {
  it("トークンが合えば、全部の空の数を返す（getByName でも空に届く）", async () => {
    const token = env.STATS_TOKEN;
    if (token === undefined) throw new Error("vitest.config.ts で STATS_TOKEN を渡しているはず");
    const res = await SELF.fetch(`${BASE}/stats`, { headers: { "x-stats-token": token } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalConnections: number; rooms: { room: string }[] };
    expect(typeof body.totalConnections).toBe("number");
    expect(body.rooms[0]?.room).toBe("space");
    expect(body.rooms.length).toBeGreaterThan(1);
  });

  it("トークンが無ければ 404", async () => {
    expect((await SELF.fetch(`${BASE}/stats`)).status).toBe(404);
  });
});
