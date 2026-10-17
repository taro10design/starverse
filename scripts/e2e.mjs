// E2E 確認: 動いているサーバー（ローカルまたは本番）に WebSocket で接続して、一連の流れを確かめる。
//
//   node scripts/e2e.mjs http://localhost:8787 --full   # ローカル向け。星・線・上限・再接続まで確認（書き込みあり）
//   node scripts/e2e.mjs https://uchu.pages.dev          # 本番向け。読み取りだけ（星や線は作らない）
//
// 終了コードは、全部通れば 0、失敗があれば 1。

const base = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
const FULL = process.argv.includes("--full");
const wsUrl =
  (process.env.E2E_WS ??
    base.replace(/^http/, "ws").replace(/^wss?:\/\/uchu\.pages\.dev/, "wss://universe.taroooo0w0.workers.dev")) + "/ws";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
}

// 接続して、受け取ったメッセージを貯める小さなクライアント
function client(label) {
  const ws = new WebSocket(wsUrl);
  const c = { label, ws, got: [], raw: [], closed: false, closeCode: null };
  ws.onmessage = (e) => {
    c.raw.push(e.data);
    if (typeof e.data === "string" && e.data.startsWith("{")) c.got.push(JSON.parse(e.data));
  };
  ws.onclose = (e) => {
    c.closed = true;
    c.closeCode = e.code;
  };
  c.send = (o) => ws.send(typeof o === "string" ? o : JSON.stringify(o));
  c.waitFor = async (pred, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = c.got.find(pred);
      if (m) return m;
      await sleep(20);
    }
    return null;
  };
  c.opened = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error(`${label}: 接続できません (${wsUrl})`));
    setTimeout(() => rej(new Error(`${label}: 接続がタイムアウトしました`)), 8000);
  });
  return c;
}

const uid = () => crypto.randomUUID();

try {
  // --- ページと統計 ---
  const page = await fetch(base + "/");
  const html = await page.text();
  check("トップページが表示できる", page.ok && html.includes('<canvas id="space"'), `status ${page.status}`);
  const script = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  if (script) {
    const js = await fetch(base + script);
    check("JS バンドルが取得できる", js.ok, script);
  }

  // --- 接続と welcome ---
  const A = client("A");
  const B = client("B");
  await Promise.all([A.opened, B.opened]);
  const welcomeA = await A.waitFor((m) => m.t === "welcome");
  check(
    "welcome を受け取る（id・sendMs・star/link 一覧つき）",
    !!welcomeA &&
      typeof welcomeA.id === "string" &&
      typeof welcomeA.sendMs === "number" &&
      Array.isArray(welcomeA.stars) &&
      Array.isArray(welcomeA.links),
  );
  check(
    "送信間隔の指示が妥当（100〜1000ms）",
    welcomeA && welcomeA.sendMs >= 100 && welcomeA.sendMs <= 1000,
    `sendMs=${welcomeA?.sendMs}`,
  );

  // --- 位置の配信 ---
  A.send({ t: "p", x: 0.5, y: 0.5, c: 1, v: [-1, -1, 2, 2] });
  B.send({ t: "p", x: 0.52, y: 0.5, c: 2, v: [-1, -1, 2, 2] });
  const welcomeB = await B.waitFor((m) => m.t === "welcome");
  const seen = await A.waitFor((m) => m.t === "ps" && m.d.some((p) => p[0] === welcomeB?.id));
  check("他の人の位置(ps)が視界内に届く", !!seen);
  const tuple = seen?.d.find((p) => p[0] === welcomeB?.id);
  check(
    "位置のタプルが [id, x, y, color] の形",
    Array.isArray(tuple) && tuple.length === 4 && typeof tuple[1] === "number" && tuple[3] === 2,
    JSON.stringify(tuple),
  );

  // 遠い視界の相手には届かない（視界ベースの配信）
  const FAR = client("FAR");
  await FAR.opened;
  await FAR.waitFor((m) => m.t === "welcome");
  FAR.send({ t: "p", x: 500, y: 500, c: 0, v: [499, 499, 501, 501] });
  await sleep(300);
  A.send({ t: "pulse", x: 0.5, y: 0.5 });
  await sleep(600);
  check("視界の遠い相手には、近くの波紋が届かない", !FAR.got.some((m) => m.t === "pulse"));

  // --- 死活監視 ---
  B.send("ping");
  const pong = await (async () => {
    for (let i = 0; i < 100; i++) {
      if (B.raw.includes("pong")) return true;
      await sleep(20);
    }
    return false;
  })();
  check("ping に pong が返る", pong);

  // --- 不正な入力は無視され、接続は保たれる ---
  B.send("not json at all");
  B.send({ t: "star", id: "x", x: "NaN", y: 0 });
  B.send({ t: "star", id: "x", x: 1e9, y: 0 });
  B.send({ t: "evil" });
  B.send(JSON.stringify({ t: "p", x: 0.5, y: 0.5, c: 1 }) + " ".repeat(2000)); // 大きすぎるメッセージ
  await sleep(300);
  check("不正な入力のあとも接続が保たれる", !B.closed && B.ws.readyState === 1);

  // --- 統計 ---
  const statsRes = await fetch(base + "/stats");
  const stats = statsRes.ok ? await statsRes.json() : null;
  check(
    "/stats が接続数を返す",
    !!stats && typeof stats.totalConnections === "number" && stats.totalConnections >= 2 && Array.isArray(stats.rooms),
    stats ? `total=${stats.totalConnections}` : `status ${statsRes.status}`,
  );

  if (FULL) {
    // --- 星と線 ---
    const owner = uid();
    const ids = { s1: "e2e-" + uid().slice(0, 8), s2: "e2e-" + uid().slice(0, 8), l1: "e2e-" + uid().slice(0, 8) };
    B.send({ t: "star", id: ids.s1, x: 0.1, y: 0.1, uid: owner });
    B.send({ t: "star", id: ids.s2, x: 0.2, y: 0.2, uid: owner });
    const star = await A.waitFor((m) => m.t === "star" && m.id === ids.s1);
    check("星の配置が他の人に届く", !!star && star.by === owner);
    B.send({ t: "link", id: ids.l1, a: ids.s1, b: ids.s2, uid: owner });
    check("線が他の人に届く", !!(await A.waitFor((m) => m.t === "link" && m.id === ids.l1)));

    // 他人は同じ id の星を上書きできない
    A.send({ t: "star", id: ids.s1, x: 9, y: 9, uid: uid() });
    await sleep(300);

    // --- 再接続して welcome に反映されている ---
    const C = client("C");
    await C.opened;
    const welcomeC = await C.waitFor((m) => m.t === "welcome");
    const s1 = welcomeC?.stars.find((s) => s.id === ids.s1);
    check("再接続した人の welcome に星と線が入っている", !!s1 && welcomeC.links.some((l) => l.id === ids.l1));
    check("他人は星を上書きできない", !!s1 && s1.by === owner && s1.x === 0.1);

    // --- 線は持ち主だけが消せる ---
    A.send({ t: "unlink", id: ids.l1, uid: uid() });
    await sleep(300);
    const C2 = client("C2");
    await C2.opened;
    const w2 = await C2.waitFor((m) => m.t === "welcome");
    check("持ち主以外は線を消せない", !!w2?.links.some((l) => l.id === ids.l1));
    C2.ws.close();

    // --- 1 人あたりの星の上限 ---
    const heavy = uid();
    const created = [];
    for (let i = 0; i < 100; i++) {
      const id = "e2e-" + uid().slice(0, 8);
      created.push(id);
      B.send({ t: "star", id, x: 10 + i * 0.3, y: 10, uid: heavy });
      if (i % 20 === 19) await sleep(600); // レート制限に当たらない程度に
    }
    await sleep(800);
    const C3 = client("C3");
    await C3.opened;
    const w3 = await C3.waitFor((m) => m.t === "welcome");
    const mine = w3.stars.filter((s) => s.by === heavy).length;
    check("1 人あたりの星の上限(64)を超えない", mine > 0 && mine <= 64, `${mine} 個`);
    C3.ws.close();

    // --- 後片付け（作った星を消す。線は星の消滅で一緒に消える） ---
    const cleanup = [ids.s1, ids.s2, ...created];
    for (let i = 0; i < cleanup.length; i++) {
      B.send({ t: "unstar", id: cleanup[i] });
      if (i % 20 === 19) await sleep(600); // レート制限に当たらない程度に
    }
    await sleep(800);
    const C4 = client("C4");
    await C4.opened;
    const w4 = await C4.waitFor((m) => m.t === "welcome");
    const mineLeft = w4.stars.filter((s) => cleanup.includes(s.id)).length;
    check(
      "後片付けで作った星と線が残っていない",
      mineLeft === 0 && !w4.links.some((l) => l.id === ids.l1),
      `残り ${mineLeft} 個`,
    );
    C4.ws.close();
  }

  // --- 切断が伝わる ---
  const leavingId = welcomeB?.id;
  B.ws.close();
  const left = await A.waitFor((m) => m.t === "leave" && m.id === leavingId);
  check("誰かが抜けると leave が届く", !!left);

  for (const c of [A, FAR]) c.ws.close();
} catch (err) {
  console.error("ERROR:", err.message);
  failed++;
}

console.log(failed === 0 ? "\nすべて成功" : `\n${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
