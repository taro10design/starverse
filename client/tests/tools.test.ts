import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolName } from "../src/constants";
import type { Tool, ToolContext, PointerInfo } from "../src/tools";

// ブラウザ API の最小限のスタブ（constants.ts / universe.ts / player.ts が読み込み時・実行時に使う）
const store = new Map<string, string>();
vi.stubGlobal("location", { search: "", hostname: "localhost", host: "localhost", port: "" });
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
});
vi.stubGlobal("performance", { now: () => 1234 });

let mod: {
  Camera: typeof import("../src/camera").Camera;
  Player: typeof import("../src/player").Player;
  Universe: typeof import("../src/universe").Universe;
  History: typeof import("../src/history").History;
  tools: typeof import("../src/tools");
};

beforeAll(async () => {
  mod = {
    Camera: (await import("../src/camera")).Camera,
    Player: (await import("../src/player")).Player,
    Universe: (await import("../src/universe")).Universe,
    History: (await import("../src/history")).History,
    tools: await import("../src/tools"),
  };
});

function setup() {
  store.clear();
  const sent: { t: string }[] = [];
  const camera = new mod.Camera();
  camera.resize(1000, 700);
  const player = new mod.Player();
  const universe = new mod.Universe(false, (m) => sent.push(m));
  const history = new mod.History(vi.fn());
  const feedback = { ping: vi.fn(), haptic: vi.fn() };
  const ctx: ToolContext = {
    camera,
    player,
    universe,
    history,
    hit: new mod.tools.HitTester(camera, universe),
    feedback,
  };
  const tools = mod.tools.createTools(ctx);
  const pushOp = vi.spyOn(history, "pushOp");
  // スクリーン座標からポインタ情報を作る
  const at = (sx: number, sy: number): PointerInfo => {
    const [wx, wy] = camera.screenToWorld(sx, sy);
    return { sx, sy, wx, wy };
  };
  // スクリーン座標に自分の星 / 他人の星を置く
  const mine = (sx: number, sy: number) => {
    const p = at(sx, sy);
    return universe.placeStar(p.wx, p.wy, 0);
  };
  const others = (id: string, sx: number, sy: number) => {
    const p = at(sx, sy);
    const s = { id, x: p.wx, y: p.wy, c: 2, by: "someone-else", ts: Date.now() };
    universe.stars.set(id, s);
    return s;
  };
  return { ctx, tools, camera, player, universe, history, feedback, sent, pushOp, at, mine, others };
}

// 押して・なぞって・離す
function drag(tool: Tool, points: PointerInfo[]) {
  const [first, ...rest] = points;
  tool.down(first);
  for (const p of rest) tool.move(p, true);
  tool.up(points[points.length - 1], false);
}

describe("createTools", () => {
  it("すべてのツールを名前つきで作る", () => {
    const { tools } = setup();
    for (const name of ["move", "star", "line", "erase", "ghost"] as ToolName[]) {
      expect(tools[name].name).toBe(name);
    }
  });
});

describe("star ツール", () => {
  it("空を押すと星を置き、離すと履歴が1件。undo は幽霊を残さず消し、redo は同じ id で戻す", () => {
    const { tools, universe, history, pushOp, at } = setup();
    tools.star.down(at(300, 300));
    expect(universe.stars.size).toBe(1);
    const id = [...universe.stars.keys()][0];
    tools.star.up(at(300, 300), true);
    expect(pushOp).toHaveBeenCalledTimes(1);
    history.undo();
    expect(universe.stars.size).toBe(0);
    expect(universe.ghosts.size).toBe(0);
    history.redo();
    expect(universe.stars.has(id)).toBe(true);
  });

  it("なぞると10pxを超えるごとに連続で置き、全部で履歴1件にまとまる", () => {
    const { tools, universe, history, pushOp, at } = setup();
    drag(tools.star, [at(100, 100), at(105, 100), at(115, 100), at(130, 100)]);
    expect(universe.stars.size).toBe(3);
    expect(pushOp).toHaveBeenCalledTimes(1);
    history.undo();
    expect(universe.stars.size).toBe(0);
  });

  it("押していない移動は消費しない（光が追従する）", () => {
    const { tools, universe, at } = setup();
    expect(tools.star.move(at(200, 200), false)).toBe(false);
    expect(tools.star.move(at(200, 200), true)).toBe(true);
    expect(universe.stars.size).toBe(0);
  });

  it("自分の星の上を押すと消して履歴に積み、undo で戻る（幽霊は残る）", () => {
    const { tools, universe, history, pushOp, at, mine } = setup();
    const s = mine(400, 400);
    tools.star.down(at(402, 400));
    expect(universe.stars.has(s.id)).toBe(false);
    expect(universe.ghosts.has(s.id)).toBe(true);
    tools.star.up(at(402, 400), true);
    expect(pushOp).toHaveBeenCalledTimes(1);
    history.undo();
    expect(universe.stars.has(s.id)).toBe(true);
    history.redo();
    expect(universe.stars.has(s.id)).toBe(false);
  });

  it("他人の星を押すときらめきを送り、星は置かない", () => {
    const { tools, universe, feedback, sent, pushOp, at, others } = setup();
    const s = others("o1", 500, 300);
    tools.star.down(at(500, 300));
    tools.star.up(at(500, 300), true);
    expect(sent).toContainEqual({ t: "admire", id: "o1" });
    expect(s).toHaveProperty("flash", 1234);
    expect(feedback.ping).toHaveBeenCalledTimes(1);
    expect(universe.stars.size).toBe(1);
    expect(pushOp).not.toHaveBeenCalled();
  });

  it("cancel で途中のバッチを確定し、その後のなぞりでは置かない", () => {
    const { tools, universe, pushOp, at } = setup();
    tools.star.down(at(100, 100));
    tools.star.move(at(120, 100), true);
    tools.star.cancel();
    expect(pushOp).toHaveBeenCalledTimes(1);
    tools.star.move(at(200, 100), true);
    expect(universe.stars.size).toBe(2);
  });
});

describe("line ツール", () => {
  it("星から星へ引くと線ができ、ping と履歴。undo / redo で消える・戻る", () => {
    const { tools, universe, history, feedback, pushOp, at, mine, others } = setup();
    mine(200, 200);
    others("o1", 400, 200);
    tools.line.down(at(200, 200));
    tools.line.up(at(401, 201), false);
    expect(universe.links.size).toBe(1);
    expect(feedback.ping).toHaveBeenCalledTimes(1);
    expect(pushOp).toHaveBeenCalledTimes(1);
    history.undo();
    expect(universe.links.size).toBe(0);
    history.redo();
    expect(universe.links.size).toBe(1);
  });

  it("同じ2点の線は（向きが逆でも）作らず、履歴も積まない", () => {
    const { tools, universe, pushOp, at, mine } = setup();
    mine(200, 200);
    mine(400, 200);
    drag(tools.line, [at(200, 200), at(400, 200)]);
    drag(tools.line, [at(400, 200), at(200, 200)]);
    expect(universe.links.size).toBe(1);
    expect(pushOp).toHaveBeenCalledTimes(1);
  });

  it("引き途中は linkPreview が始点と先端を返し、move を消費する", () => {
    const { tools, at, mine } = setup();
    const a = mine(200, 200);
    expect(tools.line.linkPreview?.()).toBeNull();
    tools.line.down(at(200, 200));
    const p = at(300, 250);
    expect(tools.line.move(p, true)).toBe(true);
    expect(tools.line.linkPreview?.()).toEqual({ from: a, tip: [p.wx, p.wy] });
    tools.line.up(p, false);
    expect(tools.line.linkPreview?.()).toBeNull();
  });

  it("空を押すと光がそこへ向かい、move は消費しない", () => {
    const { tools, player, at } = setup();
    const p = at(600, 600);
    tools.line.down(p);
    expect(player.target).toEqual({ x: p.wx, y: p.wy });
    expect(tools.line.move(at(610, 600), true)).toBe(false);
    expect(tools.line.linkPreview?.()).toBeNull();
  });

  it("cancel で引き途中の線が消え、その後 up しても線はできない", () => {
    const { tools, universe, at, mine } = setup();
    mine(200, 200);
    mine(400, 200);
    tools.line.down(at(200, 200));
    tools.line.cancel();
    expect(tools.line.linkPreview?.()).toBeNull();
    tools.line.up(at(400, 200), false);
    expect(universe.links.size).toBe(0);
  });
});

describe("erase ツール", () => {
  it("なぞった星を誰の星でも消し、全部で履歴1件。undo で戻り、redo で再び消える", () => {
    const { tools, universe, history, pushOp, at, mine, others } = setup();
    mine(100, 100);
    others("o1", 200, 100);
    mine(600, 600); // なぞっていない星は残る
    drag(tools.erase, [at(100, 100), at(150, 100), at(200, 100)]);
    expect(universe.stars.size).toBe(1);
    expect(pushOp).toHaveBeenCalledTimes(1);
    history.undo();
    expect(universe.stars.size).toBe(3);
    history.redo();
    expect(universe.stars.size).toBe(1);
  });

  it("何も消さなければ履歴を積まず、押していない移動は消費しない", () => {
    const { tools, universe, pushOp, at, mine } = setup();
    mine(100, 100);
    expect(tools.erase.move(at(100, 100), true)).toBe(false); // 押す前
    expect(universe.stars.size).toBe(1);
    drag(tools.erase, [at(500, 500), at(510, 500)]);
    expect(pushOp).not.toHaveBeenCalled();
    tools.erase.down(at(500, 500));
    expect(tools.erase.move(at(100, 100), false)).toBe(false);
    expect(universe.stars.size).toBe(1);
  });
});

describe("ghost ツール", () => {
  it("なぞった幽霊を忘れ、全部で履歴1件。undo で思い出し、redo で再び忘れる", () => {
    const { tools, universe, history, pushOp, at, mine } = setup();
    universe.deleteStar(mine(100, 100));
    universe.deleteStar(mine(200, 100));
    expect(universe.ghosts.size).toBe(2);
    drag(tools.ghost, [at(100, 100), at(150, 100), at(200, 100)]);
    expect(universe.ghosts.size).toBe(0);
    expect(pushOp).toHaveBeenCalledTimes(1);
    history.undo();
    expect(universe.ghosts.size).toBe(2);
    history.redo();
    expect(universe.ghosts.size).toBe(0);
  });

  it("cancel でも途中のバッチを確定する", () => {
    const { tools, universe, pushOp, at, mine } = setup();
    universe.deleteStar(mine(100, 100));
    tools.ghost.down(at(100, 100));
    tools.ghost.cancel();
    expect(pushOp).toHaveBeenCalledTimes(1);
    expect(tools.ghost.move(at(100, 100), true)).toBe(false);
  });
});

describe("move ツール", () => {
  it("押した所へ光が向かい、move は消費しない", () => {
    const { tools, player, at } = setup();
    const p = at(700, 100);
    tools.move.down(p);
    expect(player.target).toEqual({ x: p.wx, y: p.wy });
    expect(tools.move.move(at(710, 100), true)).toBe(false);
  });

  it("幽霊をタップすると復活し、ping・haptic・履歴。undo で幽霊に戻り、redo で再び復活", () => {
    const { tools, universe, history, feedback, pushOp, at, mine } = setup();
    const s = mine(300, 300);
    universe.deleteStar(s);
    tools.move.down(at(300, 300));
    tools.move.up(at(300, 300), true);
    expect(universe.stars.has(s.id)).toBe(true);
    expect(universe.ghosts.has(s.id)).toBe(false);
    expect(feedback.ping).toHaveBeenCalledTimes(1);
    expect(feedback.haptic).toHaveBeenCalledTimes(1);
    expect(pushOp).toHaveBeenCalledTimes(1);
    history.undo();
    expect(universe.stars.has(s.id)).toBe(false);
    expect(universe.ghosts.has(s.id)).toBe(true);
    history.redo();
    expect(universe.stars.has(s.id)).toBe(true);
  });

  it("自分の星をタップすると消して履歴に積む。タップでなければ何もしない", () => {
    const { tools, universe, history, pushOp, at, mine } = setup();
    const s = mine(300, 300);
    tools.move.up(at(300, 300), false);
    expect(universe.stars.has(s.id)).toBe(true);
    tools.move.up(at(300, 300), true);
    expect(universe.stars.has(s.id)).toBe(false);
    expect(pushOp).toHaveBeenCalledTimes(1);
    history.undo();
    expect(universe.stars.has(s.id)).toBe(true);
  });

  it("他人の星をタップするときらめきを送る（消さない）", () => {
    const { tools, universe, feedback, sent, pushOp, at, others } = setup();
    others("o1", 300, 300);
    tools.move.up(at(305, 300), true);
    expect(universe.stars.has("o1")).toBe(true);
    expect(sent).toContainEqual({ t: "admire", id: "o1" });
    expect(feedback.ping).toHaveBeenCalledTimes(1);
    expect(pushOp).not.toHaveBeenCalled();
  });
});
