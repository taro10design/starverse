import { describe, expect, it } from "vitest";
import { parseClientMessage as parse } from "../src/validate";

describe("parseClientMessage", () => {
  it("正しいメッセージを通す", () => {
    expect(parse('{"t":"star","id":"abc","x":0.5,"y":0.5,"uid":"u1"}')).toEqual({ t: "star", id: "abc", x: 0.5, y: 0.5, uid: "u1" });
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
    expect(parse('{"t":"star","id":"a","x":"0.5","y":0}')).toBeNull();
    expect(parse('{"t":"star","id":"a","x":1e999,"y":0}')).toBeNull();
    expect(parse('{"t":"star","id":"a","x":99999,"y":0}')).toBeNull();
    expect(parse('{"t":"pulse","x":null,"y":0}')).toBeNull();
  });

  it("id が文字列でない・空なら捨てる。長い id は切り詰める", () => {
    expect(parse('{"t":"unstar","id":123}')).toBeNull();
    expect(parse('{"t":"unstar","id":""}')).toBeNull();
    const long = "x".repeat(100);
    expect(parse(`{"t":"admire","id":"${long}"}`)).toEqual({ t: "admire", id: "x".repeat(24) });
  });

  it("色は範囲外なら 0 にする。視界が不正なら無視する", () => {
    expect(parse('{"t":"p","x":0,"y":0,"c":99}')).toMatchObject({ c: 0 });
    expect(parse('{"t":"p","x":0,"y":0,"c":1,"v":[1,1,0,0]}')).toMatchObject({ v: undefined });
    expect(parse('{"t":"p","x":0,"y":0,"c":1,"v":[0,0,"a",1]}')).toMatchObject({ v: undefined });
  });

  it("link は3つの id が必要", () => {
    expect(parse('{"t":"link","id":"l","a":"x"}')).toBeNull();
    expect(parse('{"t":"link","id":"l","a":"x","b":"y"}')).toMatchObject({ t: "link" });
  });
});
