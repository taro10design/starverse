import { describe, expect, it } from "vitest";
import { STAR_TTL } from "../../shared/rules";
import { LIMITS } from "../src/config";
import { World } from "../src/world";

const T0 = 1_000_000;
const OWNER = "0123456789abcdef0123456789abcdef"; // 保存済みデータの持ち主 ID（OWNER_ID_PATTERN の形式）

describe("World: 星", () => {
  it("星を置ける", () => {
    const w = new World();
    const s = w.placeStar("alice", "s1", 0.1, 0.2, 3, T0);
    expect(s).toMatchObject({ id: "s1", x: 0.1, y: 0.2, c: 3, by: "alice", ts: T0 });
    expect(w.stars.size).toBe(1);
  });

  it("他人の星は同じ id で上書きできない", () => {
    const w = new World();
    w.placeStar("alice", "s1", 0, 0, 0, T0);
    expect(w.placeStar("mallory", "s1", 9, 9, 0, T0)).toBeNull();
    expect(w.stars.get("s1")?.by).toBe("alice");
  });

  it("持ち主は自分の星を同じ id で置き直せる（幽霊の復活）", () => {
    const w = new World();
    w.placeStar("alice", "s1", 0, 0, 0, T0);
    w.removeStar("s1");
    expect(w.placeStar("alice", "s1", 0, 0, 0, T0 + 1)).not.toBeNull();
  });

  it("1人あたりの上限を超えると置けない", () => {
    const w = new World();
    for (let i = 0; i < LIMITS.maxStarsPerUser; i++) expect(w.placeStar("alice", `a${i}`, i, 0, 0, T0)).not.toBeNull();
    expect(w.placeStar("alice", "over", 0, 0, 0, T0)).toBeNull();
    expect(w.placeStar("bob", "b0", 0, 0, 0, T0)).not.toBeNull(); // 他の人は置ける
  });

  it("全体の上限を超えると置けない", () => {
    const w = new World();
    for (let i = 0; i < LIMITS.maxStars; i++) w.placeStar(`u${i}`, `s${i}`, i, 0, 0, T0);
    expect(w.placeStar("late", "x", 0, 0, 0, T0)).toBeNull();
  });

  it("消すと持ち主の枠が空く", () => {
    const w = new World();
    for (let i = 0; i < LIMITS.maxStarsPerUser; i++) w.placeStar("alice", `a${i}`, i, 0, 0, T0);
    w.removeStar("a0");
    expect(w.placeStar("alice", "again", 0, 0, 0, T0)).not.toBeNull();
  });

  it("きらめきで寿命がリセットされる", () => {
    const w = new World();
    w.placeStar("alice", "s1", 0, 0, 0, T0);
    w.admire("s1", T0 + 1000);
    expect(w.stars.get("s1")?.ts).toBe(T0 + 1000);
    expect(w.admire("nope", T0)).toBeNull();
  });
});

describe("World: 線", () => {
  const setup = () => {
    const w = new World();
    w.placeStar("alice", "a", 0, 0, 0, T0);
    w.placeStar("alice", "b", 1, 1, 0, T0);
    w.placeStar("alice", "c", 2, 2, 0, T0);
    return w;
  };

  it("2つの星を結べる。存在しない星・同じ星は不可", () => {
    const w = setup();
    expect(w.addLink("alice", "l1", "a", "b", T0)).not.toBeNull();
    expect(w.addLink("alice", "l2", "a", "zzz", T0)).toBeNull();
    expect(w.addLink("alice", "l3", "a", "a", T0)).toBeNull();
  });

  it("同じ2点を結ぶ線は1本だけ（向きが逆でも）", () => {
    const w = setup();
    w.addLink("alice", "l1", "a", "b", T0);
    expect(w.addLink("bob", "l2", "b", "a", T0)).toBeNull();
    expect(w.addLink("bob", "l3", "a", "c", T0)).not.toBeNull();
  });

  it("線は持ち主だけが消せる", () => {
    const w = setup();
    w.addLink("alice", "l1", "a", "b", T0);
    expect(w.removeLink("l1", "mallory")).toBe(false);
    expect(w.removeLink("l1", "alice")).toBe(true);
    expect(w.links.size).toBe(0);
  });

  it("星を消して同じ id で置き直しても、古い線は付いてこない", () => {
    const w = setup();
    w.addLink("alice", "l1", "a", "b", T0);
    w.removeStar("a");
    w.placeStar("alice", "a", 0, 0, 0, T0);
    expect(w.removeStar("a")?.links).toEqual([]);
    expect(w.removeStar("b")?.links).toEqual([]);
  });

  it("線を消したあとに同じ 2 点を結び直せる", () => {
    const w = setup();
    w.addLink("alice", "l1", "a", "b", T0);
    w.removeLink("l1", "alice");
    expect(w.addLink("alice", "l2", "b", "a", T0)).not.toBeNull();
  });

  it("星を消すとつながっていた線も消え、その id が返る", () => {
    const w = setup();
    w.addLink("alice", "l1", "a", "b", T0);
    w.addLink("alice", "l2", "b", "c", T0);
    const r = w.removeStar("b");
    expect(r?.links.sort()).toEqual(["l1", "l2"]);
    expect(w.links.size).toBe(0);
  });
});

describe("World: 寿命（prune）", () => {
  it("孤立した星は STAR_TTL まで生きる", () => {
    const w = new World();
    w.placeStar("alice", "s1", 0, 0, 0, T0);
    expect(w.prune(T0 + STAR_TTL - 1, true).stars).toEqual([]);
    expect(w.prune(T0 + STAR_TTL + 1, true).stars).toEqual(["s1"]);
  });

  it("密集した星は1分で消える（スパム対策）", () => {
    const w = new World();
    for (let i = 0; i < 10; i++) w.placeStar("spam", `s${i}`, 0.5 + i * 0.001, 0.5, 0, T0);
    w.placeStar("far", "lonely", 5, 5, 0, T0);
    const r = w.prune(T0 + 61_000, true);
    expect(r.stars).toHaveLength(10);
    expect(r.stars).not.toContain("lonely");
    expect(w.stars.has("lonely")).toBe(true);
  });

  it("消えた星につながる線も消える", () => {
    const w = new World();
    for (let i = 0; i < 10; i++) w.placeStar("spam", `s${i}`, 0.5 + i * 0.001, 0.5, 0, T0);
    w.addLink("spam", "l1", "s0", "s1", T0);
    const r = w.prune(T0 + 61_000, true);
    expect(r.links).toContain("l1");
    expect(w.links.size).toBe(0);
  });

  it("連打しても pruneMinGap 内では再計算しない", () => {
    const w = new World();
    w.placeStar("alice", "s1", 0, 0, 0, T0);
    w.prune(T0 + STAR_TTL + 10); // 1回目（実行）
    w.placeStar("alice", "s2", 0, 0, 0, T0);
    expect(w.prune(T0 + STAR_TTL + 20).stars).toEqual([]); // 直後は何もしない
    expect(w.prune(T0 + STAR_TTL + 20, true).stars).toEqual(["s2"]); // force なら実行
  });
});

describe("World: 同じ接続元（IP）が置ける星の合計", () => {
  it("同じ接続元の星は、持ち主が違っても合わせて maxStarsPerIp まで", () => {
    const w = new World();
    for (let i = 0; i < LIMITS.maxStarsPerIp; i++) {
      const owner = `owner${i % 4}`; // 4 人の持ち主に分けても
      expect(w.placeStar(owner, `s${i}`, i, 0, 0, T0, "ipA")).not.toBeNull();
    }
    expect(w.placeStar("owner9", "over", 0, 0, 0, T0, "ipA")).toBeNull();
    expect(w.placeStar("owner9", "other", 0, 0, 0, T0, "ipB")).not.toBeNull(); // 別の接続元は置ける
    expect(w.placeStar("owner9", "local", 0, 0, 0, T0, null)).not.toBeNull(); // 接続元が分からないときは数えない
  });

  it("星が消えると（消す・寿命）、その接続元の枠が空く", () => {
    const w = new World();
    for (let i = 0; i < LIMITS.maxStarsPerIp; i++) w.placeStar(`o${i % 4}`, `s${i}`, i, 0, 0, T0, "ipA");
    w.removeStar("s0");
    expect(w.placeStar("o0", "again", 0, 0, 0, T0, "ipA")).not.toBeNull();
    expect(w.placeStar("o0", "again2", 0, 0, 0, T0, "ipA")).toBeNull();
    w.prune(T0 + STAR_TTL + 1, true); // 全部寿命で消える
    expect(w.placeStar("o0", "fresh", 0, 0, 0, T0 + STAR_TTL + 2, "ipA")).not.toBeNull();
  });

  it("自分の星の置き直しは、新しい星として数えない", () => {
    const w = new World();
    for (let i = 0; i < LIMITS.maxStarsPerIp; i++) w.placeStar(`o${i % 4}`, `s${i}`, i, 0, 0, T0, "ipA");
    expect(w.placeStar("o0", "s0", 5, 5, 1, T0 + 1, "ipA")).not.toBeNull();
  });
});

describe("World: きらめきで延びる寿命の上限", () => {
  it("作成から maxStarAgeMs を過ぎた星は、きらめいても寿命が延びない", () => {
    const w = new World();
    w.placeStar("alice", "s1", 0, 0, 0, T0);
    expect(w.admire("s1", T0 + LIMITS.maxStarAgeMs - 1)?.ts).toBe(T0 + LIMITS.maxStarAgeMs - 1);
    expect(w.admire("s1", T0 + LIMITS.maxStarAgeMs + 1)).toBeNull();
    expect(w.stars.get("s1")?.ts).toBe(T0 + LIMITS.maxStarAgeMs - 1);
  });

  it("持ち主の置き直しでは作成時刻を変えない（置き直しで上限を逃れられない）", () => {
    const w = new World();
    w.placeStar("alice", "s1", 0, 0, 0, T0);
    w.placeStar("alice", "s1", 1, 1, 0, T0 + 1000);
    expect(w.admire("s1", T0 + LIMITS.maxStarAgeMs + 1)).toBeNull();
  });

  it("読み込んだ星は、作成時刻が分からないので読み込んだ時刻から数える", () => {
    const w = new World();
    const LOAD = T0 + 5 * LIMITS.maxStarAgeMs;
    w.load([{ id: "a", x: 0, y: 0, c: 0, by: OWNER, ts: T0 }], [], LOAD);
    expect(w.admire("a", LOAD + LIMITS.maxStarAgeMs - 1)).not.toBeNull();
    expect(w.admire("a", LOAD + LIMITS.maxStarAgeMs + 1)).toBeNull();
  });
});

describe("World: 永続化", () => {
  it("変更分だけを返し、取り出すとリセットされる", () => {
    const w = new World();
    w.placeStar("alice", "a", 0, 0, 0, T0);
    w.placeStar("alice", "b", 1, 1, 0, T0);
    const first = w.drainChanges();
    expect(Object.keys(first.put).sort()).toEqual(["s:a", "s:b"]);
    expect(w.drainChanges()).toEqual({ put: {}, del: [] });

    w.removeStar("a");
    expect(w.drainChanges()).toEqual({ put: {}, del: ["s:a"] });
  });

  it("load は変更扱いにならない", () => {
    const w = new World();
    w.load(
      [
        { id: "a", x: 0, y: 0, c: 0, by: OWNER, ts: T0 },
        { id: "b", x: 1, y: 1, c: 0, by: OWNER, ts: T0 },
      ],
      [{ id: "l1", a: "a", b: "b", by: OWNER, ts: T0 }],
      T0,
    );
    expect(w.stars.size).toBe(2);
    expect(w.links.size).toBe(1);
    expect(w.drainChanges()).toEqual({ put: {}, del: [] });
  });

  it("load で端点の無い線は捨て、保存先からも消す", () => {
    const w = new World();
    w.load(
      [{ id: "a", x: 0, y: 0, c: 0, by: OWNER, ts: T0 }],
      [{ id: "l1", a: "a", b: "ghost", by: OWNER, ts: T0 }],
      T0,
    );
    expect(w.stars.size).toBe(1);
    expect(w.links.size).toBe(0);
    expect(w.drainChanges()).toEqual({ put: {}, del: ["l:l1"] });
  });

  it("load で、持ち主が持ち主 ID の形式でない（旧形式の生の uid の）星・線は捨て、保存先からも消す", () => {
    const RAW_UID = "abcdef12-3456-7890-abcd-ef1234567890"; // 旧プロトコルでは by に uid そのものが入っていた
    const w = new World();
    w.load(
      [
        { id: "old", x: 0, y: 0, c: 0, by: RAW_UID, ts: T0 },
        { id: "new", x: 1, y: 1, c: 0, by: OWNER, ts: T0 },
        { id: "new2", x: 2, y: 2, c: 0, by: OWNER, ts: T0 },
      ],
      [
        { id: "l-old-end", a: "old", b: "new", by: OWNER, ts: T0 }, // 端の星が捨てられたので一緒に捨てる
        { id: "l-old-by", a: "new", b: "new2", by: RAW_UID, ts: T0 }, // 線の持ち主が旧形式
        { id: "l-ok", a: "new2", b: "new", by: OWNER, ts: T0 },
      ],
      T0,
    );
    expect([...w.stars.keys()].sort()).toEqual(["new", "new2"]);
    expect([...w.links.keys()]).toEqual(["l-ok"]);
    expect([...w.stars.values(), ...w.links.values()].some((v) => v.by === RAW_UID)).toBe(false);
    const changes = w.drainChanges();
    expect(changes.put).toEqual({});
    expect(changes.del.sort()).toEqual(["l:l-old-by", "l:l-old-end", "s:old"]);
  });

  it("load で、大文字や長さ違いの持ち主も旧形式として捨てる", () => {
    const w = new World();
    w.load(
      [
        { id: "upper", x: 0, y: 0, c: 0, by: OWNER.toUpperCase(), ts: T0 },
        { id: "short", x: 0, y: 0, c: 0, by: OWNER.slice(1), ts: T0 },
        { id: "long", x: 0, y: 0, c: 0, by: OWNER + "0", ts: T0 },
      ],
      [],
      T0,
    );
    expect(w.stars.size).toBe(0);
    expect(w.drainChanges().del.sort()).toEqual(["s:long", "s:short", "s:upper"]);
  });

  it("load で捨てた星は持ち主の枠を使わない", () => {
    const w = new World();
    const old = Array.from({ length: LIMITS.maxStars }, (_, i) => ({
      id: `o${i}`,
      x: i,
      y: 0,
      c: 0,
      by: `legacy-uid-${i}`,
      ts: T0,
    }));
    w.load(old, [], T0);
    expect(w.placeStar(OWNER, "fresh", 0, 0, 0, T0)).not.toBeNull(); // 全体の上限にも数えない
  });

  it("load で捨てた線は持ち主の枠を使わない", () => {
    const w = new World();
    const ghosts = Array.from({ length: LIMITS.maxLinksPerUser }, (_, i) => ({
      id: `g${i}`,
      a: "a",
      b: `ghost${i}`,
      by: OWNER,
      ts: T0,
    }));
    w.load(
      [
        { id: "a", x: 0, y: 0, c: 0, by: OWNER, ts: T0 },
        { id: "b", x: 1, y: 1, c: 0, by: OWNER, ts: T0 },
      ],
      ghosts,
      T0,
    );
    expect(w.addLink(OWNER, "l1", "a", "b", T0)).not.toBeNull();
  });

  it("置いて消した星は put に残らない", () => {
    const w = new World();
    w.placeStar("alice", "a", 0, 0, 0, T0);
    w.removeStar("a");
    expect(w.drainChanges()).toEqual({ put: {}, del: ["s:a"] });
  });
});
