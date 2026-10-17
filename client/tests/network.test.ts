import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

// 送受信を記録し、開く・閉じるをテストから起こせる WebSocket
class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  // テスト用: サーバーとつながった / 切れた / 受け取った
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }
  messages(): { t: string }[] {
    return this.sent.filter((s) => s !== "ping").map((s) => JSON.parse(s) as { t: string });
  }
}
vi.stubGlobal("WebSocket", FakeWebSocket);

let mod: {
  Network: typeof NetworkClass;
  Camera: typeof import("../src/camera").Camera;
  Player: typeof import("../src/player").Player;
  Universe: typeof import("../src/universe").Universe;
};

beforeAll(async () => {
  mod = {
    Network: (await import("../src/network")).Network,
    Camera: (await import("../src/camera")).Camera,
    Player: (await import("../src/player")).Player,
    Universe: (await import("../src/universe")).Universe,
  };
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  FakeWebSocket.all = [];
  doc.listeners = [];
  doc.hidden = false;
  store.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

const WELCOME = { t: "welcome", id: "c1", me: "owner-hash", sendMs: 100, dots: [], stars: [], links: [] };

// Network を App の最小の偽物（universe / player / camera）で動かす
function setup() {
  const camera = new mod.Camera();
  camera.resize(1000, 700);
  const player = new mod.Player();
  const universe = new mod.Universe(false, (m) => net.send(m));
  const net = new mod.Network({ universe, player, camera });
  net.connect();
  const last = () => {
    const ws = FakeWebSocket.all.at(-1);
    if (!ws) throw new Error("接続が無い");
    return ws;
  };
  return { net, universe, player, camera, last };
}

describe("Network", () => {
  it("つながったら最初に hello {uid} を送り、そのあと位置を 1 回送る", () => {
    const { last, universe } = setup();
    last().open();
    const [hello, p] = last().messages();
    expect(hello).toEqual({ t: "hello", uid: universe.uid });
    expect(p).toMatchObject({ t: "p" });
  });

  it("welcome を受け取るまでは ready ではない。切れたら ready でなくなる", () => {
    const { net, last, universe } = setup();
    last().open();
    expect(net.ready).toBe(false);
    last().receive(WELCOME);
    expect(net.ready).toBe(true);
    expect(universe.ownerId).toBe("owner-hash");
    last().drop();
    expect(net.ready).toBe(false);
  });

  it("切れたら待ってから 1 本だけつなぎ直す（二重にならない）", () => {
    const { last } = setup();
    const ws1 = last();
    ws1.open();
    ws1.drop();
    ws1.onerror?.(); // 切れたあとに遅れて来たエラーも無視する
    expect(FakeWebSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("古い接続の onclose は無視する", () => {
    const { last } = setup();
    const ws1 = last();
    const oldOnClose = ws1.onclose;
    ws1.open();
    ws1.drop();
    vi.advanceTimersByTime(60_000);
    const ws2 = last();
    ws2.open();
    oldOnClose?.(); // 古い接続の閉じる通知が遅れて届いた
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.all).toHaveLength(2);
    expect(ws2.closed).toBe(false);
  });

  it("古い接続のメッセージは無視する", () => {
    const { last, universe } = setup();
    const ws1 = last();
    const oldOnMessage = ws1.onmessage;
    ws1.open();
    ws1.drop();
    vi.advanceTimersByTime(60_000);
    oldOnMessage?.({ data: JSON.stringify({ t: "star", id: "x", x: 0, y: 0, c: 0, by: "o", ts: 1 }) });
    expect(universe.stars.size).toBe(0);
  });

  it("死活監視が切断と判定したら、古い接続を閉じて待たずにつなぎ直す（half-open でも復帰する）", () => {
    const { last } = setup();
    const ws1 = last();
    ws1.open();
    vi.advanceTimersByTime(25_000);
    expect(ws1.sent).toContain("ping");
    vi.advanceTimersByTime(50_000); // 何も届かないまま 70 秒以上
    expect(ws1.closed).toBe(true);
    expect(ws1.onclose).toBeNull(); // ハンドラは外してある
    expect(FakeWebSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.all).toHaveLength(2); // 予約された再接続が後から重ならない
  });

  it("隠れて 30 秒で切断し、戻るまでつながない。戻ったら 1 本だけつなぐ", () => {
    const { last } = setup();
    const ws1 = last();
    ws1.open();
    doc.setHidden(true);
    vi.advanceTimersByTime(30_000);
    expect(ws1.closed).toBe(true);
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    doc.setHidden(false);
    expect(FakeWebSocket.all).toHaveLength(2);
    doc.setHidden(false); // 表示の通知が重なっても増えない
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("再接続を待っている間に隠れて切断 → 戻ったときも二重につながない", () => {
    const { last } = setup();
    const ws1 = last();
    ws1.open();
    ws1.drop(); // 再接続を予約
    doc.setHidden(true);
    vi.advanceTimersByTime(30_000); // この間に予約がつなぎ直す場合もある
    const n = FakeWebSocket.all.length;
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeWebSocket.all).toHaveLength(n); // 隠れて切ったあとはつながない
    doc.setHidden(false);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.all).toHaveLength(n + 1);
    expect(FakeWebSocket.all.filter((w) => !w.closed)).toHaveLength(1);
  });

  it("隠れてすぐ戻ったら切断しない", () => {
    const { last } = setup();
    const ws1 = last();
    ws1.open();
    doc.setHidden(true);
    vi.advanceTimersByTime(10_000);
    doc.setHidden(false);
    vi.advanceTimersByTime(60_000);
    expect(ws1.closed).toBe(false);
    expect(FakeWebSocket.all).toHaveLength(1);
  });

  it("位置: 動かなければ送らない（heartbeat なし）。autopilot（target が null）の間も送らない", () => {
    const { net, last, player } = setup();
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

  it("autopilot 中でも、ユーザーが視界を動かしたら視界を送る", () => {
    const { net, last, camera } = setup();
    const ws = last();
    ws.open();
    camera.pan(200, 0);
    net.tick(1_000);
    expect(ws.messages().filter((m) => m.t === "p")).toHaveLength(2);
  });
});
