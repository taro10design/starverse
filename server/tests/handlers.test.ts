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
    bucket: new TokenBucket(RATE.capacity, RATE.refillPerSec, T0),
    violations: new ViolationCounter(LIMITS.maxProtocolViolations),
    admired: new Cooldown(LIMITS.admireCooldownMs, LIMITS.admireCooldownEntries),
    attachedAt: T0,
  };
}

describe("admire", () => {
  it("星の位置の近くにだけ知らせる（全員には配らない）", () => {
    const { room, log } = fakeRoom();
    room.world.placeStar("alice", "s1", 3, 4, 0, T0);
    room.clock = T0 + 1000;
    dispatch(room, member("bob"), { t: "admire", id: "s1" });
    expect(log.all).toEqual([]);
    expect(log.near).toEqual([{ msg: { t: "admire", id: "s1", ts: T0 + 1000 }, x: 3, y: 4 }]);
  });

  it("同じ接続が同じ星を連打しても、admireCooldownMs に 1 回だけ寿命が延びる", () => {
    const { room, log } = fakeRoom();
    room.world.placeStar("alice", "s1", 0, 0, 0, T0);
    const bob = member("bob");
    for (let i = 0; i < 10; i++) {
      room.clock = T0 + i * 100;
      dispatch(room, bob, { t: "admire", id: "s1" });
    }
    expect(log.near).toHaveLength(1);
    expect(room.world.stars.get("s1")?.ts).toBe(T0);
    room.clock = T0 + LIMITS.admireCooldownMs;
    dispatch(room, bob, { t: "admire", id: "s1" });
    expect(log.near).toHaveLength(2);
    expect(room.world.stars.get("s1")?.ts).toBe(T0 + LIMITS.admireCooldownMs);
  });

  it("別の接続・別の星は、それぞれ数える", () => {
    const { room, log } = fakeRoom();
    room.world.placeStar("alice", "s1", 0, 0, 0, T0);
    room.world.placeStar("alice", "s2", 1, 1, 0, T0);
    const bob = member("bob");
    dispatch(room, bob, { t: "admire", id: "s1" });
    dispatch(room, bob, { t: "admire", id: "s2" });
    dispatch(room, member("carol"), { t: "admire", id: "s1" });
    expect(log.near).toHaveLength(3);
  });

  it("無い星へのきらめきは、間隔の記録に数えない", () => {
    const { room, log } = fakeRoom();
    const bob = member("bob");
    dispatch(room, bob, { t: "admire", id: "s1" });
    room.world.placeStar("alice", "s1", 0, 0, 0, T0);
    dispatch(room, bob, { t: "admire", id: "s1" });
    expect(log.near).toHaveLength(1);
  });

  it("作成から maxStarAgeMs を過ぎた星は、きらめいても知らせない", () => {
    const { room, log } = fakeRoom();
    room.world.placeStar("alice", "s1", 0, 0, 0, T0);
    room.clock = T0 + LIMITS.maxStarAgeMs + 1;
    dispatch(room, member("bob"), { t: "admire", id: "s1" });
    expect(log.near).toEqual([]);
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
