import { describe, expect, it } from "vitest";
import { STAR_TTL } from "../../shared/rules";
import { LIMITS } from "../src/config";
import { World } from "../src/world";

const T0 = 1_000_000;

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
    expect(w.stars.get("s1")!.by).toBe("alice");
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
    expect(w.stars.get("s1")!.ts).toBe(T0 + 1000);
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
    expect(w.removeLink("l1", undefined)).toBe(false);
    expect(w.removeLink("l1", "alice")).toBe(true);
    expect(w.links.size).toBe(0);
  });

  it("星を消すとつながっていた線も消え、その id が返る", () => {
    const w = setup();
    w.addLink("alice", "l1", "a", "b", T0);
    w.addLink("alice", "l2", "b", "c", T0);
    const r = w.removeStar("b")!;
    expect(r.links.sort()).toEqual(["l1", "l2"]);
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

  it("load は変更扱いにならない。存在しない星への線は捨てる", () => {
    const w = new World();
    w.load([{ id: "a", x: 0, y: 0, c: 0, by: "u", ts: T0 }], [{ id: "l1", a: "a", b: "ghost", by: "u", ts: T0 }]);
    expect(w.stars.size).toBe(1);
    expect(w.links.size).toBe(0);
    expect(w.drainChanges()).toEqual({ put: {}, del: [] });
  });

  it("置いて消した星は put に残らない", () => {
    const w = new World();
    w.placeStar("alice", "a", 0, 0, 0, T0);
    w.removeStar("a");
    expect(w.drainChanges()).toEqual({ put: {}, del: ["s:a"] });
  });
});
