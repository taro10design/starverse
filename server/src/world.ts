// 世界の状態（星・線）とルール。Cloudflare にも通信にも依存しない純粋なクラス。
// 戻り値で「何が起きたか」を返し、配信・永続化は呼び出し側（room.ts）が行う。
// 依存がないので、単体テストで挙動を確かめられる（tests/world.test.ts）。

import { OWNER_ID_PATTERN } from "../../shared/limits";
import type { LinkData, StarData } from "../../shared/protocol";
import { CROWD_R, STAR_TTL, ttlFor } from "../../shared/rules";
import { LIMITS } from "./config";
import { crowdCounts } from "./spatial";

// 永続化すべき変更。キーは `s:<id>`（星）/ `l:<id>`（線）
export interface StorageChanges {
  put: Record<string, StarData | LinkData>;
  del: string[];
}

export interface PruneResult {
  stars: string[]; // 寿命で消えた星
  links: string[]; // 消えた線（星の消滅に巻き込まれたものを含む）
}

const starKey = (id: string) => `s:${id}`;
const linkKey = (id: string) => `l:${id}`;

export class World {
  readonly stars = new Map<string, StarData>();
  readonly links = new Map<string, LinkData>();

  private starsByOwner = new Map<string, number>();
  private linksByOwner = new Map<string, number>();
  private linksByStar = new Map<string, Set<string>>(); // 星 → その星につながる線
  // 以下はメモリ上だけの情報（保存しない。StarData を変えないため）。起動し直すと load の時点からになる
  private createdAt = new Map<string, number>(); // 星 → 作成時刻（きらめきで延ばせる寿命の上限に使う）
  private originOf = new Map<string, string>(); // 星 → 置いた接続元の鍵
  private starsByOrigin = new Map<string, number>(); // 接続元の鍵 → 星の数
  private dirtyPut = new Set<string>();
  private dirtyDel = new Set<string>();
  private lastPrune = 0;

  // --- 星 ---

  // 星を置く。上限超え・他人の星の上書きは null。
  // origin は置いた接続元の鍵（同じ接続元の星を合わせて数える）。分からなければ null で、数えない
  placeStar(
    owner: string,
    id: string,
    x: number,
    y: number,
    c: number,
    now: number,
    origin: string | null = null,
  ): StarData | null {
    const existing = this.stars.get(id);
    if (existing) {
      if (existing.by !== owner) return null; // 他人の星は上書きできない
    } else if (
      this.stars.size >= LIMITS.maxStars ||
      (this.starsByOwner.get(owner) ?? 0) >= LIMITS.maxStarsPerUser ||
      (origin !== null && (this.starsByOrigin.get(origin) ?? 0) >= LIMITS.maxStarsPerIp)
    ) {
      return null;
    }
    const star: StarData = { id, x, y, c, by: owner, ts: now };
    this.putStar(star, now);
    if (!existing && origin !== null) {
      this.originOf.set(id, origin);
      this.bump(this.starsByOrigin, origin, 1);
    }
    return star;
  }

  // 星を消す。つながっていた線の id も返す
  removeStar(id: string): { star: StarData; links: string[] } | null {
    const star = this.stars.get(id);
    if (!star) return null; // 誰でも消せる。持ち主は幽霊から復活できる
    const links = this.deleteStar(star);
    return { star, links };
  }

  // きらめき＝寿命のリセット。延ばせるのは作成から maxStarAgeMs まで（それを過ぎたら null）
  admire(id: string, now: number): StarData | null {
    const star = this.stars.get(id);
    if (!star) return null;
    if (now - (this.createdAt.get(id) ?? now) > LIMITS.maxStarAgeMs) return null;
    star.ts = now;
    this.markPut(starKey(id));
    return star;
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

  // 起動時に保存済みの状態を取り込む（変更扱いにはしない）。作成時刻は保存していないので now とする。
  // 次のものは取り込まず、保存先からも消す（残すと起動のたびに読んで捨てることになる）:
  // - 持ち主が持ち主 ID の形式でない星・線（旧プロトコルの生の uid が入っている。配信すると uid が漏れる）
  // - 端の星が無い線（上で捨てた星につながる線を含む）
  load(stars: Iterable<StarData>, links: Iterable<LinkData>, now: number) {
    for (const s of stars) {
      if (OWNER_ID_PATTERN.test(s.by)) this.putStar(s, now, false);
      else this.markDel(starKey(s.id));
    }
    for (const l of links) {
      if (OWNER_ID_PATTERN.test(l.by) && this.stars.has(l.a) && this.stars.has(l.b)) this.putLink(l, false);
      else this.markDel(linkKey(l.id));
    }
  }

  // 前回から変わった分だけを返して、変更の記録をリセットする
  drainChanges(): StorageChanges {
    const put: StorageChanges["put"] = {};
    for (const key of this.dirtyPut) {
      const id = key.slice(2);
      const v = key.startsWith("s:") ? this.stars.get(id) : this.links.get(id);
      if (v) put[key] = v;
    }
    const del = [...this.dirtyDel];
    this.dirtyPut.clear();
    this.dirtyDel.clear();
    return { put, del };
  }

  // --- 内部 ---

  private putStar(star: StarData, now: number, track = true) {
    const prev = this.stars.get(star.id);
    if (!prev) {
      this.bump(this.starsByOwner, star.by, 1);
      this.createdAt.set(star.id, now);
    }
    this.stars.set(star.id, star);
    if (track) this.markPut(starKey(star.id));
  }

  private deleteStar(star: StarData): string[] {
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
    this.createdAt.delete(star.id);
    const origin = this.originOf.get(star.id);
    if (origin !== undefined) {
      this.originOf.delete(star.id);
      this.bump(this.starsByOrigin, origin, -1);
    }
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
