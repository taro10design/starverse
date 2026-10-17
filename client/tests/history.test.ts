import { describe, expect, it } from "vitest";
import { History } from "../src/history";

function setup() {
  const log: string[] = [];
  let changes = 0;
  const h = new History(() => changes++);
  const op = (name: string) => ({ undo: () => log.push("undo " + name), redo: () => log.push("redo " + name) });
  return { h, log, op, changes: () => changes };
}

describe("History", () => {
  it("もどす → やりなおす の順序", () => {
    const { h, log, op } = setup();
    h.pushOp(op("a"));
    h.pushOp(op("b"));
    h.undo();
    h.undo();
    h.redo();
    expect(log).toEqual(["undo b", "undo a", "redo a"]);
  });

  it("操作が無いときは何も起きない", () => {
    const { h, log } = setup();
    h.undo();
    h.redo();
    expect(log).toEqual([]);
    expect([h.canUndo, h.canRedo]).toEqual([false, false]);
  });

  it("新しい操作をすると、やりなおしの履歴は捨てられる", () => {
    const { h, op } = setup();
    h.pushOp(op("a"));
    h.undo();
    expect(h.canRedo).toBe(true);
    h.pushOp(op("b"));
    expect(h.canRedo).toBe(false);
  });

  it("履歴は 200 件まで（古いものから捨てる）", () => {
    const { h, log, op } = setup();
    for (let i = 0; i < 205; i++) h.pushOp(op(String(i)));
    for (let i = 0; i < 300; i++) h.undo();
    expect(log).toHaveLength(200);
    expect(log[0]).toBe("undo 204");
    expect(log[199]).toBe("undo 5");
  });

  it("サーバーへ送れない間（undo(false) / redo(false)）は、ローカルだけの操作しか戻さない", () => {
    const { h, log, op } = setup();
    h.pushOp(op("remote"));
    h.pushOp({ ...op("local"), local: true });
    h.undo(false);
    expect(log).toEqual(["undo local"]);
    h.undo(false); // 次はサーバーへ送る操作なので、しない（順序は崩さない）
    expect(log).toEqual(["undo local"]);
    expect(h.canUndo).toBe(true);
    h.redo(false);
    expect(log).toEqual(["undo local", "redo local"]);
    h.undo(false);
    h.undo(true);
    expect(log).toEqual(["undo local", "redo local", "undo local", "undo remote"]);
    h.redo(false); // remote が先頭なのでしない
    expect(log).toHaveLength(4);
  });

  it("変化のたびにボタン更新のコールバックが呼ばれる", () => {
    const { h, op, changes } = setup();
    h.pushOp(op("a"));
    h.undo();
    h.redo();
    expect(changes()).toBe(3);
  });
});
