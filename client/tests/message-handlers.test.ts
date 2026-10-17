import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Network } from "../src/network";
import type { Universe as UniverseClass } from "../src/universe";

// ブラウザ API の最小限のスタブ（constants.ts / universe.ts が読み込み時・実行時に使う）
const store = new Map<string, string>();
vi.stubGlobal("location", { search: "", hostname: "localhost", host: "localhost", port: "" });
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
});
vi.stubGlobal("performance", { now: () => 1234 });

let Universe: typeof UniverseClass;
let handleServerMessage: typeof import("../src/message-handlers").handleServerMessage;

beforeAll(async () => {
  ({ Universe } = await import("../src/universe"));
  ({ handleServerMessage } = await import("../src/message-handlers"));
});

const star = (id: string, by: string) => ({ id, x: 0.1, y: 0.2, c: 1, by, ts: 1000 });

function setup() {
  store.clear();
  const sent: unknown[] = [];
  const u = new Universe(false, (m) => sent.push(m));
  const net = { setSendInterval: vi.fn() } as unknown as Network;
  const dispatch = (m: Parameters<typeof handleServerMessage>[0]) => handleServerMessage(m, u, net);
  return { u, net, dispatch, sent };
}

describe("message-handlers", () => {
  it("welcome: 自分の id・既存の星と線・他の人を取り込み、送信間隔の指示を受け取る", () => {
    const { u, net, dispatch } = setup();
    dispatch({
      t: "welcome",
      id: "me1",
      sendMs: 300,
      dots: [{ id: "p1", x: 0.1, y: 0.2, c: 3 }],
      stars: [star("s1", "other")],
      links: [{ id: "l1", a: "s1", b: "s1", by: "o", ts: 1 }],
    });
    expect(u.myId).toBe("me1");
    expect(u.stars.has("s1")).toBe(true);
    expect(u.links.has("l1")).toBe(true);
    expect(u.peers.get("p1")).toMatchObject({ x: 0.1, rx: 0.1, c: 3 });
    expect(net.setSendInterval).toHaveBeenCalledWith(300);
  });

  it("rate: 送信間隔の指示を更新する", () => {
    const { net, dispatch } = setup();
    dispatch({ t: "rate", sendMs: 600 });
    expect(net.setSendInterval).toHaveBeenCalledWith(600);
  });

  it("ps: 他の人の位置を更新・追加する。自分は無視する（粗い一覧には自分も含まれる）", () => {
    const { u, dispatch } = setup();
    u.myId = "me1";
    dispatch({
      t: "ps",
      d: [
        ["p1", 0.5, 0.6, 2],
        ["me1", 9, 9, 0],
      ],
    });
    expect(u.peers.get("p1")).toMatchObject({ x: 0.5, y: 0.6, rx: 0.5, c: 2 });
    expect(u.peers.has("me1")).toBe(false);
    dispatch({ t: "ps", d: [["p1", 0.7, 0.6, 2]] });
    expect(u.peers.get("p1")).toMatchObject({ x: 0.7, rx: 0.5 }); // 表示位置は補間で追いかける
  });

  it("star: 星を追加し、同じ id の幽霊は要らなくなる", () => {
    const { u, dispatch } = setup();
    u.ghosts.set("s1", { id: "s1", x: 0, y: 0, c: 0, gone: 1 });
    dispatch({ t: "star", ...star("s1", "other") });
    expect(u.stars.has("s1")).toBe(true);
    expect(u.ghosts.has("s1")).toBe(false);
    expect(u.pairsDirty).toBe(true);
  });

  it("unstar: 自分の星は幽霊になり、他人の星はただ消える。つながる線も消える", () => {
    const { u, dispatch } = setup();
    dispatch({ t: "star", ...star("mine", u.uid) });
    dispatch({ t: "star", ...star("theirs", "someone") });
    dispatch({ t: "link", id: "l1", a: "mine", b: "theirs", by: "x", ts: 1 });
    dispatch({ t: "unstar", id: "mine" });
    dispatch({ t: "unstar", id: "theirs" });
    expect(u.ghosts.has("mine")).toBe(true);
    expect(u.ghosts.has("theirs")).toBe(false);
    expect(u.links.size).toBe(0);
  });

  it("admire: 寿命が更新される。存在しない星は無視する", () => {
    const { u, dispatch } = setup();
    dispatch({ t: "star", ...star("s1", "other") });
    dispatch({ t: "admire", id: "s1", ts: 5555 });
    expect(u.stars.get("s1")?.ts).toBe(5555);
    expect(() => dispatch({ t: "admire", id: "nope", ts: 1 })).not.toThrow();
  });

  it("leave: 抜けた人を消す", () => {
    const { u, dispatch } = setup();
    dispatch({ t: "ps", d: [["p1", 0, 0, 0]] });
    dispatch({ t: "leave", id: "p1" });
    expect(u.peers.has("p1")).toBe(false);
  });

  it("pulse: 波紋を追加する", () => {
    const { u, dispatch } = setup();
    dispatch({ t: "pulse", x: 0.3, y: 0.4, c: 2 });
    expect(u.pulses).toHaveLength(1);
  });

  it("未知のメッセージは無視する（新しいサーバーと古いクライアントの共存）", () => {
    const { dispatch } = setup();
    expect(() => dispatch({ t: "from-the-future" } as never)).not.toThrow();
  });
});

describe("Universe", () => {
  it("星を置くとサーバーへ送る。幽霊からの復活は同じ id を使う", () => {
    const { u, sent } = setup();
    const s = u.placeStar(0.1, 0.2, 3);
    expect(sent[0]).toMatchObject({ t: "star", id: s.id, uid: u.uid });
    u.deleteStar(s);
    const ghost = u.ghosts.get(s.id);
    expect(ghost).toBeDefined();
    const revived = u.reviveGhost(ghost!);
    expect(revived.id).toBe(s.id);
    expect(u.ghosts.has(s.id)).toBe(false);
  });

  it("同じ 2 点を結ぶ線は 1 本だけ", () => {
    const { u } = setup();
    const a = u.placeStar(0, 0, 0);
    const b = u.placeStar(1, 1, 0);
    expect(u.addLink(a.id, b.id)).not.toBeNull();
    expect(u.addLink(b.id, a.id)).toBeNull();
    expect(u.addLink(a.id, a.id)).toBeNull();
  });

  it("ソロでは星が寿命で消えない", () => {
    store.clear();
    const u = new Universe(true, () => undefined);
    const s = u.placeStar(0, 0, 0);
    s.ts = 0; // 大昔
    u.cleanupExpired();
    expect(u.stars.has(s.id)).toBe(true);
  });
});
