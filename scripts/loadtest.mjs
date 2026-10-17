// 負荷テスト: N人が世界に散らばって動き続けたときの配信遅延とトラフィックを測る。
// 使い方: node scripts/loadtest.mjs [url] [人数] [秒]
//   例) node scripts/loadtest.mjs ws://localhost:8787/ws 300 15
// 本番には向けないこと（ローカルの `wrangler dev` に向ける）。

import { monitorEventLoopDelay } from "node:perf_hooks";

const URL_ = process.argv[2] ?? "ws://localhost:8787/ws";
const N = Number(process.argv[3] ?? 200);
const SECONDS = Number(process.argv[4] ?? 15);
const SPREAD = 3; // 世界の広さ（1 = 1画面ぶん）。人は 0..SPREAD に散らばる

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = { bytes: 0, msgs: 0, open: 0, closed: 0, errors: 0 };
const sentAt = new Map(); // プローブの seq → 送信時刻
const latencies = [];

function makeClient(i, { probe = false } = {}) {
  const ws = new WebSocket(URL_);
  const me = { ws, x: Math.random() * SPREAD, y: Math.random() * SPREAD, timer: null };
  if (probe) {
    me.x = 0.5;
    me.y = 0.5;
  }
  const view = () => [me.x - 0.6, me.y - 0.6, me.x + 0.6, me.y + 0.6].map((v) => Math.round(v * 1000) / 1000);
  // サーバーが指示する送信間隔（welcome / rate）に従う。実クライアントと同じ振る舞い
  me.sendMs = 100;
  const sendLoop = () => {
    if (ws.readyState !== 1) return;
    if (!probe) {
      me.x += (Math.random() - 0.5) * 0.02;
      me.y += (Math.random() - 0.5) * 0.02;
    }
    ws.send(JSON.stringify({ t: "p", x: me.x, y: me.y, c: i % 8, v: view() }));
    me.timer = setTimeout(sendLoop, me.sendMs);
  };
  ws.onopen = () => {
    stats.open++;
    me.timer = setTimeout(sendLoop, 0);
  };
  ws.onmessage = (e) => {
    const data = typeof e.data === "string" ? e.data : "";
    stats.msgs++;
    stats.bytes += data.length;
    if (data.startsWith('{"t":"welcome"') || data.startsWith('{"t":"rate"')) {
      const m = /"sendMs":(\d+)/.exec(data);
      if (m) me.sendMs = Number(m[1]);
    }
    if (probe && data.includes('"pulse"')) {
      const m = JSON.parse(data);
      const t0 = sentAt.get(Math.round(m.x * 1000));
      if (t0 !== undefined) latencies.push(performance.now() - t0);
    }
  };
  ws.onclose = () => {
    stats.closed++;
    clearTimeout(me.timer);
  };
  ws.onerror = () => stats.errors++;
  return me;
}

const pct = (arr, p) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : NaN);

console.log(`connecting ${N} clients to ${URL_} ...`);
const clients = [];
const observer = makeClient(0, { probe: true });
const sender = makeClient(1, { probe: true });
clients.push(observer, sender);
const MAX_IN_FLIGHT = 30; // 接続処理中の数がこれを超えたら待つ（ローカルの接続待ちキューをあふれさせない）
for (let i = 2; i < N; i++) {
  const rampStart = performance.now();
  while (clients.length - stats.open - stats.errors > MAX_IN_FLIGHT && performance.now() - rampStart < 10_000) await sleep(20);
  clients.push(makeClient(i));
}
for (let w = 0; w < 100 && stats.open < N; w++) await sleep(200); // 全員の接続完了を待つ（最大20秒）
await sleep(1000);
console.log(`connected: ${stats.open}/${N} (errors ${stats.errors})`);

// 測定開始
const lag = monitorEventLoopDelay({ resolution: 10 }); // 負荷生成側が飽和していないかの確認用
lag.enable();
stats.bytes = 0;
stats.msgs = 0;
let seq = 1;
const probeTimer = setInterval(() => {
  const s = seq++ % 900;
  sentAt.set(s, performance.now());
  // x に seq を埋め込む（x/1000 刻み）。観測者の視界 [-0.1, 1.1] に収まる
  if (sender.ws.readyState === 1) sender.ws.send(JSON.stringify({ t: "pulse", x: s / 1000, y: 0.5 }));
}, 100);
await sleep(SECONDS * 1000);
clearInterval(probeTimer);

const rate = (v) => Math.round(v / SECONDS).toLocaleString();
console.log("--- result ---");
console.log(`clients open/closed : ${stats.open}/${stats.closed} (errors ${stats.errors})`);
console.log(`received msgs/s     : ${rate(stats.msgs)} (全クライアント合計)`);
console.log(`received KB/s       : ${rate(stats.bytes / 1024)} (全クライアント合計)`);
console.log(`loadgen loop lag  : p95=${(lag.percentile(95) / 1e6).toFixed(1)}ms （大きい場合は計測側が飽和している）`);
console.log(`probe latency ms    : p50=${pct(latencies, 0.5).toFixed(1)} p95=${pct(latencies, 0.95).toFixed(1)} max=${Math.max(...latencies, 0).toFixed(1)} (n=${latencies.length})`);

for (const c of clients) {
  clearTimeout(c.timer);
  c.ws.close();
}
await sleep(300);
process.exit(0);
