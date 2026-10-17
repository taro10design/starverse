import { describe, expect, it } from "vitest";
import { LIMITS, roomName, sendMsFor } from "../src/config";

describe("sendMsFor（人数に応じた位置の送信間隔）", () => {
  it("少人数のときは最短間隔", () => {
    expect(sendMsFor(0)).toBe(LIMITS.sendMsMin);
    expect(sendMsFor(1)).toBe(LIMITS.sendMsMin);
    expect(sendMsFor(50)).toBe(LIMITS.sendMsMin);
  });

  it("人数が増えるほど間隔が広がる（単調増加）", () => {
    let prev = 0;
    for (let n = 1; n <= 400; n++) {
      const ms = sendMsFor(n);
      expect(ms).toBeGreaterThanOrEqual(prev);
      prev = ms;
    }
  });

  it("全員が送ったときの合計が予算に収まる（満員まで）", () => {
    for (let n = 1; n <= LIMITS.roomCapacity; n++) {
      const perSec = n * (1000 / sendMsFor(n));
      expect(perSec).toBeLessThanOrEqual(LIMITS.inboundBudgetPerSec + 1e-9);
    }
  });

  it("50ms 刻みで、上限を超えない", () => {
    for (const n of [10, 77, 123, 299, 10_000]) {
      const ms = sendMsFor(n);
      expect(ms % 50).toBe(0);
      expect(ms).toBeLessThanOrEqual(LIMITS.sendMsMax);
    }
  });
});

describe("roomName", () => {
  it("先頭は従来の space（既存データを引き継ぐ）、以降は連番", () => {
    expect(roomName(0)).toBe("space");
    expect(roomName(1)).toBe("space-2");
    expect(roomName(7)).toBe("space-8");
  });
});

import { COST, RATE } from "../src/config";

describe("レート制限の設定", () => {
  it("1 人あたりの上限ぶんの一括操作（全部消す・全部復活）を捨てずに受けられる", () => {
    expect(RATE.capacity).toBeGreaterThanOrEqual(LIMITS.maxStarsPerUser * COST.star);
    expect(RATE.capacity).toBeGreaterThanOrEqual(LIMITS.maxStarsPerUser * COST.unstar);
  });
});
