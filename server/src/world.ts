// 世界の状態（星・線）とルール。Cloudflare にも通信にも依存しない純粋なクラス。
// 戻り値で「何が起きたか」を返し、配信・永続化は呼び出し側（room.ts）が行う。
// 依存がないので、単体テストで挙動を確かめられる（tests/world.test.ts）。

import { OWNER_ID_PATTERN } from "../../shared/limits";
import type { LinkData, StarData } from "../../shared/protocol";
import { CROWD_R, STAR_TTL, ttlFor } from "../../shared/rules";
import { LIMITS } from "./config";
import { crowdCounts } from "./spatial";

// 保存先（storage）のレコードの版。形式を変えたら上げる。load は違う版のレコードを全部捨てる
const STORE_VERSION = 2;

// 保存先の星。配る StarData に、サーバーだけが使う情報を足したもの（ハイバネート・再起動で失わないように保存する）
// - born: 作成時刻（ms）。きらめきで延ばせる寿命の上限に使う
export type StoredStar = StarData & { born: number; v: typeof STORE_VERSION };
export type StoredLink = LinkData & { v: typeof STORE_VERSION };

// 永続化すべき変更。キーは `s:<id>`（星）/ `l:<id>`（線）
export interface StorageChanges {
  put: Record<string, StoredStar | StoredLink>;
  del: string[];
}

export interface PruneResult {
  stars: string[]; // 寿命で消えた星
  links: string[]; // 消えた線（星の消滅に巻き込まれたものを含む）
}

const starKey = (id: string) => `s:${id}`;
const linkKey = (id: string) => `l:${id}`;

// クライアントへ配る形（保存専用の born / v を除く）
export function toWire(s: StoredStar): StarData {
  return { id: s.id, x: s.x, y: s.y, c: s.c, by: s.by, ts: s.ts };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";

// 今の版で、形が正しく、持ち主が持ち主 ID の形式の星か（旧形式・生の uid が混ざったものは false）
function isStoredStar(v: unknown): v is StoredStar {
  return (
    isRecord(v) &&
    v.v === STORE_VERSION &&
    isStr(v.id) &&
    isNum(v.x) &&
    isNum(v.y) &&
    isNum(v.c) &&
    isStr(v.by) &&
    OWNER_ID_PATTERN.test(v.by) &&
    isNum(v.ts) &&
    isNum(v.born)
  );
}

function isStoredLink(v: unknown): v is StoredLink {
  return (
    isRecord(v) &&
    v.v === STORE_VERSION &&
    isStr(v.id) &&
    isStr(v.a) &&
    isStr(v.b) &&
    isStr(v.by) &&
    OWNER_ID_PATTERN.test(v.by) &&
    isNum(v.ts)
  );
}

export class World {
  readonly stars = new Map<string, StoredStar>(); // 配るときは toWire / snapshot を通す
  readonly links = new Map<string, LinkData>();

  private starsByOwner = new Map<string, number>();
  private linksByOwner = new Map<string, number>();
  private linksByStar = new Map<string, Set<string>>(); // 星 → その星につながる線
  private dirtyPut = new Set<string>();
  private dirtyDel = new Set<string>();
  private lastPrune = 0;

  // --- 星 ---

  // 星を置く。上限超え・他人の星の上書きは null。戻り値は配る形（toWire 済み）。
  // 持ち主が同じ id で置き直したときは位置・色だけを変え、born と ts（寿命）は据え置く。
  // 幽霊の復活は、星が一度消えたあとなので新しい星として扱う（born / ts は今）。
  placeStar(owner: string, id: string, x: number, y: number, c: number, now: number): StarData | null {
    const existing = this.stars.get(id);
    if (existing) {
      if (existing.by !== owner) return null; // 他人の星は上書きできない
      const moved: StoredStar = { ...existing, x, y, c };
      this.stars.set(id, moved);
      this.markPut(starKey(id));
      return toWire(moved);
    }
    if (this.stars.size >= LIMITS.maxStars || (this.starsByOwner.get(owner) ?? 0) >= LIMITS.maxStarsPerUser)
      return null;
    const star: StoredStar = { id, x, y, c, by: owner, ts: now, born: now, v: STORE_VERSION };
    this.putStar(star);
    return toWire(star);
  }

  // 星を消す。つながっていた線の id も返す
  removeStar(id: string): { star: StarData; links: string[] } | null {
    const star = this.stars.get(id);
    if (!star) return null; // 誰でも消せる。持ち主は幽霊から復活できる
    const links = this.deleteStar(star);
    return { star: toWire(star), links };
  }

  // きらめき＝寿命のリセット。次のときは何もしない（延ばさず・保存せず・配らない）で null:
  // - 作成（born）から maxStarAgeMs を過ぎた
  // - 星の ts（作成・前回のきらめきのうち新しい方）から admireMinIntervalMs 経っていない（星ごとの全体の間隔）
  admire(id: string, now: number): StarData | null {
    const star = this.stars.get(id);
    if (!star) return null;
    if (now - star.born > LIMITS.maxStarAgeMs) return null;
    if (now - star.ts < LIMITS.admireMinIntervalMs) return null;
    star.ts = now;
    this.markPut(starKey(id));
    return toWire(star);
  }

  // 配る形の全体（welcome 用）
  snapshot(): { stars: StarData[]; links: LinkData[] } {
    return { stars: [...this.stars.values()].map(toWire), links: [...this.links.values()] };
  }

  // --- 線 ---

  addLink(owner: string, id: string, a: string, b: string, now: number): LinkData | null {
    if (a === b || !this.stars.has(a) || !this.stars.has(b)) return null;
    if (this.links.has(id)) return null;
    // 同じ2点を結ぶ線は1本だけ
    for (const lid of this.linksByStar.get(a) ?? []) {
      const l = this.links.get(lid);
      if (l && ((l.a === a && l.b === b) || (l.a === b && l.b === a))) return null;
    }
    if (this.links.size >= LIMITS.maxLinks || (this.linksByOwner.get(owner) ?? 0) >= LIMITS.maxLinksPerUser)
      return null;

    const link: LinkData = { id, a, b, by: owner, ts: now };
    this.putLink(link);
    return link;
  }

  // 線は持ち主だけが消せる
  removeLink(id: string, owner: string): boolean {
    const link = this.links.get(id);
    if (!link || link.by !== owner) return false;
    this.deleteLink(link);
    return true;
  }

  // --- 寿命 ---

  // 周囲の密集度で決まる寿命を過ぎた星と、それにつながる線を消す。
  // 連打されても重くならないよう、minGap より短い間隔では何もしない（force で無視）
  prune(now: number, force = false): PruneResult {
    const result: PruneResult = { stars: [], links: [] };
    if (!force && now - this.lastPrune < LIMITS.pruneMinGapMs) return result;
    this.lastPrune = now;

    const counts = crowdCounts(this.stars.values(), CROWD_R);
    for (const star of [...this.stars.values()]) {
      if (now - star.ts > ttlFor(counts.get(star.id) ?? 0)) {
        result.stars.push(star.id);
        result.links.push(...this.deleteStar(star));
      }
    }
    for (const link of [...this.links.values()]) {
      if (now - link.ts > STAR_TTL) {
        result.links.push(link.id);
        this.deleteLink(link);
      }
    }
    return result;
  }

  // --- 永続化 ---

  // 起動時に保存済みの状態を取り込む（変更扱いにはしない）。entries は storage.list の [鍵, 値]。
  // 次のものは取り込まず、その鍵を保存先からも消す（残すと起動のたびに読んで捨てることになる）:
  // - 版が STORE_VERSION でないレコード（旧形式。生の uid が入っていた時代のものを含めて確実に捨てる）
  // - 形が壊れたもの、持ち主が持ち主 ID の形式でないもの（配信すると uid が漏れる）、鍵と id が合わないもの
  // - 端の星が無い線（上で捨てた星につながる線を含む）
  // 消す鍵は値の id から作らない（値が壊れていても、読んだ鍵そのものを消す）
  load(stars: Iterable<[key: string, value: unknown]>, links: Iterable<[key: string, value: unknown]>) {
    for (const [key, s] of stars) {
      if (isStoredStar(s) && key === starKey(s.id)) this.putStar(s, false);
      else this.markDel(key);
    }
    for (const [key, l] of links) {
      if (isStoredLink(l) && key === linkKey(l.id) && this.stars.has(l.a) && this.stars.has(l.b)) {
        this.putLink({ id: l.id, a: l.a, b: l.b, by: l.by, ts: l.ts }, false);
      } else {
        this.markDel(key);
      }
    }
  }

  // 前回から変わった分だけを返して、変更の記録をリセットする
  drainChanges(): StorageChanges {
    const put: StorageChanges["put"] = {};
    for (const key of this.dirtyPut) {
      const id = key.slice(2);
      if (key.startsWith("s:")) {
        const s = this.stars.get(id);
        if (s) put[key] = { ...s };
      } else {
        const l = this.links.get(id);
        if (l) put[key] = { ...l, v: STORE_VERSION };
      }
    }
    const del = [...this.dirtyDel];
    this.dirtyPut.clear();
    this.dirtyDel.clear();
    return { put, del };
  }

  // --- 内部 ---

  // 新しい星を加える（置き直しは placeStar が直接書き換える）
  private putStar(star: StoredStar, track = true) {
    this.bump(this.starsByOwner, star.by, 1);
    this.stars.set(star.id, star);
    if (track) this.markPut(starKey(star.id));
  }

  private deleteStar(star: StoredStar): string[] {
    const removedLinks: string[] = [];
    for (const lid of [...(this.linksByStar.get(star.id) ?? [])]) {
      const l = this.links.get(lid);
      if (l) {
        this.deleteLink(l);
        removedLinks.push(lid);
      }
    }
    this.linksByStar.delete(star.id);
    this.stars.delete(star.id);
    this.bump(this.starsByOwner, star.by, -1);
    this.markDel(starKey(star.id));
    return removedLinks;
  }

  private putLink(link: LinkData, track = true) {
    this.links.set(link.id, link);
    this.bump(this.linksByOwner, link.by, 1);
    for (const end of [link.a, link.b]) {
      const set = this.linksByStar.get(end);
      if (set) set.add(link.id);
      else this.linksByStar.set(end, new Set([link.id]));
    }
    if (track) this.markPut(linkKey(link.id));
  }

  private deleteLink(link: LinkData) {
    this.links.delete(link.id);
    this.bump(this.linksByOwner, link.by, -1);
    for (const end of [link.a, link.b]) {
      const set = this.linksByStar.get(end);
      if (!set) continue;
      set.delete(link.id);
      if (set.size === 0) this.linksByStar.delete(end); // 空の索引を残さない
    }
    this.markDel(linkKey(link.id));
  }

  private bump(map: Map<string, number>, key: string, delta: number) {
    const n = (map.get(key) ?? 0) + delta;
    if (n > 0) map.set(key, n);
    else map.delete(key);
  }

  private markPut(key: string) {
    this.dirtyDel.delete(key);
    this.dirtyPut.add(key);
  }

  private markDel(key: string) {
    this.dirtyPut.delete(key);
    this.dirtyDel.add(key);
  }
}
