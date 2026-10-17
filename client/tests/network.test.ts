import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ReconnectingWebSocket from "partysocket/ws";
import type { Network as NetworkClass } from "../src/network";

// ブラウザ API の最小限のスタブ
const store = new Map<string, string>();
vi.stubGlobal("location", { search: "", hostname: "localhost", host: "localhost", port: "", protocol: "https:" });
vi.stubGlobal("window", { devicePixelRatio: 1 });
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
});
vi.stubGlobal("performance", { now: () => 1234 });

// 表示状態の切り替えを外から起こせる document
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

// 送受信を記録し、開く・閉じるをテストから起こせる WebSocket（PartySocket の WebSocket オプションで差し込む）。
// PartySocket は addEventListener でつなぐので、EventTarget として通知する
class FakeWebSocket extends EventTarget {
  static all: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  bufferedAmount = 0;
  sent: string[] = [];
  closed = false;
  autoPong = true; // false にすると、サーバーが ping に答えない（half-open）
  constructor(readonly url: string) {
    super();
    FakeWebSocket.all.push(this);
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error("開いていない接続に送った");
    this.sent.push(data);
    if (data === "ping" && this.autoPong) this.receive("pong");
  }
  // 自分から閉じたときは、閉じる通知を出さない（PartySocket が自分で close を通知する）
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  // テスト用: サーバーとつながった / 切れた / 受け取った / エラーが起きた
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
  fail() {
    this.dispatchEvent(new Event("error"));
  }
  messages(): { t: string }[] {
    return this.sent.filter((s) => s !== "ping").map((s) => JSON.parse(s) as { t: string });
  }
}

let mod: {
  Network: typeof NetworkClass;
  socketOptions: typeof import("../src/network").socketOptions;
  WS_HOST: string;
  Camera: typeof import("../src/camera").Camera;
  Player: typeof import("../src/player").Player;
  Universe: typeof import("../src/universe").Universe;
};

beforeAll(async () => {
  const network = await import("../src/network");
  mod = {
    Network: network.Network,
    socketOptions: network.socketOptions,
    WS_HOST: (await import("../src/constants")).WS_HOST,
    Camera: (await import("../src/camera")).Camera,
    Player: (await import("../src/player")).Player,
    Universe: (await import("../src/universe")).Universe,
  };
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  // 待ち時間のばらつきを固定する（各テストで上書きできる）。0 なら再接続の最小待ちはちょうど 1.5 秒
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
const STAR = { t: "star", id: "s1", x: 0.1, y: 0.1, c: 0 } as const;

// PartySocket は接続を非同期に作る（待ち時間 0 でもタイマーと Promise を経る）。時間を進めて、その間の非同期も流す
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const alive = () => FakeWebSocket.all.filter((w) => !w.closed);

// Network を App の最小の偽物（universe / player / camera）で動かす
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
  // つながって welcome まで受け取った接続
  const joined = () => {
    const ws = last();
    ws.open();
    ws.receive(WELCOME);
    return ws;
  };
  return { net, universe, player, camera, last, joined };
}

describe("Network", () => {
  it("接続先は WS_HOST の /ws", async () => {
    const { last } = await setup();
    expect(last().url).toBe(`wss://${mod.WS_HOST}/ws`);
  });

  it("つながったら最初に hello {uid} を送り、そのあと位置を 1 回送る", async () => {
    const { last, universe } = await setup();
    last().open();
    const [hello, p] = last().messages();
    expect(hello).toEqual({ t: "hello", uid: universe.uid });
    expect(p).toMatchObject({ t: "p" });
  });

  it("welcome を受け取るまでは ready ではない。切れたら ready でなくなる", async () => {
    const { net, last, universe } = await setup();
    expect(net.ready).toBe(false);
    last().open();
    expect(net.ready).toBe(false);
    last().receive(WELCOME);
    expect(net.ready).toBe(true);
    expect(universe.ownerId).toBe("owner-hash");
    last().drop();
    expect(net.ready).toBe(false);
  });

  it("connect を何度呼んでも接続は 1 本", async () => {
    const { net, joined } = await setup();
    joined();
    net.connect();
    net.connect();
    await wait(60_000);
    expect(FakeWebSocket.all).toHaveLength(1);
  });

  it("切れたら 1.5 秒待ってから 1 本だけつなぎ直す（遅れて来たエラーでも二重にならない）", async () => {
    const { joined } = await setup();
    const ws1 = joined();
    ws1.drop();
    ws1.fail(); // 切れたあとに遅れて来たエラーは無視される
    await wait(1499);
    expect(FakeWebSocket.all).toHaveLength(1);
    await wait(1);
    expect(FakeWebSocket.all).toHaveLength(2);
    joined();
    await wait(60_000);
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("古い接続から遅れて届いたメッセージ・閉じる通知は無視する", async () => {
    const { joined, universe } = await setup();
    const ws1 = joined();
    ws1.drop();
    await wait(1500);
    const ws2 = joined();
    ws1.receive({ t: "star", id: "x", x: 0, y: 0, c: 0, by: "o", ts: 1 });
    ws1.drop(1008);
    expect(universe.stars.size).toBe(0);
    await wait(60_000);
    expect(FakeWebSocket.all).toHaveLength(2);
    expect(ws2.closed).toBe(false);
  });

  it("再接続の待ちは 1.6 倍ずつ伸び、15 秒で頭打ち", async () => {
    const { last } = await setup();
    // 1500 × 1.6^n。5 回目は 9830.4ms、6 回目以降は 15000ms で頭打ち（端数を避けて 5 回目は余裕を持って待つ）
    const expected = [1500, 2400, 3840, 6144];
    for (const [i, ms] of expected.entries()) {
      last().drop(); // 開かないまま切れた
      await wait(ms - 1);
      expect(FakeWebSocket.all).toHaveLength(i + 1);
      await wait(1);
      expect(FakeWebSocket.all).toHaveLength(i + 2);
    }
    last().drop();
    await wait(9_800);
    expect(FakeWebSocket.all).toHaveLength(5);
    await wait(100);
    expect(FakeWebSocket.all).toHaveLength(6);
    for (const n of [7, 8]) {
      last().drop();
      await wait(14_999);
      expect(FakeWebSocket.all).toHaveLength(n - 1);
      await wait(1);
      expect(FakeWebSocket.all).toHaveLength(n);
    }
  });

  it("待ち時間には端末ごとのばらつきがある（一斉に戻らない）", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const { joined } = await setup();
    joined().drop();
    await wait(2000);
    expect(FakeWebSocket.all).toHaveLength(1);
    await wait(250); // 1.5 秒 × 1〜1.5
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("安定してつながった（5 秒以上）あとに切れたら、待ち時間は初期値に戻る", async () => {
    const { last, joined } = await setup();
    last().drop(); // 1 回目: 1500ms
    await wait(1500);
    last().drop(); // 2 回目: 2400ms
    await wait(2400);
    expect(FakeWebSocket.all).toHaveLength(3);
    joined();
    await wait(5000);
    last().drop(); // 安定していたので 1500ms に戻る
    await wait(1500);
    expect(FakeWebSocket.all).toHaveLength(4);
  });

  it("サーバーが 1008 で切ったら、次の再接続まで 30 秒以上待つ", async () => {
    const { joined } = await setup();
    joined().drop(1008);
    await wait(29_999);
    expect(FakeWebSocket.all).toHaveLength(1);
    await wait(1);
    await wait(1); // reconnect() のあとの接続は、待ち 0 のタイマーを経て作られる（タイマーの中から予約した 0ms は、偽のタイマーでは 1ms）
    expect(FakeWebSocket.all).toHaveLength(2);
    joined();
    await wait(60_000);
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("1008 の待ちにもばらつきがある（30 秒 × 1〜1.5）", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const { joined } = await setup();
    joined().drop(1008);
    await wait(44_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    await wait(1000);
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("CONNECTING のまま 10 秒たったら、閉じてつなぎ直す", async () => {
    const { last } = await setup();
    const ws1 = last(); // open が来ない
    await wait(9_999);
    expect(ws1.closed).toBe(false);
    await wait(1);
    expect(ws1.closed).toBe(true);
    await wait(1500);
    expect(FakeWebSocket.all).toHaveLength(2);
    expect(alive()).toHaveLength(1);
  });

  it("つながっても 10 秒以内に welcome が来なければ、つなぎ直す", async () => {
    const { last } = await setup();
    const ws1 = last();
    ws1.open();
    await wait(9_999);
    expect(ws1.closed).toBe(false);
    await wait(1);
    expect(ws1.closed).toBe(true);
    await wait(1);
    expect(FakeWebSocket.all).toHaveLength(2);
    expect(alive()).toHaveLength(1);
  });

  it("welcome が来たら接続タイムアウトは働かない", async () => {
    const { joined } = await setup();
    const ws1 = joined();
    await wait(60_000);
    expect(ws1.closed).toBe(false);
    expect(FakeWebSocket.all).toHaveLength(1);
  });

  it("ping は 10 秒ごと。pong が返っている間は切らない", async () => {
    const { joined } = await setup();
    const ws1 = joined();
    await wait(10_000);
    expect(ws1.sent.filter((s) => s === "ping")).toHaveLength(1);
    await wait(110_000);
    expect(ws1.sent.filter((s) => s === "ping")).toHaveLength(12);
    expect(ws1.closed).toBe(false);
  });

  it("ping に 2 回続けて答えが無ければ（約 25 秒）、待たずにつなぎ直す（half-open でも復帰する）", async () => {
    const { joined } = await setup();
    const ws1 = joined();
    ws1.autoPong = false;
    await wait(20_000);
    expect(ws1.sent.filter((s) => s === "ping")).toHaveLength(2);
    expect(ws1.closed).toBe(false);
    await wait(5_000);
    expect(ws1.closed).toBe(true);
    await wait(1);
    expect(FakeWebSocket.all).toHaveLength(2);
    joined();
    ws1.drop(); // half-open だった古い接続の閉じる通知が遅れて届いても
    await wait(60_000);
    expect(FakeWebSocket.all).toHaveLength(2); // 後から重ならない
  });

  it("隠れて 30 秒で切断し、戻るまでつながない。戻ったら 1 本だけつなぐ", async () => {
    const { joined } = await setup();
    const ws1 = joined();
    doc.setHidden(true);
    await wait(30_000);
    expect(ws1.closed).toBe(true);
    await wait(10 * 60_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    doc.setHidden(false);
    doc.setHidden(false); // 表示の通知が重なっても増えない
    await wait(0);
    expect(FakeWebSocket.all).toHaveLength(2);
    await wait(5_000);
    expect(alive()).toHaveLength(1);
  });

  it("再接続を待っている間に隠れて切断 → 戻ったときも二重につながない", async () => {
    const { joined } = await setup();
    const ws1 = joined();
    ws1.drop(); // 再接続を待つ
    doc.setHidden(true);
    await wait(30_000); // この間に再接続している
    const n = FakeWebSocket.all.length;
    await wait(10 * 60_000);
    expect(FakeWebSocket.all).toHaveLength(n); // 隠れて切ったあとはつながない
    expect(alive()).toHaveLength(0);
    doc.setHidden(false);
    await wait(5_000);
    expect(FakeWebSocket.all).toHaveLength(n + 1);
    expect(alive()).toHaveLength(1);
  });

  it("再接続の待ちの途中で隠れて切断 → 待ちが明けてもつながない", async () => {
    const { joined, last } = await setup();
    joined();
    doc.setHidden(true);
    await wait(29_000);
    last().drop(); // 1.5 秒後に再接続する予定
    await wait(1_000); // 隠れて 30 秒。待ちの途中で切断
    await wait(10 * 60_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    doc.setHidden(false);
    await wait(5_000);
    expect(FakeWebSocket.all).toHaveLength(2);
    expect(alive()).toHaveLength(1);
  });

  it("1008 の待ちの途中で隠れて切断 → 待ちが明けてもつながない", async () => {
    const { joined } = await setup();
    joined().drop(1008);
    doc.setHidden(true);
    await wait(10 * 60_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    doc.setHidden(false);
    await wait(5_000);
    expect(FakeWebSocket.all).toHaveLength(2);
    expect(alive()).toHaveLength(1);
  });

  it("隠れてすぐ戻ったら切断しない", async () => {
    const { joined } = await setup();
    const ws1 = joined();
    doc.setHidden(true);
    await wait(10_000);
    doc.setHidden(false);
    await wait(60_000);
    expect(ws1.closed).toBe(false);
    expect(FakeWebSocket.all).toHaveLength(1);
  });

  it("切断中に送った操作は捨てる（再接続後に古い操作を送らない）", async () => {
    const { net, joined, last } = await setup();
    joined().drop();
    net.send(STAR);
    await wait(1500);
    last().open();
    expect(
      last()
        .messages()
        .map((m) => m.t),
    ).toEqual(["hello", "p"]);
  });

  it("PartySocket の送信バッファは使わない（開いていないときの send は捨てられる）", async () => {
    const ws = new ReconnectingWebSocket("wss://localhost/ws", undefined, {
      ...mod.socketOptions(),
      WebSocket: FakeWebSocket,
    });
    await wait(0);
    expect(ws.send(JSON.stringify(STAR))).toBe(false);
    expect(ws.bufferedAmount).toBe(0);
    const inner = FakeWebSocket.all.at(-1);
    inner?.open();
    expect(inner?.sent).toEqual([]);
    ws.close();
  });

  it("位置: 動かなければ送らない（heartbeat なし）。autopilot（target が null）の間も送らない", async () => {
    const { net, last, player } = await setup();
    const ws = last();
    ws.open();
    const count = () => ws.messages().filter((m) => m.t === "p").length;
    expect(count()).toBe(1); // 接続直後の 1 回
    let t = 0;
    const tickFor = (ms: number) => {
      for (const end = t + ms; t < end; t += 100) net.tick(t);
    };
    tickFor(10_000);
    expect(count()).toBe(1);
    player.x += 0.1; // autopilot で漂った
    tickFor(1_000);
    expect(count()).toBe(1);
    player.target = { x: 0.2, y: 0.2 }; // ユーザーが操作した
    player.x = 0.2;
    tickFor(200);
    expect(count()).toBe(2);
    tickFor(10_000); // 止まっていれば送らない
    expect(count()).toBe(2);
  });

  it("autopilot 中でも、ユーザーが視界を動かしたら視界を送る", async () => {
    const { net, last, camera } = await setup();
    const ws = last();
    ws.open();
    camera.pan(200, 0);
    net.tick(1_000);
    expect(ws.messages().filter((m) => m.t === "p")).toHaveLength(2);
  });

  it("位置を送る間隔は、サーバーの指示（1 人のときの 1000ms など）をそのまま使う。下限は 100ms", async () => {
    const { net, joined, player } = await setup();
    const ws = joined();
    const count = () => ws.messages().filter((m) => m.t === "p").length;
    const moveFor = (from: number, ms: number) => {
      for (let t = from; t < from + ms; t += 50) {
        player.target = { x: t / 1e5, y: 0 };
        player.x = t / 1e5;
        net.tick(t);
      }
    };
    ws.receive({ t: "rate", sendMs: 1000 });
    const before = count();
    moveFor(1000, 3000); // t = 1000, 2000, 3000 の 3 回
    expect(count() - before).toBe(3);
    net.setSendInterval(30);
    const mid = count();
    moveFor(10_000, 1000); // 下限 100ms で 10 回
    expect(count() - mid).toBe(10);
  });
});
