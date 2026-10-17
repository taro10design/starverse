// 実環境の遅延を測る（接続は 2 本だけ。本番に向けても安全）。
//
//   node scripts/latency.mjs wss://universe.taroooo0w0.workers.dev/ws [サンプル数]
//
// 送り手 B が波紋（pulse）を送り、受け手 A に届くまでの時間を測る。同じマシンの時計を使うので、
// 片道の遅延（B → サーバー → A）がそのまま出る。多人数の負荷は測れない（同じ接続元の同時接続を
// 制限しているため、1 台のマシンからは負荷をかけられない）。多人数の挙動はローカルの loadtest で見る。

const url = process.argv[2] ?? "ws://localhost:8787/ws";
const SAMPLES = Number(process.argv[3] ?? 60);
const INTERVAL_MS = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];

function connect(label) {
  const ws = new WebSocket(url);
  const c = { label, ws, welcome: null, pulses: [] };
  ws.onmessage = (e) => {
    const text = String(e.data);
    if (text.startsWith('{"t":"welcome"')) c.welcome = JSON.parse(text);
    else if (text.startsWith('{"t":"pulse"')) c.pulses.push({ at: performance.now(), m: JSON.parse(text) });
  };
  c.ready = new Promise((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: "hello", uid: crypto.randomUUID() }));
      const started = performance.now();
      const timer = setInterval(() => {
        if (c.welcome) {
          clearInterval(timer);
          resolve(performance.now() - started);
        } else if (performance.now() - started > 8000) {
          clearInterval(timer);
          reject(new Error(`${label}: welcome が届きません`));
        }
      }, 10);
    };
    ws.onerror = () => reject(new Error(`${label}: 接続できません (${url})`));
  });
  return c;
}

const t0 = performance.now();
const A = connect("A");
const B = connect("B");
const [welcomeMsA, welcomeMsB] = await Promise.all([A.ready, B.ready]);
console.log(
  `接続〜welcome: A=${welcomeMsA.toFixed(0)}ms B=${welcomeMsB.toFixed(0)}ms（合計 ${(performance.now() - t0).toFixed(0)}ms）`,
);

// A は視界を送る（視界のない接続には pulse は配られない）
A.ws.send(JSON.stringify({ t: "p", x: 0.5, y: 0.5, c: 1, v: [-1, -1, 2, 2] }));
B.ws.send(JSON.stringify({ t: "p", x: 0.52, y: 0.5, c: 2, v: [-1, -1, 2, 2] }));
await sleep(500);

const sentAt = new Map();
for (let i = 1; i <= SAMPLES; i++) {
  const x = i / 1000; // x に連番を埋め込む
  sentAt.set(i, performance.now());
  B.ws.send(JSON.stringify({ t: "pulse", x, y: 0.5 }));
  await sleep(INTERVAL_MS);
}
await sleep(1000);

const latencies = [];
for (const { at, m } of A.pulses) {
  const t = sentAt.get(Math.round(m.x * 1000));
  if (t !== undefined) latencies.push(at - t);
}
if (!latencies.length) {
  console.log("波紋が 1 つも届きませんでした");
  process.exit(1);
}
const lost = SAMPLES - latencies.length;
console.log(`片道の遅延 (B → サーバー → A, n=${latencies.length}/${SAMPLES}, 失われた=${lost}):`);
console.log(
  `  p50=${pct(latencies, 0.5).toFixed(1)}ms  p95=${pct(latencies, 0.95).toFixed(1)}ms  max=${Math.max(...latencies).toFixed(1)}ms`,
);
A.ws.close();
B.ws.close();
await sleep(200);
process.exit(0);
