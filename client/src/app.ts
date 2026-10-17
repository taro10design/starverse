import { DEBUG, SOLO } from "./env";
import { snap } from "./util";
import { Camera } from "./camera";
import { Player } from "./player";
import { Universe } from "./universe";
import { Network } from "./network";
import { History } from "./history";
import { Input } from "./input";
import { Renderer } from "./renderer";
import { UI } from "./ui";

// ---------------------------------------------------------------------------
// App — 全体の組み立てとメインループ
// ---------------------------------------------------------------------------
export class App {
  readonly canvas = document.getElementById("space") as HTMLCanvasElement;
  readonly camera = new Camera();
  readonly player = new Player();
  readonly universe = new Universe(SOLO, (msg) => this.network.send(msg));
  readonly network = new Network(this);
  readonly history = new History(() => this.ui.updateHistoryButtons());
  readonly input = new Input(this);
  readonly renderer = new Renderer(this, this.canvas);
  readonly ui: UI = new UI(this);
  private t0 = 0;

  init() {
    if (DEBUG) Object.defineProperty(window, "__app", { value: this }); // `?debug` のときだけ、動作確認用に公開
    this.input.bind();
    this.network.connect();
    setInterval(() => this.universe.cleanupExpired(), 15000);
    requestAnimationFrame((t) => this.loop(t));
  }

  loop(t: number) {
    requestAnimationFrame((n) => this.loop(n));
    const dt = Math.min((t - this.t0) / 16.7, 3) || 1;
    this.t0 = t;
    this.update(dt, t);
    this.renderer.render(t);
  }

  update(dt: number, t: number) {
    const { player, camera, universe, renderer, network } = this;
    this.input.update(dt);
    player.update(dt, t);
    camera.follow(player);
    network.tick(t);
    renderer.updateBackground(dt);
    universe.updatePulses(dt, camera.W, camera.H);
    universe.updatePeers(dt);
  }

  // --- UI / 入力から呼ばれる、複数クラスにまたがる操作 ---
  // サーバーへ送る操作（星・線・消去・アンドゥ）をしてよいか。ソロは常に可。
  // オンラインは、つながっていて welcome で持ち主 ID が分かっている間だけ
  canEdit(): boolean {
    return SOLO || this.network.ready;
  }

  // アンドゥ / リドゥの多くはサーバーへ送る操作なので、切れている間はローカルだけの操作（幽霊）に限る
  undo() {
    this.history.undo(this.canEdit());
  }
  redo() {
    this.history.redo(this.canEdit());
  }

  // 自分の光を中心に、倍率も初期値へ戻す
  focusLight() {
    this.camera.focusOn(this.player.x, this.player.y);
  }

  // 消モードでもう一度押す＝自分の星を全部消す
  clearMine() {
    if (!this.canEdit()) return;
    const { universe, history, ui } = this;
    const list: ReturnType<typeof snap>[] = [];
    for (const s of [...universe.stars.values()]) {
      if (universe.isMine(s)) {
        list.push(snap(s));
        universe.deleteStar(s);
      }
    }
    if (!list.length) return;
    ui.haptic();
    history.pushOp({
      undo: () => list.forEach((st) => universe.placeStar(st.x, st.y, st.c, st)),
      redo: () =>
        list.forEach((st) => {
          const s = universe.stars.get(st.id);
          if (s) universe.deleteStar(s);
        }),
    });
  }

  // お化けモードでもう一度押す＝幽霊を全部忘れる
  forgetAllGhosts() {
    if (!this.universe.ghosts.size) return;
    this.universe.forgetAllGhosts();
    this.ui.haptic();
  }

  // 幽霊を全部復活（復活した数を返す）
  // 上限で置けなかった幽霊は幽霊のまま残る
  reviveAllGhosts(): number {
    if (!this.canEdit()) return 0;
    const { universe, history } = this;
    const gs = [...universe.ghosts.values()].map((g) => ({ ...g })).filter((g) => universe.reviveGhost(g));
    if (gs.length) {
      this.ui.haptic();
      history.pushOp({
        undo: () =>
          gs.forEach((g) => {
            const s = universe.stars.get(g.id);
            if (s) universe.deleteStar(s);
          }),
        redo: () => gs.forEach((g) => universe.reviveGhost(g)),
      });
    }
    return gs.length;
  }
}
