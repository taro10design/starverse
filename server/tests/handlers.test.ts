import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../../shared/protocol";
import { LIMITS, RATE } from "../src/config";
import { dispatch, type Member, type RoomApi } from "../src/handlers";
import { ViolationCounter } from "../src/inbound";
import { Cooldown, TokenBucket } from "../src/rate-limit";
import { World } from "../src/world";

const T0 = 1_000_000;

// handlers から見た部屋の偽物。送った・配ったメッセージを記録する
function fakeRoom() {
  const log = {
    sent: [] as ServerMessage[],
    all: [] as ServerMessage[],
    near: [] as { msg: ServerMessage; x: number; y: number }[],
  };
  const room = {
    world: new World(),
    clock: T0,
    now() {
      return this.clock;
    },
    send: (_c, msg) => log.sent.push(msg),
    broadcast: (msg) => log.all.push(msg),
    broadcastNear: (msg, x, y) => log.near.push({ msg, x, y }),
    markDirty: () => undefined,
    persist: () => undefined,
    prune: () => undefined,
  } satisfies RoomApi & { clock: number };
  return { room, log };
}

function member(owner: string, ip: string | null = null): Member {
  return {
    ws: {} as WebSocket,
    id: owner.slice(0, 8),
    owner,
    ip,
    since: T0,
    x: 0,
    y: 0,
    c: 0,
    view: null,
    dirty: false,
    bucket: new TokenBucket(RATE.capacity, RATE.refillPerSec, T0, LIMITS.rateWindowMs),
    violations: new ViolationCounter(LIMITS.maxProtocolViolations),
    admired: new Cooldown(LIMITS.admireCooldownMs, LIMITS.admireCooldownEntries),
    attachedAt: T0,
  };
}

// 星の ts（作成・前回のきらめき）から admireMinIntervalMs 経つと、次のきらめきが通る
const OPEN = T0 + LIMITS.admireMinIntervalMs;

describe("admire", () => {
  it("視界に関係なく全員に知らせる（視界外の人の手元で星が早く消えないように）", () => {
    const { room, log } = fakeRoom();
    room.world.placeStar("alice", "s1", 3, 4, 0, T0);
    room.clock = OPEN;
    dispatch(room, member("bob"), { t: "admire", id: "s1" });
    expect(log.near).toEqual([]);
    expect(log.all).toEqual([{ t: "admire", id: "s1", ts: OPEN }]);
  });

  it("星ごとの全体の間隔: 星の ts から admireMinIntervalMs の間は、別の接続からでも延ばさず配らない", () => {
    const { room, log } = fakeRoom();
    room.world.placeStar("alice", "s1", 0, 0, 0, T0);
    room.clock = T0 + 1000;
    dispatch(room, member("bob"), { t: "admire", id: "s1" }); // 作成から間もない
    expect(log.all).toEqual([]);
    room.clock = OPEN;
    dispatch(room, member("carol"), { t: "admire", id: "s1" });
    room.clock = OPEN + 1000;
    dispatch(room, member("dave"), { t: "admire", id: "s1" });
    expect(log.all).toEqual([{ t: "admire", id: "s1", ts: OPEN }]);
    expect(room.world.stars.get("s1")?.ts).toBe(OPEN);
  });

  it("接続ごとの間隔も残る: 同じ接続は admireCooldownMs の間、全体の間隔が空いても通らない", () => {
    const { room, log } = fakeRoom();
    room.world.placeStar("alice", "s1", 0, 0, 0, T0);
    const bob = member("bob");
    room.clock = OPEN - 1000;
    dispatch(room, bob, { t: "admire", id: "s1" }); // 全体の間隔で断られるが、接続の間隔は数える
    room.clock = OPEN;
    dispatch(room, bob, { t: "admire", id: "s1" });
    expect(log.all).toEqual([]);
    dispatch(room, member("carol"), { t: "admire", id: "s1" });
    expect(log.all).toEqual([{ t: "admire", id: "s1", ts: OPEN }]);
  });

  it("別の星は、それぞれ数える", () => {
    const { room, log } = fakeRoom();
    room.world.placeStar("alice", "s1", 0, 0, 0, T0);
    room.world.placeStar("alice", "s2", 1, 1, 0, T0);
    const bob = member("bob");
    room.clock = OPEN;
    dispatch(room, bob, { t: "admire", id: "s1" });
    dispatch(room, bob, { t: "admire", id: "s2" });
    expect(log.all).toHaveLength(2);
  });

  it("無い星へのきらめきは、間隔の記録に数えない", () => {
    const { room, log } = fakeRoom();
    const bob = member("bob");
    room.clock = OPEN;
    dispatch(room, bob, { t: "admire", id: "s1" });
    room.world.placeStar("alice", "s1", 0, 0, 0, T0);
    dispatch(room, bob, { t: "admire", id: "s1" });
    expect(log.all).toHaveLength(1);
  });

  it("作成から maxStarAgeMs を過ぎた星は、きらめいても知らせない", () => {
    const { room, log } = fakeRoom();
    room.world.placeStar("alice", "s1", 0, 0, 0, T0);
    room.clock = T0 + LIMITS.maxStarAgeMs + 1;
    dispatch(room, member("bob"), { t: "admire", id: "s1" });
    expect(log.all).toEqual([]);
  });
});

describe("star（配信）", () => {
  it("配る星には保存専用の born / origin / v が入らない", () => {
    const { room, log } = fakeRoom();
    dispatch(room, member("alice", "ipA"), { t: "star", id: "s1", x: 1, y: 2, c: 3 });
    expect(log.all).toEqual([{ t: "star", id: "s1", x: 1, y: 2, c: 3, by: "alice", ts: T0 }]);
  });
});

describe("star（同じ接続元の上限）", () => {
  it("同じ接続元の星が maxStarsPerIp に達したら、持ち主が違っても reject", () => {
    const { room, log } = fakeRoom();
    const owners = Array.from({ length: 4 }, (_, i) => member(`owner${i}`, "ipA"));
    for (let i = 0; i < LIMITS.maxStarsPerIp; i++) {
      dispatch(room, owners[i % 4], { t: "star", id: `s${i}`, x: i, y: 0, c: 0 });
    }
    expect(log.sent).toEqual([]);
    dispatch(room, owners[0], { t: "star", id: "over", x: 0, y: 1, c: 0 });
    expect(log.sent).toEqual([{ t: "reject", kind: "star", id: "over" }]);
  });
});
