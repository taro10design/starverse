import { describe, expect, it } from "vitest";
import { STAR_TTL } from "../../shared/rules";
import { LIMITS } from "../src/config";
import { World, type StoredLink, type StoredStar } from "../src/world";

const T0 = 1_000_000;
const OWNER = "0123456789abcdef0123456789abcdef"; // 保存済みデータの持ち主 ID（OWNER_ID_PATTERN の形式）

// 保存先のレコード（storage.list が返す [鍵, 値] の形）
const sRec = (id: string, extra: Partial<StoredStar> = {}): [string, StoredStar] => [
  `s:${id}`,
  { id, x: 0, y: 0, c: 0, by: OWNER, ts: T0, born: T0, origin: "", v: 2, ...extra },
];
const lRec = (id: string, a: string, b: string, extra: Partial<StoredLink> = {}): [string, StoredLink] => [
  `l:${id}`,
  { id, a, b, by: OWNER, ts: T0, v: 2, ...extra },
];

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
    const at = T0 + LIMITS.admireMinIntervalMs;
    expect(w.admire("s1", at)).toEqual({ id: "s1", x: 0, y: 0, c: 0, by: "alice", ts: at });
    expect(w.stars.get("s1")?.ts).toBe(at);
    expect(w.admire("nope", at)).toBeNull();
  });

  it("配る星（戻り値・snapshot）には保存専用の born / origin / v が入らない", () => {
    const w = new World();
    const s = w.placeStar("alice", "s1", 0, 0, 0, T0, "ipA");
    expect(s).toEqual({ id: "s1", x: 0, y: 0, c: 0, by: "alice", ts: T0 });
    w.placeStar("alice", "s2", 1, 1, 0, T0);
    w.addLink("alice", "l1", "s1", "s2", T0);
    const snap = w.snapshot();
    expect(snap.stars).toHaveLength(2);
    expect(snap.links).toHaveLength(1);
    for (const st of snap.stars) expect(Object.keys(st).sort()).toEqual(["by", "c", "id", "ts", "x", "y"]);
    for (const l of snap.links) expect(Object.keys(l).sort()).toEqual(["a", "b", "by", "id", "ts"]);
  });

  it("持ち主の置き直しは位置・色だけ変え、born と ts は据え置く", () => {
    const w = new World();
    w.placeStar("alice", "s1", 0, 0, 0, T0, "ipA");
    w.admire("s1", T0 + LIMITS.admireMinIntervalMs);
    w.drainChanges();
    const again = w.placeStar("alice", "s1", 5, 6, 2, T0 + LIMITS.admireMinIntervalMs + 5000, "ipB");
    expect(again).toEqual({ id: "s1", x: 5, y: 6, c: 2, by: "alice", ts: T0 + LIMITS.admireMinIntervalMs });
    expect(w.drainChanges().put["s:s1"]).toEqual({
      id: "s1",
      x: 5,
      y: 6,
      c: 2,
      by: "alice",
      ts: T0 + LIMITS.admireMinIntervalMs,
      born: T0,
      origin: "ipA",
      v: 2,
    });
  });

  it("幽霊の復活（消えたあとの置き直し）は新しい星として born / ts を今にする", () => {
    const w = new World();
    w.placeStar("alice", "s1", 0, 0, 0, T0);
    w.removeStar("s1");
    const later = T0 + 10 * 60_000;
    expect(w.placeStar("alice", "s1", 0, 0, 0, later)?.ts).toBe(later);
    expect(w.drainChanges().put["s:s1"]).toMatchObject({ born: later, ts: later });
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

  it("数えるのは直近 ipStarWindowMs に置いた星だけ（それより前の星は残っていても数えない）", () => {
    const w = new World();
    for (let i = 0; i < LIMITS.maxStarsPerIp; i++) w.placeStar(`o${i % 4}`, `s${i}`, i, 0, 0, T0, "ipA");
    expect(w.placeStar("o0", "over", 0, 1, 0, T0 + LIMITS.ipStarWindowMs - 1, "ipA")).toBeNull();
    expect(w.placeStar("o0", "later", 0, 1, 0, T0 + LIMITS.ipStarWindowMs, "ipA")).not.toBeNull();
    expect(w.stars.has("s0")).toBe(true); // 古い星は消さない（数えないだけ）
  });

  it("読み込んだ星も、保存された origin と born で数える（再起動で枠が戻らない）", () => {
    const w = new World();
    const owner = (i: number) => OWNER.slice(0, 31) + String(i % 4); // 持ち主ごとの上限に掛からないよう 4 人に分ける
    const recs = Array.from({ length: LIMITS.maxStarsPerIp }, (_, i) =>
      sRec(`s${i}`, { x: i, by: owner(i), origin: "ipA" }),
    );
    w.load(recs, []);
    expect(w.stars.size).toBe(LIMITS.maxStarsPerIp);
    const fresh = "f".repeat(32);
    expect(w.placeStar(fresh, "over", 0, 1, 0, T0 + 1, "ipA")).toBeNull();
    expect(w.placeStar(fresh, "other", 0, 1, 0, T0 + 1, "ipB")).not.toBeNull();
  });

  it("置いた星には born と origin を保存する（接続元が分からなければ空文字）", () => {
    const w = new World();
    w.placeStar("alice", "a", 0, 0, 0, T0, "ipA");
    w.placeStar("alice", "b", 0, 0, 0, T0 + 1);
    const put = w.drainChanges().put;
    expect(put["s:a"]).toEqual({ id: "a", x: 0, y: 0, c: 0, by: "alice", ts: T0, born: T0, origin: "ipA", v: 2 });
    expect(put["s:b"]).toMatchObject({ born: T0 + 1, origin: "", v: 2 });
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
    expect(w.admire("s1", T0 + LIMITS.maxStarAgeMs + LIMITS.admireMinIntervalMs)).toBeNull();
    expect(w.stars.get("s1")?.ts).toBe(T0 + LIMITS.maxStarAgeMs - 1);
  });

  it("星の ts（作成・前回のきらめき）から admireMinIntervalMs の間は、誰がきらめいても延びない", () => {
    const w = new World();
    w.placeStar("alice", "s1", 0, 0, 0, T0);
    w.drainChanges();
    expect(w.admire("s1", T0 + LIMITS.admireMinIntervalMs - 1)).toBeNull(); // 作成から間もない
    expect(w.drainChanges()).toEqual({ put: {}, del: [] }); // 断ったきらめきは保存しない
    const first = T0 + LIMITS.admireMinIntervalMs;
    expect(w.admire("s1", first)?.ts).toBe(first);
    w.drainChanges();
    expect(w.admire("s1", first + LIMITS.admireMinIntervalMs - 1)).toBeNull();
    expect(w.stars.get("s1")?.ts).toBe(first);
    expect(w.drainChanges()).toEqual({ put: {}, del: [] });
    expect(w.admire("s1", first + LIMITS.admireMinIntervalMs)?.ts).toBe(first + LIMITS.admireMinIntervalMs);
  });

  it("持ち主の置き直しでは作成時刻を変えない（置き直しで上限を逃れられない）", () => {
    const w = new World();
    w.placeStar("alice", "s1", 0, 0, 0, T0);
    w.placeStar("alice", "s1", 1, 1, 0, T0 + 1000);
    expect(w.admire("s1", T0 + LIMITS.maxStarAgeMs + 1)).toBeNull();
  });

  it("読み込んだ星も、保存された born から数える（再起動で上限が延びない）", () => {
    const ts = T0 + LIMITS.maxStarAgeMs - LIMITS.admireMinIntervalMs;
    const w1 = new World();
    w1.load([sRec("a", { born: T0, ts })], []);
    expect(w1.admire("a", T0 + LIMITS.maxStarAgeMs)).not.toBeNull();
    const w2 = new World();
    w2.load([sRec("a", { born: T0, ts })], []);
    expect(w2.admire("a", T0 + LIMITS.maxStarAgeMs + 1)).toBeNull();
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
    w.load([sRec("a"), sRec("b", { x: 1, y: 1 })], [lRec("l1", "a", "b")]);
    expect(w.stars.size).toBe(2);
    expect(w.links.size).toBe(1);
    expect(w.drainChanges()).toEqual({ put: {}, del: [] });
  });

  it("線も v: 2 をつけて保存する", () => {
    const w = new World();
    w.load([sRec("a"), sRec("b")], []);
    w.addLink(OWNER, "l1", "a", "b", T0);
    expect(w.drainChanges().put["l:l1"]).toEqual({ id: "l1", a: "a", b: "b", by: OWNER, ts: T0, v: 2 });
  });

  it("load で端点の無い線は捨て、保存先からも消す", () => {
    const w = new World();
    w.load([sRec("a")], [lRec("l1", "a", "ghost")]);
    expect(w.stars.size).toBe(1);
    expect(w.links.size).toBe(0);
    expect(w.drainChanges()).toEqual({ put: {}, del: ["l:l1"] });
  });

  it("load で、版が 2 でない（旧形式の）星・線は全部捨て、保存先からも消す", () => {
    const w = new World();
    const legacyStar: [string, unknown] = ["s:old", { id: "old", x: 0, y: 0, c: 0, by: OWNER, ts: T0 }];
    const v1Star: [string, unknown] = ["s:v1", { ...sRec("v1")[1], v: 1 }];
    const legacyLink: [string, unknown] = ["l:lold", { id: "lold", a: "a", b: "b", by: OWNER, ts: T0 }];
    w.load([legacyStar, v1Star, sRec("a"), sRec("b")], [legacyLink, lRec("ok", "a", "b")]);
    expect([...w.stars.keys()].sort()).toEqual(["a", "b"]);
    expect([...w.links.keys()]).toEqual(["ok"]);
    expect(w.drainChanges().del.sort()).toEqual(["l:lold", "s:old", "s:v1"]);
  });

  it("load で、形の壊れたレコードは捨てる", () => {
    const w = new World();
    w.load(
      [
        ["s:null", null],
        ["s:str", "x"],
        ["s:nox", { ...sRec("nox")[1], x: "0" }],
        ["s:noborn", { ...sRec("noborn")[1], born: undefined }],
      ],
      [["l:bad", { id: "bad", a: 1, b: "b", by: OWNER, ts: T0, v: 2 }]],
    );
    expect(w.stars.size).toBe(0);
    expect(w.links.size).toBe(0);
    expect(w.drainChanges().del.sort()).toEqual(["l:bad", "s:noborn", "s:nox", "s:null", "s:str"]);
  });

  it("load で捨てるときは、保存先の鍵をそのまま消す（値の id から鍵を作らない）", () => {
    const w = new World();
    w.load([["s:key-a", { ...sRec("value-a")[1], by: "raw-uid" }]], [["l:key-l", lRec("value-l", "x", "y")[1]]]);
    expect(w.drainChanges().del.sort()).toEqual(["l:key-l", "s:key-a"]);
  });

  it("load で、持ち主が持ち主 ID の形式でない（生の uid の）星・線は捨て、保存先からも消す", () => {
    const RAW_UID = "abcdef12-3456-7890-abcd-ef1234567890"; // 旧プロトコルでは by に uid そのものが入っていた
    const w = new World();
    w.load(
      [sRec("old", { by: RAW_UID }), sRec("new", { x: 1, y: 1 }), sRec("new2", { x: 2, y: 2 })],
      [
        lRec("l-old-end", "old", "new"), // 端の星が捨てられたので一緒に捨てる
        lRec("l-old-by", "new", "new2", { by: RAW_UID }), // 線の持ち主が旧形式
        lRec("l-ok", "new2", "new"),
      ],
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
        sRec("upper", { by: OWNER.toUpperCase() }),
        sRec("short", { by: OWNER.slice(1) }),
        sRec("long", { by: OWNER + "0" }),
      ],
      [],
    );
    expect(w.stars.size).toBe(0);
    expect(w.drainChanges().del.sort()).toEqual(["s:long", "s:short", "s:upper"]);
  });

  it("load で捨てた星は持ち主の枠を使わない", () => {
    const w = new World();
    const old = Array.from({ length: LIMITS.maxStars }, (_, i) => sRec(`o${i}`, { x: i, by: `legacy-uid-${i}` }));
    w.load(old, []);
    expect(w.placeStar(OWNER, "fresh", 0, 0, 0, T0)).not.toBeNull(); // 全体の上限にも数えない
  });

  it("load で捨てた線は持ち主の枠を使わない", () => {
    const w = new World();
    const ghosts = Array.from({ length: LIMITS.maxLinksPerUser }, (_, i) => lRec(`g${i}`, "a", `ghost${i}`));
    w.load([sRec("a"), sRec("b", { x: 1, y: 1 })], ghosts);
    expect(w.addLink(OWNER, "l1", "a", "b", T0)).not.toBeNull();
  });

  it("置いて消した星は put に残らない", () => {
    const w = new World();
    w.placeStar("alice", "a", 0, 0, 0, T0);
    w.removeStar("a");
    expect(w.drainChanges()).toEqual({ put: {}, del: ["s:a"] });
  });
});
