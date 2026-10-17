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
  autoPong = true; // false にすると、サーバーが ping に答えない（half-open）
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
    if (data === "ping" && this.autoPong) this.receive("pong");
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
  drop(code = 1006) {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code });
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
  vi.restoreAllMocks();
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
    const { joined } = setup();
    const ws1 = joined();
    ws1.drop();
    ws1.onerror?.(); // 切れたあとに遅れて来たエラーも無視する
    expect(FakeWebSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(3000); // 1500ms × 0.5〜1.5
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("古い接続の onclose は無視する", () => {
    const { joined } = setup();
    const ws1 = joined();
    const oldOnClose = ws1.onclose;
    ws1.drop();
    vi.advanceTimersByTime(3000);
    const ws2 = joined();
    oldOnClose?.({ code: 1006 }); // 古い接続の閉じる通知が遅れて届いた
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.all).toHaveLength(2);
    expect(ws2.closed).toBe(false);
  });

  it("古い接続のメッセージは無視する", () => {
    const { joined, universe } = setup();
    const ws1 = joined();
    const oldOnMessage = ws1.onmessage;
    ws1.drop();
    vi.advanceTimersByTime(60_000);
    oldOnMessage?.({ data: JSON.stringify({ t: "star", id: "x", x: 0, y: 0, c: 0, by: "o", ts: 1 }) });
    expect(universe.stars.size).toBe(0);
  });

  it("再接続の待ち時間は welcome を受けたときに初期値へ戻る（つながるだけでは戻らない）", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // ばらつきの倍率を 1 にする
    const { last, joined } = setup();
    last().open();
    last().drop(); // 1 回目: 1500ms
    vi.advanceTimersByTime(1500);
    expect(FakeWebSocket.all).toHaveLength(2);
    last().open(); // つながったが welcome の前に切れた
    last().drop(); // 2 回目: 2400ms（戻っていない）
    vi.advanceTimersByTime(1500);
    expect(FakeWebSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(900);
    expect(FakeWebSocket.all).toHaveLength(3);
    joined().drop(); // welcome まで受けたので初期値に戻る
    vi.advanceTimersByTime(1500);
    expect(FakeWebSocket.all).toHaveLength(4);
  });

  it("サーバーが 1008 で切ったら、次の再接続まで 30 秒以上待つ", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { joined } = setup();
    joined().drop(1008);
    vi.advanceTimersByTime(29_999);
    expect(FakeWebSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("1008 の待ちにもばらつきがある（一斉に戻らない）", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const { joined } = setup();
    joined().drop(1008);
    vi.advanceTimersByTime(30_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(15_000); // 30 秒 × 1〜1.5
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("CONNECTING のまま 10 秒たったら、閉じてつなぎ直す", () => {
    const { last } = setup();
    const ws1 = last(); // onopen が来ない
    vi.advanceTimersByTime(9_999);
    expect(ws1.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(ws1.closed).toBe(true);
    expect(ws1.onclose).toBeNull();
    vi.advanceTimersByTime(3000);
    expect(FakeWebSocket.all).toHaveLength(2);
    expect(last().closed).toBe(false);
  });

  it("つながっても 10 秒以内に welcome が来なければ、つなぎ直す", () => {
    const { last } = setup();
    const ws1 = last();
    ws1.open();
    vi.advanceTimersByTime(10_000);
    expect(ws1.closed).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("welcome が来たら接続タイムアウトは働かない", () => {
    const { joined } = setup();
    const ws1 = joined();
    vi.advanceTimersByTime(60_000);
    expect(ws1.closed).toBe(false);
    expect(FakeWebSocket.all).toHaveLength(1);
  });

  it("ping は 10 秒ごと。pong が返っている間は切らない", () => {
    const { joined } = setup();
    const ws1 = joined();
    vi.advanceTimersByTime(10_000);
    expect(ws1.sent.filter((s) => s === "ping")).toHaveLength(1);
    vi.advanceTimersByTime(110_000);
    expect(ws1.sent.filter((s) => s === "ping")).toHaveLength(12);
    expect(ws1.closed).toBe(false);
  });

  it("ping に 2 回続けて答えが無ければ（約 25 秒）、古い接続を閉じて待たずにつなぎ直す（half-open でも復帰する）", () => {
    const { joined } = setup();
    const ws1 = joined();
    ws1.autoPong = false;
    vi.advanceTimersByTime(20_000);
    expect(ws1.sent.filter((s) => s === "ping")).toHaveLength(2);
    expect(ws1.closed).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(ws1.closed).toBe(true);
    expect(ws1.onclose).toBeNull(); // ハンドラは外してある
    expect(FakeWebSocket.all).toHaveLength(2);
    joined();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.all).toHaveLength(2); // 予約された再接続が後から重ならない
  });

  it("隠れて 30 秒で切断し、戻るまでつながない。戻ったら 1 本だけつなぐ", () => {
    const { joined } = setup();
    const ws1 = joined();
    doc.setHidden(true);
    vi.advanceTimersByTime(30_000);
    expect(ws1.closed).toBe(true);
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    doc.setHidden(false);
    expect(FakeWebSocket.all).toHaveLength(2);
    doc.setHidden(false); // 表示の通知が重なっても増えない
    vi.advanceTimersByTime(5_000); // 接続タイムアウト（10 秒）の前。再接続の待ちに当たらない時点で数える
    expect(FakeWebSocket.all.filter((w) => !w.closed)).toHaveLength(1);
  });

  it("再接続を待っている間に隠れて切断 → 戻ったときも二重につながない", () => {
    const { joined } = setup();
    const ws1 = joined();
    ws1.drop(); // 再接続を予約
    doc.setHidden(true);
    vi.advanceTimersByTime(30_000); // この間に予約がつなぎ直す場合もある
    const n = FakeWebSocket.all.length;
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeWebSocket.all).toHaveLength(n); // 隠れて切ったあとはつながない
    doc.setHidden(false);
    vi.advanceTimersByTime(5_000); // 接続タイムアウト（10 秒）の前。再接続の待ちに当たらない時点で数える
    expect(FakeWebSocket.all.length).toBeGreaterThan(n);
    expect(FakeWebSocket.all.filter((w) => !w.closed)).toHaveLength(1);
  });

  it("隠れてすぐ戻ったら切断しない", () => {
    const { joined } = setup();
    const ws1 = joined();
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

  it("位置を送る間隔は、サーバーの指示（1 人のときの 1000ms など）をそのまま使う。下限は 100ms", () => {
    const { net, joined, player } = setup();
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
