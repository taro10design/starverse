import { PALETTES, MAP_SIZE, TOOL_SVG, TOOL_TIPS } from "./constants";
import { DPR, SOLO } from "./env";
import { storage } from "./storage";
import { Onboarding } from "./onboarding";
import { DemoView } from "./demo-view";
import type { DemoKind } from "./demo";
import { must } from "./util";
import type { ToolName } from "./constants";
import type { App } from "./app";

// ---------------------------------------------------------------------------
// UI — DOM の生成とイベント、触覚・音のフィードバック
// ---------------------------------------------------------------------------
const ICON_FOCUS =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" fill="currentColor"/><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const TOOL_ORDER: ToolName[] = ["move", "star", "line", "erase", "ghost"];
const ICON_UNDO =
  '<svg viewBox="0 0 24 24"><path d="M8 5 L3 9.5 L8 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 9.5 L14 9.5 A6 6 0 0 1 14 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_REDO =
  '<svg viewBox="0 0 24 24"><path d="M16 5 L21 9.5 L16 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 9.5 L10 9.5 A6 6 0 0 0 10 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// 説明パネルの、見本つきの項目（見本の種類と説明）
const HELP_DEMOS: [DemoKind, string][] = [
  ["tap", "● 光：空をタップすると、光がそこへ向かう"],
  ["star", "✦ 星：タップで星を置く"],
  ["trace", "✦ 星：なぞると続けて置ける"],
  ["line", "─ 線：星から星へなぞって線を引く"],
  ["erase", "⌫ 消：星をタップで消す。もう一度押すと自分のが全部消える"],
  ["revive", "👻 消えた自分の星は幽霊になる。光でタップすると復活。幽霊ツールでなぞると忘れる"],
  ["pinch", "ピンチ / ホイール — ズーム"],
];

export class UI {
  private hapticEl: HTMLInputElement | null = null;
  private audioCtx: AudioContext | null = null;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  mapEl!: HTMLCanvasElement;
  private toolButtons = new Map<ToolName, HTMLButtonElement>();
  private helpBtn!: HTMLButtonElement;
  private hintEl!: HTMLDivElement;
  private hintView = new DemoView(72, 44);
  readonly onboarding = new Onboarding(storage, () => this.renderOnboarding());

  constructor(private app: App) {
    this.createPalette();
    this.createModeToggle();
    this.createTools();
    this.createZoomControls();
    this.createHelpPanel();
    this.createHint();
    this.createMinimap();
    this.updateHistoryButtons();
    this.renderOnboarding();
  }

  // pointerdown が下のキャンバスに伝わらないようにして実行する
  static onPress(el: HTMLElement, fn: (e: PointerEvent) => void) {
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      fn(e);
    });
  }

  createPalette() {
    const { player, universe, network } = this.app;
    const el = document.createElement("div");
    el.id = "palette";
    PALETTES.forEach((p, i) => {
      const b = document.createElement("button");
      b.className = "swatch" + (i === player.colorIndex ? " sel" : "");
      b.style.setProperty("--c", p.core);
      b.style.setProperty("--g", `rgba(${p.glow.join(",")},0.6)`);
      b.setAttribute("aria-label", "color " + i);
      UI.onPress(b, () => {
        player.setColor(i);
        el.querySelectorAll(".swatch").forEach((s, j) => s.classList.toggle("sel", j === i));
        universe.addPulse(player.x, player.y, 1, p.glow);
        network.sendPosition();
      });
      el.appendChild(b);
    });
    document.body.appendChild(el);
  }

  // ひとり/みんな トグル
  createModeToggle() {
    const b = document.createElement("button");
    b.id = "mode";
    b.title = SOLO ? "みんなの宇宙へ" : "ひとりの宇宙へ";
    b.innerHTML = SOLO
      ? '<span class="dot1"></span><span class="lbl">ひとり</span>'
      : '<span class="dot1"></span><span class="dot1"></span><span class="lbl">みんな</span>';
    UI.onPress(b, () => {
      location.href = SOLO ? location.pathname : location.pathname + "?solo";
    });
    document.body.appendChild(b);
  }

  createTools() {
    const { input } = this.app;
    const el = document.createElement("div");
    el.id = "tools";
    TOOL_ORDER.forEach((name, i) => {
      const b = document.createElement("button");
      b.className = "tool" + (name === input.tool ? " on" : "");
      b.innerHTML = TOOL_SVG[name];
      b.title = `${TOOL_TIPS[name]} (${i + 1})`;
      b.setAttribute("aria-label", TOOL_TIPS[name]);
      UI.onPress(b, () => {
        if (name === "erase" && input.tool === "erase") return this.app.clearMine(); // もう一度押す＝自分の星を全部消す
        if (name === "ghost" && input.tool === "ghost") return this.app.forgetAllGhosts(); // もう一度押す＝幽霊を全部忘れる
        this.selectTool(name);
      });
      this.toolButtons.set(name, b);
      el.appendChild(b);
    });

    const undoB = (this.undoBtn = document.createElement("button"));
    undoB.className = "tool hist dim";
    undoB.style.marginLeft = "10px";
    undoB.innerHTML = ICON_UNDO;
    undoB.title = "もどす (Ctrl+Z)";
    UI.onPress(undoB, () => this.app.undo());
    el.appendChild(undoB);

    const redoB = (this.redoBtn = document.createElement("button"));
    redoB.className = "tool hist dim";
    redoB.innerHTML = ICON_REDO;
    redoB.title = "やりなおす (Ctrl+Y)";
    UI.onPress(redoB, () => this.app.redo());
    el.appendChild(redoB);

    document.body.appendChild(el);
  }

  // ツールを切り替える（ボタンでもキーボードでも）
  selectTool(name: ToolName) {
    this.app.input.setTool(name);
    for (const [n, b] of this.toolButtons) b.classList.toggle("on", n === name);
    this.onboarding.toolSelected(name);
  }

  // 画面上の拡大・縮小・戻るボタン。ドラッグやキーが使えなくても、ポインタ1つで同じことができるようにする
  createZoomControls() {
    const { camera } = this.app;
    const el = document.createElement("div");
    el.id = "zoomctl";
    const add = (label: string, title: string, fn: () => void, svg?: string) => {
      const b = document.createElement("button");
      b.className = "tool";
      if (svg) b.innerHTML = svg;
      else b.textContent = label;
      b.title = title;
      b.setAttribute("aria-label", title);
      UI.onPress(b, fn);
      el.appendChild(b);
    };
    add("+", "ズームイン (+)", () => camera.zoomBy(1.4));
    add("−", "ズームアウト (-)", () => camera.zoomBy(1 / 1.4));
    add("", "自分の光に戻る (0)", () => this.app.focusLight(), ICON_FOCUS);
    document.body.appendChild(el);
  }

  updateHistoryButtons() {
    const { history } = this.app;
    this.undoBtn.classList.toggle("dim", !history.canUndo);
    this.redoBtn.classList.toggle("dim", !history.canRedo);
  }

  // 「?」の説明パネル。見本の動きがある項目は、押すとその下に小さな見本が開く（もう一度押すと閉じる）
  createHelpPanel() {
    const btn = (this.helpBtn = document.createElement("button"));
    btn.id = "helpbtn";
    btn.textContent = "?";
    btn.setAttribute("aria-label", "操作の説明");
    const help = document.createElement("div");
    help.id = "help";
    help.innerHTML = `
  <p class="head">見本つき — 押すと動きが見られる</p>
  ${HELP_DEMOS.map(([kind, text]) => `<button class="demo-item" data-demo="${kind}"><span>${text}</span><span class="play">▶</span></button>`).join("")}
  <p class="head">ほかに</p>
  <p class="dim">他人の星をタップ — きらめきを送る。その星は長生きする</p>
  <p class="dim">近くの星どうしは線でつながって星座に。すごく近い 2 つは連星になって回る</p>
  <p class="dim">下の点 — 自分の色。右上の地図 — 触れた場所へ光を送る</p>
  <p class="dim">右下 — ひとりの宇宙と切り替え。${SOLO ? "ひとりの宇宙では、星はここに残る" : "混んだ場所の星は早く消え、見てもらった星は長生きする"}</p>
  <p class="dim">PC：Space+ドラッグ / 中・右ドラッグ / 矢印・WASD で移動（Shift で速く）、+ − でズーム、0 で自分の光へ、1〜5 でツール</p>
  <p class="dim"><button id="revivebtn">幽霊を全部復活</button> <button id="keybtn">鍵リンクをコピー</button></p>
  <p class="dim">鍵リンク — 別の端末・ブラウザでも自分の星として開ける</p>
`;
    const view = new DemoView(200, 110);
    const open = (yes: boolean) => {
      help.classList.toggle("open", yes);
      if (yes) this.onboarding.helpOpened();
      else {
        view.stop();
        view.canvas.remove();
      }
    };
    UI.onPress(btn, () => open(!help.classList.contains("open")));
    document.body.appendChild(btn);
    document.body.appendChild(help);

    for (const item of help.querySelectorAll<HTMLButtonElement>(".demo-item")) {
      UI.onPress(item, () => {
        const shown = item.nextElementSibling === view.canvas;
        view.stop();
        view.canvas.remove();
        for (const i of help.querySelectorAll(".demo-item")) i.classList.remove("on");
        if (shown) return;
        item.after(view.canvas);
        item.classList.add("on");
        view.play(item.dataset.demo as DemoKind);
      });
    }

    const keyBtn = must(help.querySelector<HTMLElement>("#keybtn"), "#keybtn");
    UI.onPress(keyBtn, () => this.copyKeyLink(keyBtn));

    const reviveBtn = must(help.querySelector<HTMLElement>("#revivebtn"), "#revivebtn");
    UI.onPress(reviveBtn, () => {
      const n = this.app.reviveAllGhosts();
      reviveBtn.textContent = n ? `${n}個復活した` : "幽霊がいない";
      setTimeout(() => (reviveBtn.textContent = "幽霊を全部復活"), 1500);
    });

    // パネル外をタップしたら閉じる
    addEventListener("pointerdown", (e) => {
      if (
        help.classList.contains("open") &&
        e.target !== btn &&
        !(e.target instanceof Element && e.target.closest("#help"))
      ) {
        open(false);
      }
    });
  }

  // 初めての人への 1 行の案内（見本の動きつき）。キャンバスの操作を邪魔しないよう、触れても下に通す
  createHint() {
    const el = (this.hintEl = document.createElement("div"));
    el.id = "hint";
    el.setAttribute("role", "status"); // 読み上げにも、案内が変わったことを伝える
    el.append(this.hintView.canvas, document.createElement("span"));
    document.body.appendChild(el);
  }

  // Onboarding の状態を画面に映す（案内の文と見本、光らせるボタン、「?」の光）
  renderOnboarding() {
    const o = this.onboarding;
    const el = this.hintEl;
    const text = o.hint;
    el.classList.toggle("show", text !== null);
    if (text !== null) must(el.querySelector("span"), "#hint span").textContent = text;
    if (o.demo) {
      this.hintView.canvas.hidden = false;
      this.hintView.play(o.demo);
    } else {
      this.hintView.stop();
      this.hintView.canvas.hidden = true;
    }
    for (const [name, b] of this.toolButtons) b.classList.toggle("beckon", name === o.beckon);
    this.helpBtn.classList.toggle("beckon", o.pulseHelp);
  }

  // 「鍵リンク」＝uid入りURL。このリンクで開くとどのブラウザでも自分の星のまま
  copyKeyLink(keyBtn: HTMLElement) {
    const url = location.origin + location.pathname + "?key=" + this.app.universe.uid;
    const done = () => {
      keyBtn.textContent = "コピーした";
      setTimeout(() => (keyBtn.textContent = "鍵リンクをコピー"), 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(url)
        .then(done)
        .catch(() => prompt("このリンクを保存してね", url));
    } else {
      prompt("このリンクを保存してね", url);
    }
  }

  // 右上のちいさな地図
  createMinimap() {
    const { input, camera, renderer } = this.app;
    const map = (this.mapEl = document.createElement("canvas"));
    map.id = "minimap";
    map.width = MAP_SIZE * DPR;
    map.height = MAP_SIZE * DPR;
    document.body.appendChild(map);
    renderer.setMinimap(map);
    map.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      input.startMapDrag(e);
      camera.free = false;
    });
  }

  // Androidはnavigator.vibrate、iOS Safariはswitchハックで触覚を出す
  haptic() {
    try {
      if (navigator.vibrate && navigator.vibrate(12)) return;
    } catch {
      // 触覚に対応していない環境では何もしない
    }
    try {
      if (!this.hapticEl) {
        const el = (this.hapticEl = document.createElement("input"));
        el.type = "checkbox";
        el.setAttribute("switch", "");
        el.style.cssText = "position:fixed;top:-200px;opacity:0;pointer-events:none";
        document.body.appendChild(el);
      }
      this.hapticEl.click();
    } catch {
      // 触覚に対応していない環境では何もしない
    }
  }

  ping() {
    try {
      const actx = (this.audioCtx =
        this.audioCtx ||
        new (
          window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        )());
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = "sine";
      o.frequency.value = 620 + Math.random() * 300;
      g.gain.setValueAtTime(0.06, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.9);
      o.connect(g).connect(actx.destination);
      o.start();
      o.stop(actx.currentTime + 0.9);
    } catch {
      // 音を出せない環境（自動再生の制限など）では何もしない
    }
  }
}
