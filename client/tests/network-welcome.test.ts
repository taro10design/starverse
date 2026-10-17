import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Network as NetworkClass } from "../src/network";

// welcome の締め切り・1008 の待ち・隠れたタブ・一括操作の小分けのテスト。
// network.test.ts と同じく、偽の WebSocket を PartySocket に差し込み、偽のタイマーで時間を進める

const store = new Map<string, string>();
vi.stubGlobal("location", { search: "", hostname: "localhost", host: "localhost", port: "", protocol: "https:" });
vi.stubGlobal("window", { devicePixelRatio: 1 });
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});
vi.stubGlobal("performance", { now: () => 1234 });

const doc = {
  hidden: false,
  listeners: [] as (() => void)[],
  addEventListener(_type: string, fn: () => void) {
    this.listeners.push(fn);
  },
  setHidden(h: boolean) {
    this.hidden = h;
    for (const fn of this.listeners) fn();
  },
};
vi.stubGlobal("document", doc);

class FakeWebSocket extends EventTarget {
  static all: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  bufferedAmount = 0;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {
    super();
    FakeWebSocket.all.push(this);
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error("開いていない接続に送った");
    this.sent.push(data);
    if (data === "ping") this.receive("pong");
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  drop(code = 1006) {
    this.closed = true;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason: "" }));
  }
  receive(msg: unknown) {
    const data = typeof msg === "string" ? msg : JSON.stringify(msg);
    this.dispatchEvent(Object.assign(new Event("message"), { data }));
  }
  messages(): { t: string; id?: string }[] {
    return this.sent.filter((s) => s !== "ping").map((s) => JSON.parse(s) as { t: string; id?: string });
  }
}

let mod: {
  Network: typeof NetworkClass;
  Camera: typeof import("../src/camera").Camera;
  Player: typeof import("../src/player").Player;
  Universe: typeof import("../src/universe").Universe;
  OP_CHUNK: number;
  OP_WINDOW_MS: number;
};

beforeAll(async () => {
  const network = await import("../src/network");
  const pacer = await import("../src/op-pacer");
  mod = {
    Network: network.Network,
    Camera: (await import("../src/camera")).Camera,
    Player: (await import("../src/player")).Player,
    Universe: (await import("../src/universe")).Universe,
    OP_CHUNK: pacer.OP_CHUNK,
    OP_WINDOW_MS: pacer.OP_WINDOW_MS,
  };
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.spyOn(Math, "random").mockReturnValue(0);
  FakeWebSocket.all = [];
  doc.listeners = [];
  doc.hidden = false;
  store.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const WELCOME = { t: "welcome", id: "c1", me: "owner-hash", sendMs: 100, dots: [], stars: [], links: [] };
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const count = () => FakeWebSocket.all.length;
const alive = () => FakeWebSocket.all.filter((w) => !w.closed);

async function setup() {
  const camera = new mod.Camera();
  camera.resize(1000, 700);
  const player = new mod.Player();
  const universe = new mod.Universe(false, (m) => net.send(m));
  const net = new mod.Network({ universe, player, camera }, FakeWebSocket as unknown as typeof WebSocket);
  net.connect();
  await wait(0);
  const last = () => {
    const ws = FakeWebSocket.all.at(-1);
    if (!ws) throw new Error("接続が無い");
    return ws;
  };
  const joined = () => {
    const ws = last();
    ws.open();
    ws.receive(WELCOME);
    return ws;
  };
  return { net, universe, last, joined };
}

// 条件がそろうまで、偽の時間を 1ms ずつ進める（そろっていれば進めない）。maxMs 進めてもそろわなければ失敗。
// PartySocket が内部でどう予約するか（待ち 0 のタイマーが偽のタイマーでは何 ms になるか など）に依存しないため
async function until(cond: () => boolean, what: string, maxMs = 50) {
  for (let t = 0; ; t++) {
    await wait(0);
    if (cond()) return;
    if (t >= maxMs) throw new Error(`${what} が ${maxMs}ms（偽の時間）以内にそろわなかった`);
    await wait(1);
  }
}

// ms 待つまでは接続が増えず、ms を過ぎたらすぐ（PartySocket の内部の予約の分だけ遅れて）1 本増える
async function expectReconnectAfter(ms: number) {
  const n = count();
  await wait(ms - 1);
  expect(count()).toBe(n);
  await wait(1);
  await until(() => count() === n + 1, `${ms}ms 後の再接続`);
}

describe("welcome の締め切り", () => {
  it("締め切りでは閉じるだけで、すぐにはつなぎ直さない（伸びる待ち 1.5 秒 → 2.4 秒 → 3.84 秒）", async () => {
    const { last } = await setup();
    for (const ms of [1500, 2400, 3840]) {
      const ws = last();
      ws.open(); // つながったが welcome が来ない
      await wait(10_000);
      expect(ws.closed).toBe(true);
      expect(alive()).toHaveLength(0);
      await expectReconnectAfter(ms);
      expect(alive()).toHaveLength(1);
    }
  });

  it("待ちは 15 秒で頭打ち", async () => {
    const { last } = await setup();
    for (let i = 0; i < 8; i++) {
      last().open();
      await wait(10_000);
      await wait(15_002);
    }
    last().open();
    await wait(10_000);
    await expectReconnectAfter(15_000);
  });

  it("待ちにもばらつきがある（× 1〜1.5）", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const { last } = await setup();
    last().open();
    await wait(10_000);
    await expectReconnectAfter(Math.ceil(1500 * 1.495));
  });

  it("welcome を受け取ったら、締め切りの待ちは初期値に戻る", async () => {
    const { last, joined } = await setup();
    last().open();
    await wait(10_000);
    await expectReconnectAfter(1500);
    last().open();
    await wait(10_000);
    await expectReconnectAfter(2400);
    joined().drop(); // welcome を受け取ってから切れた（PartySocket の待ち 1.5 秒）
    await wait(1500);
    expect(count()).toBe(4);
    last().open();
    await wait(10_000);
    await expectReconnectAfter(1500); // 3.84 秒ではない
  });

  it("締め切りの待ちの途中で隠れて切断しても、戻ったときは残りだけ待つ", async () => {
    const { last } = await setup();
    last().open();
    await wait(10_000); // 1.5 秒の待ちに入る
    doc.setHidden(true);
    await wait(1000);
    doc.setHidden(false); // 隠れて 30 秒たっていないので、待ちはそのまま
    await expectReconnectAfter(500);
  });
});

describe("1008 の待ちと隠れたタブ", () => {
  it("1008 の待ちの途中で隠れて切断 → 表示に戻ったら、すぐにはつながず残りだけ待つ", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99); // 待ちは 30 秒 × 1.495 = 44.85 秒
    const { joined } = await setup();
    joined().drop(1008);
    doc.setHidden(true);
    await wait(30_000); // 隠れて 30 秒で切断（待ちのタイマーは止まる）
    await wait(5_000);
    expect(count()).toBe(1);
    doc.setHidden(false); // 1008 から 35 秒。残りは 9.85 秒
    await expectReconnectAfter(9_850);
    expect(alive()).toHaveLength(1);
  });

  it("1008 の待ちが隠れている間に明けていたら、戻ったときにすぐつなぐ", async () => {
    const { joined } = await setup();
    joined().drop(1008);
    doc.setHidden(true);
    await wait(10 * 60_000);
    expect(count()).toBe(1);
    doc.setHidden(false);
    await until(() => count() === 2, "表示に戻ったあとの接続");
  });
});

describe("一括操作の小分け", () => {
  it("星の操作は 1 窓に OP_CHUNK 件ずつ送る。位置はそのまま送る", async () => {
    const { net, universe, joined } = await setup();
    const ws = joined();
    const stars = () => ws.messages().filter((m) => m.t === "star").length;
    for (let i = 0; i < 64; i++) universe.placeStar(i / 100, 0, 0);
    expect(universe.stars.size).toBe(64); // 画面にはすぐ出る
    expect(stars()).toBe(mod.OP_CHUNK);
    const ps = ws.messages().filter((m) => m.t === "p").length;
    net.sendPosition();
    expect(ws.messages().filter((m) => m.t === "p").length).toBe(ps + 1);
    await wait(mod.OP_WINDOW_MS);
    expect(stars()).toBe(mod.OP_CHUNK * 2);
    await wait(mod.OP_WINDOW_MS * 3);
    expect(stars()).toBe(64);
  });

  it("全部消す（unstar の束）も小分けにし、置いた星の star を追い越さない", async () => {
    const { universe, joined } = await setup();
    const ws = joined();
    const placed = [];
    for (let i = 0; i < 30; i++) placed.push(universe.placeStar(i / 100, 0, 0));
    for (const s of placed) if (s) universe.deleteStar(s);
    await wait(mod.OP_WINDOW_MS * 5);
    const ops = ws.messages().filter((m) => m.t === "star" || m.t === "unstar");
    expect(ops).toHaveLength(60);
    const firstUnstar = ops.findIndex((m) => m.t === "unstar");
    expect(ops.slice(0, firstUnstar).every((m) => m.t === "star")).toBe(true);
    expect(firstUnstar).toBe(30);
  });

  it("小分けの途中で切断したら、残りは送らない（再接続のあとにも送らない）", async () => {
    const { universe, joined } = await setup();
    const ws1 = joined();
    for (let i = 0; i < 64; i++) universe.placeStar(i / 100, 0, 0);
    await wait(mod.OP_WINDOW_MS);
    const sent = ws1.messages().filter((m) => m.t === "star").length;
    expect(sent).toBe(mod.OP_CHUNK * 2);
    ws1.drop();
    await wait(1500);
    const ws2 = joined();
    await wait(mod.OP_WINDOW_MS * 5);
    expect(ws1.messages().filter((m) => m.t === "star").length).toBe(sent);
    expect(ws2.messages().filter((m) => m.t === "star")).toHaveLength(0);
  });
});
