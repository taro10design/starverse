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

const ME = "owner-me";

function setup() {
  store.clear();
  const sent: { t: string }[] = [];
  const camera = new mod.Camera();
  camera.resize(1000, 700);
  const player = new mod.Player();
  const universe = new mod.Universe(false, (m) => sent.push(m));
  universe.ownerId = ME; // welcome を受け取った状態
  const history = new mod.History(vi.fn());
  const feedback = { ping: vi.fn(), haptic: vi.fn() };
  const online = { editable: true }; // false にすると「接続が切れている」状態
  const ctx: ToolContext = {
    camera,
    player,
    universe,
    history,
    hit: new mod.tools.HitTester(camera, universe),
    feedback,
    canEdit: () => online.editable,
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
    const s = universe.placeStar(p.wx, p.wy, 0);
    if (!s) throw new Error("星が置けない");
    return s;
  };
  const others = (id: string, sx: number, sy: number) => {
    const p = at(sx, sy);
    const s = { id, x: p.wx, y: p.wy, c: 2, by: "someone-else", ts: Date.now() };
    universe.stars.set(id, s);
    return s;
  };
  return { ctx, tools, camera, player, universe, history, feedback, sent, pushOp, at, mine, others, online };
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
  it("空を押して離すと星を置き、履歴が1件。undo は幽霊を残さず消し、redo は同じ id で戻す", () => {
    const { tools, universe, history, pushOp, at } = setup();
    tools.star.down(at(300, 300));
    tools.star.up(at(300, 300), true);
    expect(universe.stars.size).toBe(1);
    const id = [...universe.stars.keys()][0];
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
    tools.star.up(at(402, 400), true);
    expect(universe.stars.has(s.id)).toBe(false);
    expect(universe.ghosts.has(s.id)).toBe(true);
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

  it("置いた星は今の色で、色ごとサーバーへ送る", () => {
    const { tools, universe, player, sent, at } = setup();
    player.setColor(4);
    tools.star.down(at(300, 300));
    tools.star.up(at(300, 300), true);
    const s = [...universe.stars.values()][0];
    expect(s.c).toBe(4);
    expect(sent).toContainEqual({ t: "star", id: s.id, x: s.x, y: s.y, c: 4 });
  });

  it("なぞりの連続配置は 1 秒に 20 個まで（間引く）", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const { tools, universe, at } = setup();
      tools.star.down(at(10, 100));
      for (let i = 1; i <= 40; i++) tools.star.move(at(10 + i * 11, 100), true);
      expect(universe.stars.size).toBe(20);
      vi.setSystemTime(11_001);
      tools.star.move(at(10 + 41 * 11, 100), true);
      expect(universe.stars.size).toBe(21);
      tools.star.up(at(0, 0), false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("自分の星が上限に達していたら置かず、履歴も積まない", async () => {
    const { MAX_STARS_PER_USER } = await import("../../shared/limits");
    const { tools, universe, pushOp, at } = setup();
    for (let i = 0; i < MAX_STARS_PER_USER; i++) universe.placeStar(5 + i * 0.01, 5, 0); // 画面の外
    tools.star.down(at(300, 300));
    tools.star.move(at(320, 300), true);
    tools.star.up(at(320, 300), false);
    expect(universe.stars.size).toBe(MAX_STARS_PER_USER);
    expect(pushOp).not.toHaveBeenCalled();
  });

  it("接続が切れている間（canEdit が false）は置かない・消さない・きらめかない", () => {
    const { tools, universe, sent, pushOp, at, mine, others, online } = setup();
    const m = mine(400, 400);
    others("o1", 500, 300);
    sent.length = 0;
    online.editable = false;
    drag(tools.star, [at(100, 100), at(130, 100)]);
    tools.star.down(at(400, 400));
    tools.star.up(at(400, 400), true);
    tools.star.down(at(500, 300));
    tools.star.up(at(500, 300), true);
    expect(universe.stars.size).toBe(2);
    expect(universe.stars.has(m.id)).toBe(true);
    expect(sent).toEqual([]);
    expect(pushOp).not.toHaveBeenCalled();
  });

  it("当たり判定と置く位置は、押した時点のワールド座標（p.wx / p.wy）。渡されるまでにカメラが動いてもずれない", () => {
    const { tools, universe, camera, at, mine } = setup();
    const s = mine(400, 400);
    const onMine = at(400, 400);
    const onSky = at(100, 100);
    camera.pan(300, 0); // 押してから Input が確定するまでの間に、カメラが動いた
    tools.star.down(onMine);
    tools.star.up(onMine, true);
    expect(universe.stars.has(s.id)).toBe(false);
    tools.star.down(onSky);
    tools.star.up(onSky, true);
    expect([...universe.stars.values()]).toMatchObject([{ x: onSky.wx, y: onSky.wy }]);
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

  it("接続が切れている間（canEdit が false）は線を引かない", () => {
    const { tools, universe, pushOp, at, mine, online } = setup();
    mine(200, 200);
    mine(400, 200);
    tools.line.down(at(200, 200));
    online.editable = false; // 引いている途中で切れた
    tools.line.up(at(400, 200), false);
    drag(tools.line, [at(200, 200), at(400, 200)]);
    expect(universe.links.size).toBe(0);
    expect(pushOp).not.toHaveBeenCalled();
  });

  it("自分の線が上限に達していたら引かない", async () => {
    const { MAX_LINKS_PER_USER } = await import("../../shared/limits");
    const { tools, universe, pushOp, at, mine } = setup();
    // 画面の外の星どうしで上限まで引く
    const far = Array.from({ length: 16 }, (_, i) => {
      const s = universe.placeStar(5 + i * 0.01, 5, 0);
      if (!s) throw new Error("星が置けない");
      return s;
    });
    let n = 0;
    for (let i = 0; i < far.length && n < MAX_LINKS_PER_USER; i++) {
      for (let j = i + 1; j < far.length && n < MAX_LINKS_PER_USER; j++) {
        if (universe.addLink(far[i].id, far[j].id)) n++;
      }
    }
    expect(n).toBe(MAX_LINKS_PER_USER);
    mine(200, 200);
    mine(400, 200);
    drag(tools.line, [at(200, 200), at(400, 200)]);
    expect(universe.links.size).toBe(MAX_LINKS_PER_USER);
    expect(pushOp).not.toHaveBeenCalled();
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
  it("なぞった星を誰の星でも消す。履歴は自分の星の分だけ1件にまとまり、undo で自分の星だけ戻る", () => {
    const { tools, universe, history, pushOp, at, mine, others } = setup();
    const m = mine(100, 100);
    others("o1", 200, 100);
    mine(600, 600); // なぞっていない星は残る
    drag(tools.erase, [at(100, 100), at(150, 100), at(200, 100)]);
    expect(universe.stars.size).toBe(1);
    expect(pushOp).toHaveBeenCalledTimes(1);
    history.undo();
    expect(universe.stars.size).toBe(2);
    expect(universe.stars.has(m.id)).toBe(true);
    expect(universe.stars.has("o1")).toBe(false); // 復元すると持ち主が自分に移るので戻さない
    history.redo();
    expect(universe.stars.size).toBe(1);
  });

  it("他人の星だけを消した操作は履歴に積まない（undo で by が自分に変わらない）", () => {
    const { tools, universe, history, pushOp, at, mine, others } = setup();
    const m = mine(600, 600);
    others("o1", 200, 100);
    drag(tools.erase, [at(200, 100), at(205, 100)]);
    expect(universe.stars.has("o1")).toBe(false);
    expect(pushOp).not.toHaveBeenCalled();
    history.undo();
    expect(universe.stars.has("o1")).toBe(false);
    expect([...universe.stars.values()].every((s) => s.id === m.id)).toBe(true);
  });

  it("消して undo した自分の星は、消したときの色で戻る", () => {
    const { tools, universe, player, history, at } = setup();
    const p = at(100, 100);
    const s = universe.placeStar(p.wx, p.wy, 5);
    if (!s) throw new Error("星が置けない");
    player.setColor(1);
    drag(tools.erase, [at(100, 100)]);
    history.undo();
    expect(universe.stars.get(s.id)?.c).toBe(5);
  });

  it("接続が切れている間（canEdit が false）は消さない", () => {
    const { tools, universe, pushOp, at, mine, online } = setup();
    mine(100, 100);
    online.editable = false;
    drag(tools.erase, [at(100, 100), at(105, 100)]);
    expect(universe.stars.size).toBe(1);
    expect(pushOp).not.toHaveBeenCalled();
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

  it("幽霊を忘れる操作は自分の画面だけなので、履歴はローカル（切断中でも undo / redo できる）", () => {
    const { tools, universe, history, at, mine, online } = setup();
    universe.deleteStar(mine(100, 100));
    online.editable = false;
    drag(tools.ghost, [at(100, 100)]);
    expect(universe.ghosts.size).toBe(0);
    history.undo(false); // サーバーへ送る操作は許さない
    expect(universe.ghosts.size).toBe(1);
    history.redo(false);
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

  it("接続が切れている間（canEdit が false）はタップで消さず、幽霊も復活させない", () => {
    const { tools, universe, pushOp, at, mine, online } = setup();
    const s = mine(300, 300);
    const g = mine(500, 300);
    universe.deleteStar(g);
    online.editable = false;
    tools.move.up(at(300, 300), true);
    tools.move.up(at(500, 300), true);
    expect(universe.stars.has(s.id)).toBe(true);
    expect(universe.ghosts.has(g.id)).toBe(true);
    expect(pushOp).not.toHaveBeenCalled();
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
