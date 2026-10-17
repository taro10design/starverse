import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "../../shared/protocol";
import type { Network } from "../src/network";
import type { Universe as UniverseClass } from "../src/universe";

// ブラウザ API の最小限のスタブ（constants.ts / universe.ts が読み込み時・実行時に使う）
const store = new Map<string, string>();
vi.stubGlobal("location", { search: "", hostname: "localhost", host: "localhost", port: "" });
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});
vi.stubGlobal("performance", { now: () => 1234 });

let Universe: typeof UniverseClass;
let handleServerMessage: typeof import("../src/message-handlers").handleServerMessage;
let parseServerMessage: typeof import("../src/message-handlers").parseServerMessage;

beforeAll(async () => {
  ({ Universe } = await import("../src/universe"));
  ({ handleServerMessage, parseServerMessage } = await import("../src/message-handlers"));
});

const ME = "owner-me";
const star = (id: string, by: string) => ({ id, x: 0.1, y: 0.2, c: 1, by, ts: 1000 });
type Welcome = Extract<ServerMessage, { t: "welcome" }>;
const welcome = (over: Partial<Welcome> = {}): Welcome => ({
  t: "welcome",
  id: "me1",
  me: ME,
  sendMs: 300,
  dots: [],
  stars: [],
  links: [],
  ...over,
});

function setup() {
  store.clear();
  const sent: unknown[] = [];
  const u = new Universe(false, (m) => sent.push(m));
  const net = { setSendInterval: vi.fn(), markWelcomed: vi.fn() } as unknown as Network;
  const dispatch = (m: Parameters<typeof handleServerMessage>[0]) => handleServerMessage(m, u, net);
  return { u, net, dispatch, sent };
}

describe("message-handlers", () => {
  it("welcome: 自分の接続 id・持ち主 ID・既存の星と線・他の人を取り込み、送信間隔の指示を受け取る", () => {
    const { u, net, dispatch } = setup();
    expect(u.ownerId).toBeNull(); // オンラインでは welcome まで持ち主 ID は分からない
    dispatch(
      welcome({
        dots: [{ id: "p1", x: 0.1, y: 0.2, c: 3 }],
        stars: [star("s1", "other")],
        links: [{ id: "l1", a: "s1", b: "s1", by: "o", ts: 1 }],
      }),
    );
    expect(u.myId).toBe("me1");
    expect(u.ownerId).toBe(ME);
    expect(u.stars.has("s1")).toBe(true);
    expect(u.links.has("l1")).toBe(true);
    expect(u.peers.get("p1")).toMatchObject({ x: 0.1, rx: 0.1, c: 3 });
    expect(net.setSendInterval).toHaveBeenCalledWith(300);
    expect(net.markWelcomed).toHaveBeenCalledTimes(1);
  });

  it("welcome: 星・線・他の人は置き換える（再接続の前の古い状態を残さない）。幽霊は残す", () => {
    const { u, dispatch } = setup();
    dispatch(welcome({ stars: [star("old", "x")], dots: [{ id: "p-old", x: 0, y: 0, c: 0 }] }));
    dispatch({ t: "link", id: "l-old", a: "old", b: "old", by: "x", ts: 1 });
    u.ghosts.set("g1", { id: "g1", x: 0, y: 0, c: 0, gone: Date.now() });
    u.ghosts.set("s-new", { id: "s-new", x: 0, y: 0, c: 0, gone: Date.now() });
    dispatch(welcome({ stars: [star("s-new", ME)], dots: [{ id: "p-new", x: 0, y: 0, c: 0 }] }));
    expect([...u.stars.keys()]).toEqual(["s-new"]);
    expect(u.links.size).toBe(0);
    expect([...u.peers.keys()]).toEqual(["p-new"]);
    expect(u.ghosts.has("g1")).toBe(true);
    expect(u.ghosts.has("s-new")).toBe(false); // 生きてるなら幽霊は要らない
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

  it("ps: 30 秒以上更新されなかった人は updatePeers で消える", () => {
    const { u, dispatch } = setup();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000);
      dispatch({ t: "ps", d: [["stale", 0, 0, 0]] });
      vi.setSystemTime(120_000);
      dispatch({ t: "ps", d: [["fresh", 0, 0, 0]] });
      u.updatePeers(1);
      expect(u.peers.has("stale")).toBe(true);
      vi.setSystemTime(131_000);
      u.updatePeers(1);
      expect(u.peers.has("stale")).toBe(false);
      expect(u.peers.has("fresh")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("star: 星を追加し、同じ id の幽霊は要らなくなる", () => {
    const { u, dispatch } = setup();
    u.ghosts.set("s1", { id: "s1", x: 0, y: 0, c: 0, gone: 1 });
    dispatch({ t: "star", ...star("s1", "other") });
    expect(u.stars.has("s1")).toBe(true);
    expect(u.ghosts.has("s1")).toBe(false);
    expect(u.pairsDirty).toBe(true);
  });

  it("unstar: 自分の星（by が持ち主 ID）は幽霊になり、他人の星はただ消える。つながる線も消える", () => {
    const { u, dispatch } = setup();
    dispatch(welcome());
    dispatch({ t: "star", ...star("mine", ME) });
    dispatch({ t: "star", ...star("theirs", "someone") });
    dispatch({ t: "star", ...star("uid-by", u.uid) }); // uid そのものは持ち主 ID ではない
    dispatch({ t: "link", id: "l1", a: "mine", b: "theirs", by: "x", ts: 1 });
    dispatch({ t: "unstar", id: "mine" });
    dispatch({ t: "unstar", id: "theirs" });
    dispatch({ t: "unstar", id: "uid-by" });
    expect(u.ghosts.has("mine")).toBe(true);
    expect(u.ghosts.has("theirs")).toBe(false);
    expect(u.ghosts.has("uid-by")).toBe(false);
    expect(u.links.size).toBe(0);
  });

  it("reject star: 自分の画面から星と付いた線を取り消す。unstar は送らず、幽霊にもしない", () => {
    const { u, dispatch, sent } = setup();
    dispatch(welcome({ stars: [star("other", "x")] }));
    const s = u.placeStar(0.3, 0.3, 2);
    if (!s) throw new Error("星が置けない");
    u.addLink(s.id, "other");
    sent.length = 0;
    dispatch({ t: "reject", kind: "star", id: s.id });
    expect(u.stars.has(s.id)).toBe(false);
    expect(u.ghosts.has(s.id)).toBe(false);
    expect(u.links.size).toBe(0);
    expect(u.pairsDirty).toBe(true);
    expect(sent).toEqual([]);
  });

  it("reject link: 線を取り消す。unlink は送らない", () => {
    const { u, dispatch, sent } = setup();
    dispatch(welcome({ stars: [star("a", "x"), star("b", "x")] }));
    const l = u.addLink("a", "b");
    if (!l) throw new Error("線が引けない");
    sent.length = 0;
    dispatch({ t: "reject", kind: "link", id: l.id });
    expect(u.links.has(l.id)).toBe(false);
    expect(sent).toEqual([]);
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
    expect(() => dispatch({ t: "toString" } as never)).not.toThrow(); // プロトタイプの名前も拾わない
  });
});

describe("parseServerMessage", () => {
  it("JSON の文字列で t を持つものだけ通す", () => {
    expect(parseServerMessage('{"t":"rate","sendMs":100}')).toEqual({ t: "rate", sendMs: 100 });
    expect(parseServerMessage("not json")).toBeNull();
    expect(parseServerMessage("[1,2]")).toBeNull();
    expect(parseServerMessage('{"x":1}')).toBeNull();
    expect(parseServerMessage(new ArrayBuffer(2))).toBeNull();
  });
});

describe("Universe", () => {
  it("星を置くと色つきでサーバーへ送る（uid は載せない）。by は持ち主 ID。幽霊からの復活は同じ id と幽霊の色", () => {
    const { u, sent, dispatch } = setup();
    dispatch(welcome());
    const s = u.placeStar(0.1, 0.2, 3);
    if (!s) throw new Error("星が置けない");
    expect(s.by).toBe(ME);
    expect(sent[0]).toEqual({ t: "star", id: s.id, x: 0.1, y: 0.2, c: 3 });
    expect(JSON.stringify(sent)).not.toContain(u.uid);
    u.deleteStar(s);
    const ghost = u.ghosts.get(s.id);
    if (!ghost) throw new Error("ghost が無い");
    sent.length = 0;
    const revived = u.reviveGhost(ghost);
    expect(revived?.id).toBe(s.id);
    expect(revived?.c).toBe(3);
    expect(sent[0]).toMatchObject({ t: "star", id: s.id, c: 3 });
    expect(u.ghosts.has(s.id)).toBe(false);
  });

  it("welcome の前（持ち主 ID が未確定のオンライン）は星も線も作らない", () => {
    const { u, sent } = setup();
    u.stars.set("a", star("a", "x"));
    u.stars.set("b", star("b", "x"));
    expect(u.placeStar(0.1, 0.1, 0)).toBeNull();
    expect(u.addLink("a", "b")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("isMine は持ち主 ID で判定する", () => {
    const { u, dispatch } = setup();
    expect(u.isMine({ by: u.uid })).toBe(false);
    dispatch(welcome());
    expect(u.isMine({ by: ME })).toBe(true);
    expect(u.isMine({ by: u.uid })).toBe(false);
  });

  it("自分の星は MAX_STARS_PER_USER まで、線は MAX_LINKS_PER_USER まで", async () => {
    const { MAX_STARS_PER_USER, MAX_LINKS_PER_USER } = await import("../../shared/limits");
    const { u, dispatch } = setup();
    dispatch(welcome({ stars: [star("other", "x")] }));
    const mine = [];
    for (let i = 0; i < MAX_STARS_PER_USER; i++) mine.push(u.placeStar(i / 100, 0, 0));
    expect(mine.every((s) => s !== null)).toBe(true);
    expect(u.placeStar(0.9, 0.9, 0)).toBeNull();
    // 他人の星を足しても自分の数には入らない
    u.stars.set("other2", star("other2", "x"));
    let links = 0;
    for (const a of [...u.stars.keys()]) {
      for (const b of [...u.stars.keys()]) {
        if (a < b && u.addLink(a, b)) links++;
      }
    }
    expect(links).toBe(MAX_LINKS_PER_USER);
  });

  it("同じ 2 点を結ぶ線は 1 本だけ", () => {
    const { u } = setup();
    u.ownerId = ME;
    const a = u.placeStar(0, 0, 0);
    const b = u.placeStar(1, 1, 0);
    if (!a || !b) throw new Error("星が置けない");
    expect(u.addLink(a.id, b.id)).not.toBeNull();
    expect(u.addLink(b.id, a.id)).toBeNull();
    expect(u.addLink(a.id, a.id)).toBeNull();
  });

  it("ソロでは持ち主 ID は uid と同じで、星が寿命で消えない", () => {
    store.clear();
    const u = new Universe(true, () => undefined);
    expect(u.ownerId).toBe(u.uid);
    const s = u.placeStar(0, 0, 0);
    if (!s) throw new Error("星が置けない");
    s.ts = 0; // 大昔
    u.cleanupExpired();
    expect(u.stars.has(s.id)).toBe(true);
  });

  it("壊れた localStorage: 幽霊・ソロの星と線は形の正しい要素だけ読む", () => {
    store.clear();
    const now = Date.now();
    store.set(
      "uchu-ghosts",
      JSON.stringify([
        { id: "g1", x: 0, y: 0, c: 1, gone: now },
        { id: 3 },
        null,
        "x",
        { id: "g2", x: "0", y: 0, c: 1, gone: now },
      ]),
    );
    store.set(
      "uchu-solo",
      JSON.stringify({
        stars: [star("s1", "u"), { id: "s2", x: 0, y: 0, c: 99, by: "u", ts: 1 }, 5],
        links: [{ id: "l1", a: "s1", b: "s1", by: "u", ts: 1 }, { id: "l2" }],
      }),
    );
    const u = new Universe(true, () => undefined);
    expect([...u.ghosts.keys()]).toEqual(["g1"]);
    expect([...u.stars.keys()]).toEqual(["s1"]);
    expect([...u.links.keys()]).toEqual(["l1"]);

    store.set("uchu-ghosts", '{"not":"array"}');
    store.set("uchu-solo", "[1,2,3]");
    const u2 = new Universe(true, () => undefined);
    expect(u2.ghosts.size).toBe(0);
    expect(u2.stars.size).toBe(0);
  });

  it("?key= で持ち越した鍵は uchu-key に保存したあとアドレスバーから消す", () => {
    store.clear();
    const replaceState = vi.fn();
    vi.stubGlobal("location", { search: "?key=abcdefgh-123&solo", pathname: "/", hash: "#x", hostname: "localhost" });
    vi.stubGlobal("history", { replaceState });
    try {
      const u = new Universe(true, () => undefined);
      expect(u.uid).toBe("abcdefgh-123");
      expect(store.get("uchu-key")).toBe("abcdefgh-123");
      expect(store.has("uchu-uid")).toBe(false);
      expect(replaceState).toHaveBeenCalledWith(null, "", "/?solo#x");
    } finally {
      vi.stubGlobal("location", { search: "", hostname: "localhost", host: "localhost", port: "" });
    }
  });

  it("鍵は uchu-key に保存して次回も使う。旧プロトコルで配信された uchu-uid は読まずに消す", () => {
    store.clear();
    store.set("uchu-uid", "leaked-old-uid-123");
    const u1 = new Universe(false, () => undefined);
    expect(u1.uid).not.toBe("leaked-old-uid-123");
    expect(store.get("uchu-key")).toBe(u1.uid);
    expect(store.has("uchu-uid")).toBe(false); // 公開済みの値を端末に残さない
    const u2 = new Universe(false, () => undefined);
    expect(u2.uid).toBe(u1.uid);
  });
});

describe("Universe.rollbackStar（サーバーが断った星の取り消し）", () => {
  it("幽霊から復活した星が断られたら、星を消して幽霊に戻す（unstar は送らない）", () => {
    const { u, dispatch, sent } = setup();
    dispatch(welcome());
    const s = u.placeStar(0.3, 0.3, 2);
    if (!s) throw new Error("星が置けない");
    u.deleteStar(s);
    const g = u.ghosts.get(s.id);
    if (!g) throw new Error("ghost が無い");
    u.reviveGhost(g);
    expect(u.ghosts.has(s.id)).toBe(false);
    sent.length = 0;
    dispatch({ t: "reject", kind: "star", id: s.id });
    expect(u.stars.has(s.id)).toBe(false);
    expect(u.ghosts.get(s.id)).toMatchObject({ x: g.x, y: g.y, c: g.c });
    expect(sent).toEqual([]);
  });

  it("復活から 30 秒より後の reject では幽霊に戻さない（記録は期限切れ）", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const { u, dispatch } = setup();
      dispatch(welcome());
      const s = u.placeStar(0.3, 0.3, 2);
      if (!s) throw new Error("星が置けない");
      u.deleteStar(s);
      const g = u.ghosts.get(s.id);
      if (!g) throw new Error("ghost が無い");
      u.reviveGhost(g);
      vi.setSystemTime(1_031_000);
      dispatch({ t: "reject", kind: "star", id: s.id });
      expect(u.stars.has(s.id)).toBe(false);
      expect(u.ghosts.has(s.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("置いてすぐ消した星が断られたら、残った幽霊も消す（サーバーには最初から無い）", () => {
    const { u, dispatch } = setup();
    dispatch(welcome());
    const s = u.placeStar(0.3, 0.3, 2);
    if (!s) throw new Error("星が置けない");
    u.deleteStar(s);
    expect(u.ghosts.has(s.id)).toBe(true);
    dispatch({ t: "reject", kind: "star", id: s.id });
    expect(u.ghosts.has(s.id)).toBe(false);
  });

  it("同じ id の星が他人のもの（id の衝突）なら、その星は消さない", () => {
    const { u, dispatch } = setup();
    dispatch(welcome({ stars: [star("dup", "someone"), star("x", "someone")] }));
    u.addLink("dup", "x");
    dispatch({ t: "reject", kind: "star", id: "dup" });
    expect(u.stars.has("dup")).toBe(true);
    expect(u.links.size).toBe(1);
  });
});

describe("welcome での自分の星", () => {
  it("前の空にあって新しい空に無い自分の星（寿命内）は幽霊になる。他人の星・寿命切れの星はならない", () => {
    const { u, dispatch } = setup();
    dispatch(welcome());
    const now = Date.now();
    u.stars.set("mine-alive", { ...star("mine-alive", ME), ts: now });
    u.stars.set("mine-kept", { ...star("mine-kept", ME), ts: now });
    u.stars.set("mine-old", { ...star("mine-old", ME), ts: 0 });
    u.stars.set("theirs", { ...star("theirs", "someone"), ts: now });
    dispatch(welcome({ stars: [{ ...star("mine-kept", ME), ts: now }] }));
    expect(u.ghosts.has("mine-alive")).toBe(true);
    expect(u.ghosts.has("mine-kept")).toBe(false);
    expect(u.ghosts.has("mine-old")).toBe(false);
    expect(u.ghosts.has("theirs")).toBe(false);
    expect(JSON.stringify(store.get("uchu-ghosts"))).toContain("mine-alive"); // 保存もする
  });
});
