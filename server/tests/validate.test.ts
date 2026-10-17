import { describe, expect, it } from "vitest";
import { PALETTE_COUNT } from "../../shared/limits";
import { INVALID_HELLO, UNREADABLE, parseClientMessage as parse } from "../src/validate";
import { strictFrameProblem } from "./support/strict-protocol";

const UID = "abcdef12-3456-7890-abcd-ef1234567890";

describe("parseClientMessage", () => {
  it("正しいメッセージを通す", () => {
    expect(parse('{"t":"star","id":"abc","x":0.5,"y":0.5,"c":3}')).toEqual({
      t: "star",
      id: "abc",
      x: 0.5,
      y: 0.5,
      c: 3,
    });
    expect(parse('{"t":"p","x":1,"y":2,"c":3,"v":[0,0,1,1]}')).toEqual({ t: "p", x: 1, y: 2, c: 3, v: [0, 0, 1, 1] });
  });

  it("JSON でないもの・オブジェクトでないものは、読めないもの（UNREADABLE。違反として数える）", () => {
    expect(parse("not json")).toBe(UNREADABLE);
    expect(parse("123")).toBe(UNREADABLE);
    expect(parse("null")).toBe(UNREADABLE);
    expect(parse('"star"')).toBe(UNREADABLE);
  });

  it("未知の種類・種類の無いものも、読めないもの（UNREADABLE）", () => {
    expect(parse('{"t":"evil"}')).toBe(UNREADABLE);
    expect(parse('{"t":5}')).toBe(UNREADABLE);
    expect(parse("{}")).toBe(UNREADABLE);
  });

  it("種類は正しいが形の合わないものは null（無視するだけ）", () => {
    expect(parse('{"t":"star"}')).toBeNull();
  });

  it("座標が数値でない・範囲外なら捨てる", () => {
    expect(parse('{"t":"star","id":"a","x":"0.5","y":0,"c":0}')).toBeNull();
    expect(parse('{"t":"star","id":"a","x":1e999,"y":0,"c":0}')).toBeNull();
    expect(parse('{"t":"star","id":"a","x":99999,"y":0,"c":0}')).toBeNull();
    expect(parse('{"t":"pulse","x":null,"y":0}')).toBeNull();
  });

  it("id が文字列でない・空なら捨てる。長い id は切り詰める", () => {
    expect(parse('{"t":"unstar","id":123}')).toBeNull();
    expect(parse('{"t":"unstar","id":""}')).toBeNull();
    const long = "x".repeat(100);
    expect(parse(`{"t":"admire","id":"${long}"}`)).toEqual({ t: "admire", id: "x".repeat(24) });
  });

  it("位置の色は範囲外なら 0 にする。視界が不正なら無視する", () => {
    expect(parse('{"t":"p","x":0,"y":0,"c":99}')).toMatchObject({ c: 0 });
    expect(parse(`{"t":"p","x":0,"y":0,"c":${PALETTE_COUNT}}`)).toMatchObject({ c: 0 });
    expect(parse('{"t":"p","x":0,"y":0,"c":1,"v":[1,1,0,0]}')).toMatchObject({ v: undefined });
    expect(parse('{"t":"p","x":0,"y":0,"c":1,"v":[0,0,"a",1]}')).toMatchObject({ v: undefined });
  });

  it("link は3つの id が必要", () => {
    expect(parse('{"t":"link","id":"l","a":"x"}')).toBeNull();
    expect(parse('{"t":"link","id":"l","a":"x","b":"y"}')).toEqual({ t: "link", id: "l", a: "x", b: "y" });
  });
});

describe("parseClientMessage: hello", () => {
  it("形式に合う uid の hello を通す", () => {
    expect(parse(JSON.stringify({ t: "hello", uid: UID }))).toEqual({ t: "hello", uid: UID });
    expect(parse(JSON.stringify({ t: "hello", uid: "a".repeat(64) }))).toEqual({ t: "hello", uid: "a".repeat(64) });
  });

  it("形式に合わない uid は切り詰めず、不正な hello として返す", () => {
    expect(parse(JSON.stringify({ t: "hello", uid: "short" }))).toBe(INVALID_HELLO);
    expect(parse(JSON.stringify({ t: "hello", uid: "a".repeat(65) }))).toBe(INVALID_HELLO);
    expect(parse(JSON.stringify({ t: "hello", uid: "has space!" }))).toBe(INVALID_HELLO);
    expect(parse(JSON.stringify({ t: "hello", uid: 12345678 }))).toBe(INVALID_HELLO);
    expect(parse(JSON.stringify({ t: "hello" }))).toBe(INVALID_HELLO);
  });
});

describe("parseClientMessage: 星の色", () => {
  it("star の c は 0..PALETTE_COUNT-1 の整数が必要", () => {
    expect(parse('{"t":"star","id":"a","x":0,"y":0}')).toBeNull();
    expect(parse('{"t":"star","id":"a","x":0,"y":0,"c":-1}')).toBeNull();
    expect(parse(`{"t":"star","id":"a","x":0,"y":0,"c":${PALETTE_COUNT}}`)).toBeNull();
    expect(parse('{"t":"star","id":"a","x":0,"y":0,"c":1.5}')).toBeNull();
    expect(parse(`{"t":"star","id":"a","x":0,"y":0,"c":${PALETTE_COUNT - 1}}`)).toMatchObject({
      c: PALETTE_COUNT - 1,
    });
  });

  it("pulse は c を受けない", () => {
    expect(parse('{"t":"pulse","x":0,"y":0,"c":3}')).toEqual({ t: "pulse", x: 0, y: 0 });
  });
});

describe("parseClientMessage: 旧 uid フィールド", () => {
  it("star / unstar / link / unlink に uid があっても無視する", () => {
    expect(parse(`{"t":"star","id":"a","x":0,"y":0,"c":0,"uid":"${UID}"}`)).toEqual({
      t: "star",
      id: "a",
      x: 0,
      y: 0,
      c: 0,
    });
    expect(parse(`{"t":"unstar","id":"a","uid":"${UID}"}`)).toEqual({ t: "unstar", id: "a" });
    expect(parse(`{"t":"link","id":"l","a":"x","b":"y","uid":"${UID}"}`)).toEqual({
      t: "link",
      id: "l",
      a: "x",
      b: "y",
    });
    expect(parse(`{"t":"unlink","id":"l","uid":"${UID}"}`)).toEqual({ t: "unlink", id: "l" });
  });
});

describe("parseClientMessage: 視界", () => {
  it("v が無い p はそのまま通す（v は付けない）", () => {
    const m = parse('{"t":"p","x":0,"y":0,"c":1}');
    // toEqual は undefined のキーを区別しないので、toStrictEqual と "v" in で、キー自体が無いことを確かめる
    expect(m).toStrictEqual({ t: "p", x: 0, y: 0, c: 1 });
    expect(m !== null && typeof m === "object" && "v" in m).toBe(false);
  });

  it("c が無い p は、色 0 として受ける", () => {
    expect(parse('{"t":"p","x":0,"y":0}')).toStrictEqual({ t: "p", x: 0, y: 0, c: 0 });
    expect(parse('{"t":"p","x":0,"y":0,"v":[0,0,1,1]}')).toStrictEqual({ t: "p", x: 0, y: 0, c: 0, v: [0, 0, 1, 1] });
  });

  it("v は 4 つの座標が必要（多い・少ないものは無視する）", () => {
    expect(parse('{"t":"p","x":0,"y":0,"c":1,"v":[0,0,1]}')).toMatchObject({ v: undefined });
    expect(parse('{"t":"p","x":0,"y":0,"c":1,"v":[0,0,1,1,1]}')).toMatchObject({ v: undefined });
    expect(parse('{"t":"p","x":0,"y":0,"c":1,"v":[0,0,99999,1]}')).toMatchObject({ v: undefined });
  });
});

// サーバーが送る形（ServerMessageSchema）は、ここで型の写しを作って確かめない。実際に送られたフレームを、
// ランタイムのテスト（server/tests/runtime/helpers.ts）がテスト専用の厳密なスキーマ（server/tests/support/strict-protocol.ts）で
// 1 つ残らず検証する

// 上の厳密なスキーマ自体が、漏れを見逃さないこと（ランタイムのテストの確かめが空回りしていないことの対照）
describe("テスト用の厳密なスキーマ（strictFrameProblem）", () => {
  const OWNER = "f".repeat(32);
  const star = { t: "star", id: "s1", x: 0, y: 0, c: 0, by: OWNER, ts: 1 };
  const ok = (m: unknown) => strictFrameProblem(JSON.stringify(m));

  it("仕様どおりのフレームと pong は通す", () => {
    expect(ok(star)).toBeNull();
    expect(ok({ t: "welcome", id: "a", me: OWNER, sendMs: 100, dots: [], stars: [], links: [] })).toBeNull();
    expect(strictFrameProblem("pong")).toBeNull();
  });

  it("保存専用の born / v、uid、知らないキー、持ち主 ID の形でない by / me、null になった数値は通さない", () => {
    expect(ok({ ...star, born: 1 })).not.toBeNull();
    expect(ok({ ...star, v: 2 })).not.toBeNull();
    expect(ok({ ...star, uid: UID })).not.toBeNull();
    expect(ok({ ...star, origin: "x" })).not.toBeNull();
    expect(ok({ ...star, by: UID })).not.toBeNull();
    expect(ok({ ...star, x: null })).not.toBeNull();
    expect(ok({ t: "welcome", id: "a", me: UID, sendMs: 100, dots: [], stars: [], links: [] })).not.toBeNull();
    expect(
      ok({
        t: "welcome",
        id: "a",
        me: OWNER,
        sendMs: 100,
        dots: [],
        stars: [{ ...star, t: undefined, born: 1 }],
        links: [],
      }),
    ).not.toBeNull();
    expect(strictFrameProblem("hello")).not.toBeNull();
  });
});
