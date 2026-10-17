import { describe, expect, it } from "vitest";
import { PALETTE_COUNT } from "../../shared/limits";
import { INVALID_HELLO, parseClientMessage as parse } from "../src/validate";
import * as v from "valibot";
import { ServerMessageSchema, type ServerMessage } from "../../shared/protocol";

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

  it("JSON でないもの・オブジェクトでないものは捨てる", () => {
    expect(parse("not json")).toBeNull();
    expect(parse("123")).toBeNull();
    expect(parse("null")).toBeNull();
    expect(parse('"star"')).toBeNull();
  });

  it("未知の種類は捨てる", () => {
    expect(parse('{"t":"evil"}')).toBeNull();
    expect(parse("{}")).toBeNull();
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
    expect(m).toEqual({ t: "p", x: 0, y: 0, c: 1 });
  });

  it("v は 4 つの座標が必要（多い・少ないものは無視する）", () => {
    expect(parse('{"t":"p","x":0,"y":0,"c":1,"v":[0,0,1]}')).toMatchObject({ v: undefined });
    expect(parse('{"t":"p","x":0,"y":0,"c":1,"v":[0,0,1,1,1]}')).toMatchObject({ v: undefined });
    expect(parse('{"t":"p","x":0,"y":0,"c":1,"v":[0,0,99999,1]}')).toMatchObject({ v: undefined });
  });
});

describe("ServerMessageSchema（サーバーが送る形）", () => {
  const star = { id: "s1", x: 0, y: 0, c: 0, by: "f".repeat(32), ts: 1 };

  it("サーバーが送るメッセージを通す", () => {
    const msgs: ServerMessage[] = [
      {
        t: "welcome",
        id: "abcd1234",
        me: "f".repeat(32),
        sendMs: 100,
        dots: [{ id: "x", x: 0, y: 0, c: 0 }],
        stars: [star],
        links: [],
      },
      { t: "rate", sendMs: 200 },
      { t: "reject", kind: "star", id: "s1" },
      { t: "ps", d: [["abcd1234", 0.5, 0.5, 3]] },
      { t: "pulse", x: 0, y: 0, c: 1 },
      { t: "star", ...star },
      { t: "unstar", id: "s1" },
      { t: "admire", id: "s1", ts: 2 },
      { t: "link", id: "l1", a: "s1", b: "s2", by: "f".repeat(32), ts: 1 },
      { t: "unlink", id: "l1" },
      { t: "leave", id: "abcd1234" },
    ];
    for (const m of msgs) expect(v.is(ServerMessageSchema, m)).toBe(true);
  });

  it("未知の種類・形の違うものは通さない", () => {
    expect(v.is(ServerMessageSchema, { t: "evil" })).toBe(false);
    expect(v.is(ServerMessageSchema, { t: "reject", kind: "pulse", id: "x" })).toBe(false);
    expect(v.is(ServerMessageSchema, { t: "ps", d: [["a", 0, 0]] })).toBe(false);
  });
});
