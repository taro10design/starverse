import { PALETTES, MAP_SIZE, TOOL_SVG, TOOL_TIPS } from "../../constants.js";
import { DPR, SOLO } from "./env.js";

// ---------------------------------------------------------------------------
// UI — DOM の生成とイベント、触覚・音のフィードバック
// ---------------------------------------------------------------------------
const ICON_UNDO = '<svg viewBox="0 0 24 24"><path d="M8 5 L3 9.5 L8 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 9.5 L14 9.5 A6 6 0 0 1 14 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_REDO = '<svg viewBox="0 0 24 24"><path d="M16 5 L21 9.5 L16 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 9.5 L10 9.5 A6 6 0 0 0 10 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

export class UI {
  constructor(app) {
    this.app = app;
    this.hapticEl = null;
    this.audioCtx = null;
    this.createPalette();
    this.createModeToggle();
    this.createTools();
    this.createHelpPanel();
    this.createMinimap();
    this.updateHistoryButtons();
  }

  // pointerdown が下のキャンバスに伝わらないようにして実行する
  static onPress(el, fn) {
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      fn(e);
    });
  }

  createPalette() {
    const { player, universe, network } = this.app;
    const el = (this.paletteEl = document.createElement("div"));
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
    const { input, history } = this.app;
    const el = (this.toolsEl = document.createElement("div"));
    el.id = "tools";
    for (const name of ["move", "star", "line", "erase", "ghost"]) {
      const b = document.createElement("button");
      b.className = "tool" + (name === input.tool ? " on" : "");
      b.innerHTML = TOOL_SVG[name];
      b.title = TOOL_TIPS[name];
      b.setAttribute("aria-label", TOOL_TIPS[name]);
      UI.onPress(b, () => {
        if (name === "erase" && input.tool === "erase") return this.app.clearMine(); // もう一度押す＝自分の星を全部消す
        if (name === "ghost" && input.tool === "ghost") return this.app.forgetAllGhosts(); // もう一度押す＝幽霊を全部忘れる
        input.setTool(name);
        el.querySelectorAll(".tool").forEach((t) => t.classList.toggle("on", t === b));
      });
      el.appendChild(b);
    }

    const undoB = (this.undoBtn = document.createElement("button"));
    undoB.className = "tool hist dim";
    undoB.style.marginLeft = "10px";
    undoB.innerHTML = ICON_UNDO;
    undoB.title = "もどす (Ctrl+Z)";
    UI.onPress(undoB, () => history.undo());
    el.appendChild(undoB);

    const redoB = (this.redoBtn = document.createElement("button"));
    redoB.className = "tool hist dim";
    redoB.innerHTML = ICON_REDO;
    redoB.title = "やりなおす (Ctrl+Y)";
    UI.onPress(redoB, () => history.redo());
    el.appendChild(redoB);

    document.body.appendChild(el);
  }

  updateHistoryButtons() {
    const { history } = this.app;
    this.undoBtn.classList.toggle("dim", !history.canUndo);
    this.redoBtn.classList.toggle("dim", !history.canRedo);
  }

  createHelpPanel() {
    const btn = (this.helpBtn = document.createElement("button"));
    btn.id = "helpbtn";
    btn.textContent = "?";
    const help = (this.helpEl = document.createElement("div"));
    help.id = "help";
    help.innerHTML = `
  <p>左下 — モードを切り替える</p>
  <p class="dim">● 光：タップで波、動かすとついてくる。自分の星タップで消える</p>
  <p class="dim">他人の星をタップ — きらめきを送る。その星は長生きする</p>
  <p class="dim">✦ 星：タップで置く、なぞると連続で置ける</p>
  <p class="dim">─ 線：星から星へなぞって自分で線を引く</p>
  <p class="dim">⌫ 消：誰の星でも消せる。もう一度押すと自分のが全部消える</p>
  <p class="dim">👻 幽霊：消えた自分の星をなぞって忘れる。もう一度押すと全部忘れる</p>
  <p class="dim">消えた自分の星は幽霊として残る。光モードでタップすると復活</p>
  <p class="dim"><button id="revivebtn">幽霊を全部復活</button></p>
  <p>近くの星どうし — 線がつながって星座に</p>
  <p>すごく近い2つ — 連星になって回る</p>
  <p>ピンチ / ホイール — ズーム</p>
  <p>下の点 — 自分の色</p>
  <p>右上の地図 — 触れた場所へ光を送る</p>
  <p>右下 — ひとりの宇宙と切り替え</p>
  <p class="dim">${SOLO ? "ひとりの宇宙。星はここに残る" : "同じ空を誰かと見ている。混んだ場所の星は早く消え、見てもらった星は長生きする"}</p>
  <p class="dim"><button id="keybtn">鍵リンクをコピー</button> 別の端末・ブラウザでも自分の星として開ける</p>

`;
    UI.onPress(btn, () => help.classList.toggle("open"));
    document.body.appendChild(btn);
    document.body.appendChild(help);

    const keyBtn = help.querySelector("#keybtn");
    UI.onPress(keyBtn, () => this.copyKeyLink(keyBtn));

    const reviveBtn = help.querySelector("#revivebtn");
    UI.onPress(reviveBtn, () => {
      const n = this.app.reviveAllGhosts();
      reviveBtn.textContent = n ? `${n}個復活した` : "幽霊がいない";
      setTimeout(() => (reviveBtn.textContent = "幽霊を全部復活"), 1500);
    });

    let seen = false;
    try {
      seen = !!localStorage.getItem("uchu-seen");
    } catch {}
    if (!seen) help.classList.add("open");

    // パネル外をタップしたら閉じる
    addEventListener("pointerdown", (e) => {
      if (help.classList.contains("open") && e.target !== btn && !(e.target.closest && e.target.closest("#help"))) {
        help.classList.remove("open");
        try {
          localStorage.setItem("uchu-seen", "1");
        } catch {}
      }
    });
  }

  // 「鍵リンク」＝uid入りURL。このリンクで開くとどのブラウザでも自分の星のまま
  copyKeyLink(keyBtn) {
    const url = location.origin + location.pathname + "?key=" + this.app.universe.uid;
    const done = () => {
      keyBtn.textContent = "コピーした";
      setTimeout(() => (keyBtn.textContent = "鍵リンクをコピー"), 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(() => prompt("このリンクを保存してね", url));
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
    } catch {}
    try {
      if (!this.hapticEl) {
        const el = (this.hapticEl = document.createElement("input"));
        el.type = "checkbox";
        el.setAttribute("switch", "");
        el.style.cssText = "position:fixed;top:-200px;opacity:0;pointer-events:none";
        document.body.appendChild(el);
      }
      this.hapticEl.click();
    } catch {}
  }

  ping() {
    try {
      const actx = (this.audioCtx = this.audioCtx || new (window.AudioContext || window.webkitAudioContext)());
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = "sine";
      o.frequency.value = 620 + Math.random() * 300;
      g.gain.setValueAtTime(0.06, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.9);
      o.connect(g).connect(actx.destination);
      o.start();
      o.stop(actx.currentTime + 0.9);
    } catch {}
  }
}
