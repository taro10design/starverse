import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OP_CHUNK, OP_WINDOW_MS, OpPacer } from "../src/op-pacer";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("OpPacer", () => {
  it("1 窓に OP_CHUNK 件まではすぐ送り、超えた分は順番を保って次の窓に送る", () => {
    const sent: string[] = [];
    const pacer = new OpPacer((d) => sent.push(d));
    const all = Array.from({ length: 64 }, (_, i) => `op${i}`);
    for (const d of all) pacer.push(d);
    expect(sent).toEqual(all.slice(0, OP_CHUNK));
    expect(pacer.waiting).toBe(64 - OP_CHUNK);
    vi.advanceTimersByTime(OP_WINDOW_MS - 1);
    expect(sent).toHaveLength(OP_CHUNK);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(all.slice(0, OP_CHUNK * 2));
    vi.advanceTimersByTime(OP_WINDOW_MS * 2);
    expect(sent).toEqual(all);
    expect(pacer.waiting).toBe(0);
  });

  it("待ちがある間は、あとから来た単発の操作も列の後ろに並ぶ（追い越さない）", () => {
    const sent: string[] = [];
    const pacer = new OpPacer((d) => sent.push(d), 2, 100);
    pacer.push("a");
    pacer.push("b");
    pacer.push("c");
    pacer.push("d");
    expect(sent).toEqual(["a", "b"]);
    vi.advanceTimersByTime(100);
    pacer.push("e"); // 窓には 2 件送ったので、次の窓へ
    expect(sent).toEqual(["a", "b", "c", "d"]);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("窓が空いていれば、単発の操作はすぐ送る（普段の操作は待たされない）", () => {
    const sent: string[] = [];
    const pacer = new OpPacer((d) => sent.push(d), 2, 100);
    pacer.push("a");
    vi.advanceTimersByTime(500);
    pacer.push("b");
    pacer.push("c");
    expect(sent).toEqual(["a", "b", "c"]);
  });

  it("clear で残りを捨てる（切断したとき）。窓も初期化する", () => {
    const sent: string[] = [];
    const pacer = new OpPacer((d) => sent.push(d), 2, 100);
    for (const d of ["a", "b", "c", "d"]) pacer.push(d);
    pacer.clear();
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual(["a", "b"]);
    pacer.push("x");
    pacer.push("y");
    expect(sent).toEqual(["a", "b", "x", "y"]);
  });

  it("1 窓の最大コスト（1 件 2 トークン × OP_CHUNK）は、サーバーの毎秒の回復量を窓の長さで割った分を超えない", async () => {
    const { RATE, COST } = await import("../../server/src/config");
    const maxCost = Math.max(COST.star, COST.unstar, COST.link, COST.unlink, COST.admire);
    expect(maxCost * OP_CHUNK).toBeLessThanOrEqual((RATE.refillPerSec * OP_WINDOW_MS) / 1000);
  });
});
