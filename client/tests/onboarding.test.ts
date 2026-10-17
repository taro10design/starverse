import { describe, expect, it, vi } from "vitest";
import { HINTS, Onboarding, type OnboardingStore } from "../src/onboarding";

// localStorage の代わり（storage.ts と同じ形）
function memoryStore(init: Record<string, string> = {}): OnboardingStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    get: (k) => data.get(k) ?? null,
    set: (k, v) => void data.set(k, v),
    remove: (k) => void data.delete(k),
  };
}

describe("Onboarding（初めての人への 1 行の案内）", () => {
  it("初めての人には、空をタップ → ✦ を選ぶ → 星を置く の順に案内し、星を置いたら消える", () => {
    const o = new Onboarding(memoryStore());
    expect(o.hint).toBe(HINTS.tap);
    o.released("move", true);
    expect(o.hint).toBe(HINTS.pickStar);
    o.toolSelected("star");
    expect(o.hint).toBe(HINTS.placeStar);
    o.released("star", true);
    expect(o.hint).toBeNull();
  });

  it("案内ごとに見本の動き（demo）と、光らせるボタン（beckon）を決める", () => {
    const o = new Onboarding(memoryStore());
    expect([o.demo, o.beckon]).toEqual(["tap", null]);
    o.released("move", true);
    expect([o.demo, o.beckon]).toEqual([null, "star"]); // 本物の ✦ ボタンを光らせる
    o.toolSelected("star");
    expect([o.demo, o.beckon]).toEqual(["star", null]);
    o.released("star", true);
    expect([o.demo, o.beckon]).toEqual([null, null]);
  });

  it("タップでない操作（ドラッグ）では、最初の案内は進まない", () => {
    const o = new Onboarding(memoryStore());
    o.released("move", false);
    expect(o.hint).toBe(HINTS.tap);
  });

  it("先に ✦ を選んだら、星を置く案内へ飛ぶ", () => {
    const o = new Onboarding(memoryStore());
    o.toolSelected("star");
    expect(o.hint).toBe(HINTS.placeStar);
  });

  it("星を置く案内の途中で別のツールに替えたら、✦ を選ぶ案内に戻る", () => {
    const o = new Onboarding(memoryStore());
    o.toolSelected("star");
    o.toolSelected("line");
    expect(o.hint).toBe(HINTS.pickStar);
  });

  it("なぞって置いても（タップでなくても）星を置いたことになる", () => {
    const o = new Onboarding(memoryStore());
    o.toolSelected("star");
    o.released("star", false);
    expect(o.hint).toBeNull();
  });

  it("最後まで進めた人には、次に開いたときから案内を出さない", () => {
    const store = memoryStore();
    const o = new Onboarding(store);
    o.toolSelected("star");
    o.released("star", true);
    expect(new Onboarding(store).hint).toBeNull();
  });

  it("途中でやめた人には、次も最初から出す", () => {
    const store = memoryStore();
    new Onboarding(store).released("move", true);
    expect(new Onboarding(store).hint).toBe(HINTS.tap);
  });

  it("? は一度開くまで光り、開いたら次からも光らない", () => {
    const store = memoryStore();
    const o = new Onboarding(store);
    expect(o.pulseHelp).toBe(true);
    o.helpOpened();
    expect(o.pulseHelp).toBe(false);
    expect(new Onboarding(store).pulseHelp).toBe(false);
  });

  it("表示が変わるときだけ onChange を呼ぶ", () => {
    const onChange = vi.fn();
    const o = new Onboarding(memoryStore(), onChange);
    o.released("move", false); // 変わらない
    expect(onChange).not.toHaveBeenCalled();
    o.released("move", true);
    expect(onChange).toHaveBeenCalledTimes(1);
    o.helpOpened();
    o.helpOpened(); // 2 回目は変わらない
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("前の版の「説明を見た」印（uchu-seen）は消す", () => {
    const store = memoryStore({ "uchu-seen": "1" });
    new Onboarding(store);
    expect(store.data.has("uchu-seen")).toBe(false);
  });
});
