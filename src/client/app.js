import { SOLO } from "./env.js";
import { snap } from "./util.js";
import { Camera } from "./camera.js";
import { Player } from "./player.js";
import { Universe } from "./universe.js";
import { Network } from "./network.js";
import { History } from "./history.js";
import { Input } from "./input.js";
import { Renderer } from "./renderer.js";
import { UI } from "./ui.js";

// ---------------------------------------------------------------------------
// App — 全体の組み立てとメインループ
// ---------------------------------------------------------------------------
export class App {
  constructor() {
    this.canvas = document.getElementById("space");
    this.camera = new Camera();
    this.player = new Player();
    this.universe = new Universe({ solo: SOLO, send: (obj) => this.network.send(obj) });
    this.network = new Network(this);
    this.history = new History(() => this.ui.updateHistoryButtons());
    this.input = new Input(this);
    this.renderer = new Renderer(this, this.canvas);
    this.ui = new UI(this);
    this.t0 = 0;
  }

  init() {
    this.input.bind();
    this.network.connect();
    setInterval(() => this.universe.cleanupExpired(), 15000);
    requestAnimationFrame((t) => this.loop(t));
  }

  loop(t) {
    requestAnimationFrame((n) => this.loop(n));
    const dt = Math.min((t - this.t0) / 16.7, 3) || 1;
    this.t0 = t;
    this.update(dt, t);
    this.renderer.render(t);
  }

  update(dt, t) {
    const { player, camera, universe, renderer, network } = this;
    player.update(dt, t);
    camera.follow(player);
    network.tick(t);
    renderer.updateBackground(dt);
    universe.updatePulses(dt, camera.W, camera.H);
    universe.updatePeers(dt);
  }

  // --- UI から呼ばれる、複数クラスにまたがる操作 ---
  // 消モードでもう一度押す＝自分の星を全部消す
  clearMine() {
    const { universe, history, player, ui } = this;
    const list = [];
    for (const s of [...universe.stars.values()]) {
      if (universe.isMine(s)) {
        list.push(snap(s));
        universe.deleteStar(s);
      }
    }
    if (!list.length) return;
    ui.haptic();
    history.pushOp({
      undo: () => list.forEach((st) => universe.placeStar(st.x, st.y, player.colorIndex, st)),
      redo: () => list.forEach((st) => { const s = universe.stars.get(st.id); if (s) universe.deleteStar(s); }),
    });
  }

  // お化けモードでもう一度押す＝幽霊を全部忘れる
  forgetAllGhosts() {
    if (!this.universe.ghosts.size) return;
    this.universe.forgetAllGhosts();
    this.ui.haptic();
  }

  // 幽霊を全部復活（復活した数を返す）
  reviveAllGhosts() {
    const { universe, history, player } = this;
    const gs = [...universe.ghosts.values()].map((g) => ({ ...g }));
    for (const g of gs) universe.reviveGhost(g);
    if (gs.length) {
      this.ui.haptic();
      history.pushOp({
        undo: () => gs.forEach((g) => { const s = universe.stars.get(g.id); if (s) universe.deleteStar(s); }),
        redo: () => gs.forEach((g) => universe.reviveGhost(g)),
      });
    }
    return gs.length;
  }
}
