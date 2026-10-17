// E2E 確認: 動いているサーバー（ローカルまたは本番）に WebSocket で接続して、一連の流れを確かめる。
//
//   node scripts/e2e.mjs http://localhost:8787 --full   # ローカル向け。星・線・上限・再接続まで確認（書き込みあり）
//   node scripts/e2e.mjs https://uchu.pages.dev          # 本番向け。読み取りだけ（hello して welcome を見る。星や線は作らない）
//
// /stats は token が要る。E2E_STATS_TOKEN を渡すと、そのトークンで中身まで確かめる（ローカルは .dev.vars の値）。
//   E2E_STATS_TOKEN=dev-stats-token node scripts/e2e.mjs http://localhost:8787 --full
//
// 本番は同じ接続元からの接続の頻度をエッジのレート制限ルールで絞る（ADR 0009）ので、読み取りだけのモードは開く本数を少なくしている。
// 終了コードは、全部通れば 0、失敗があれば 1。

const base = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
const FULL = process.argv.includes("--full");
const STATS_TOKEN = process.env.E2E_STATS_TOKEN;
const wsUrl =
  (process.env.E2E_WS ??
    base.replace(/^http/, "ws").replace(/^wss?:\/\/uchu\.pages\.dev/, "wss://universe.taroooo0w0.workers.dev")) + "/ws";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
}
function skip(name, why) {
  console.log(`SKIP  ${name}  (${why})`);
}

// サーバーが保存にだけ使う項目（StoredStar / StoredLink）。配信に出てきたら漏れている
const SERVER_ONLY = ["born", "v"];
const hasServerOnly = (o) => SERVER_ONLY.some((k) => Object.hasOwn(o, k));

// 開いたすべての接続。uid の漏れは、全員の全受信フレームの生の文字列で確かめる
const clients = [];
// 受け取ったどのフレームの生の文字列にも、どの接続の uid も含まれていないか。含まれていれば、その説明を返す
function uidLeaks() {
  const uids = clients.map((c) => c.uid).filter((u) => /^[\w-]{8,64}$/.test(u)); // 形式に合う uid だけが使われる
  const found = [];
  for (const c of clients)
    for (const raw of c.raw)
      for (const u of uids)
        if (typeof raw === "string" && raw.includes(u)) found.push(`${c.label} が ${u.slice(0, 8)}… を受信`);
  return found;
}

const newUid = () => crypto.randomUUID();
const newId = () => "e2e-" + crypto.randomUUID().slice(0, 8);

// 接続して、受け取ったメッセージを貯める小さなクライアント。
// 開いたら最初に hello を送る（hello: false なら送らない。あとで c.hello() で送れる）
function client(label, { uid = newUid(), hello = true } = {}) {
  const ws = new WebSocket(wsUrl);
  const c = { label, uid, ws, got: [], raw: [], closed: false, closeCode: null };
  clients.push(c);
  ws.onmessage = (e) => {
    c.raw.push(e.data);
    if (typeof e.data === "string" && e.data.startsWith("{")) c.got.push(JSON.parse(e.data));
  };
  ws.onclose = (e) => {
    c.closed = true;
    c.closeCode = e.code;
  };
  c.send = (o) => ws.send(typeof o === "string" ? o : JSON.stringify(o));
  c.hello = () => c.send({ t: "hello", uid: c.uid });
  c.waitFor = async (pred, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = c.got.find(pred);
      if (m) return m;
      await sleep(20);
    }
    return null;
  };
  c.waitClosed = async (ms = 3000) => {
    const t0 = Date.now();
    while (!c.closed && Date.now() - t0 < ms) await sleep(20);
    return c.closed;
  };
  c.opened = new Promise((res, rej) => {
    ws.onopen = () => {
      if (hello) c.hello();
      res();
    };
    ws.onerror = () => rej(new Error(`${label}: 接続できません (${wsUrl})`));
    setTimeout(() => rej(new Error(`${label}: 接続がタイムアウトしました`)), 8000);
  });
  c.welcome = () => c.waitFor((m) => m.t === "welcome");
  return c;
}

// 1 回だけつないで welcome を受け取り、すぐ閉じる（保存された状態の確認用）
async function snapshot(label) {
  const c = client(label);
  await c.opened;
  const w = await c.welcome();
  c.ws.close();
  return w;
}

const HEX32 = /^[0-9a-f]{32}$/;

try {
  // --- ページ ---
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
  const welcomeA = await A.welcome();
  check(
    "hello に welcome が返る（id・me・sendMs・star/link 一覧つき）",
    !!welcomeA &&
      typeof welcomeA.id === "string" &&
      typeof welcomeA.me === "string" &&
      typeof welcomeA.sendMs === "number" &&
      Array.isArray(welcomeA.stars) &&
      Array.isArray(welcomeA.links),
  );
  check(
    "welcome の me は uid のハッシュ（32 文字の 16 進数で、uid そのものではない）",
    !!welcomeA && HEX32.test(welcomeA.me) && welcomeA.me !== A.uid && !welcomeA.me.includes(A.uid.slice(0, 8)),
    welcomeA?.me,
  );
  // 空に 1 人だけのときは最長の 1000ms になる（A が B より先に welcome を受け取った場合）
  check(
    "送信間隔の指示が妥当（100〜1000ms）",
    welcomeA && welcomeA.sendMs >= 100 && welcomeA.sendMs <= 1000,
    `sendMs=${welcomeA?.sendMs}`,
  );

  // --- 位置の配信 ---
  A.send({ t: "p", x: 0.5, y: 0.5, c: 1, v: [-1, -1, 2, 2] });
  B.send({ t: "p", x: 0.52, y: 0.5, c: 2, v: [-1, -1, 2, 2] });
  const welcomeB = await B.welcome();
  const seen = await A.waitFor((m) => m.t === "ps" && m.d.some((p) => p[0] === welcomeB?.id));
  check("他の人の位置(ps)が視界内に届く", !!seen);
  const tuple = seen?.d.find((p) => p[0] === welcomeB?.id);
  check(
    "位置のタプルが [id, x, y, color] の形",
    Array.isArray(tuple) && tuple.length === 4 && typeof tuple[1] === "number" && tuple[3] === 2,
    JSON.stringify(tuple),
  );
  check("別の uid は別の持ち主になる", !!welcomeB && welcomeB.me !== welcomeA?.me);

  // 遠い視界の相手には届かない（視界ベースの配信）
  // FAR は、いる場所は A の近くで、見ている範囲だけが遠い。A が FAR の位置を受け取れば、同じメッセージの視界も届いている
  const FAR = client("FAR");
  await FAR.opened;
  const welcomeFar = await FAR.welcome();
  FAR.send({ t: "p", x: 0.48, y: 0.5, c: 0, v: [499, 499, 501, 501] });
  const farSeen = await A.waitFor((m) => m.t === "ps" && m.d.some((p) => p[0] === welcomeFar?.id));
  A.send({ t: "pulse", x: 0.5, y: 0.5 });
  // 近くの B に届いた時点で、サーバーは波紋を配り終えている
  const nearPulse = await B.waitFor((m) => m.t === "pulse");
  // そのあとに FAR へ必ず届くもの（短い接続の leave。leave は視界に関係なく全員に届く）が届くのを待ってから判定する。
  // 1 つの接続への配信は送った順に届くので、leave が届いた時点で、波紋が FAR に送られていればもう届いている
  const PROBE = client("PROBE");
  await PROBE.opened;
  const welcomeProbe = await PROBE.welcome();
  PROBE.ws.close();
  const probeLeft = await FAR.waitFor((m) => m.t === "leave" && m.id === welcomeProbe?.id);
  check(
    "視界の遠い相手には、近くの波紋が届かない（近くの相手には届く）",
    !!farSeen && !!nearPulse && !!probeLeft && !FAR.got.some((m) => m.t === "pulse"),
    `視界の反映 ${!!farSeen}, 近くへの波紋 ${!!nearPulse}, 確かめの leave ${!!probeLeft}`,
  );
  FAR.ws.close();
  await FAR.waitClosed();

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
  B.send({ t: "star", id: "x", x: "NaN", y: 0, c: 0 });
  B.send({ t: "star", id: "x", x: 1e9, y: 0, c: 0 });
  B.send({ t: "evil" });
  B.send(JSON.stringify({ t: "p", x: 0.5, y: 0.5, c: 1 }) + " ".repeat(2000)); // 大きすぎるメッセージ
  // そのあとに送った正しい位置が A に届けば、それより前の不正な入力は処理済み（切られていれば届かない）
  B.send({ t: "p", x: 0.53, y: 0.5, c: 2 });
  const afterBad = await A.waitFor((m) => m.t === "ps" && m.d.some((p) => p[0] === welcomeB?.id && p[1] === 0.53));
  check("不正な入力のあとも接続が保たれる", !!afterBad && !B.closed && B.ws.readyState === 1);

  // --- 形式に合わない uid の hello は切断される ---
  const BAD = client("BAD", { uid: "short" });
  await BAD.opened;
  const badClosed = await BAD.waitClosed();
  check(
    "形式に合わない uid（短すぎる）で hello すると切断される",
    badClosed && BAD.closeCode === 1008 && !BAD.got.some((m) => m.t === "welcome"),
    `code=${BAD.closeCode}`,
  );

  // --- 統計（token が無ければ見えない） ---
  // /stats は Worker の口。Pages（静的配信）は知らないパスにも index.html を返すので、接続先の Worker に聞く
  const workerBase = wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
  const hidden = await fetch(workerBase + "/stats");
  check("/stats は token 無しでは 404", hidden.status === 404, `status ${hidden.status}`);
  const wrong = await fetch(workerBase + "/stats", { headers: { "x-stats-token": "wrong-token" } });
  check("/stats は違う token では 404", wrong.status === 404, `status ${wrong.status}`);
  if (STATS_TOKEN) {
    const statsRes = await fetch(workerBase + "/stats", { headers: { "x-stats-token": STATS_TOKEN } });
    const stats = statsRes.ok ? await statsRes.json() : null;
    check(
      "/stats は正しい token で接続数を返す",
      !!stats &&
        typeof stats.totalConnections === "number" &&
        stats.totalConnections >= 2 &&
        Array.isArray(stats.rooms),
      stats ? `total=${stats.totalConnections}` : `status ${statsRes.status}`,
    );
  } else {
    skip("/stats は正しい token で接続数を返す", "E2E_STATS_TOKEN が無い");
  }

  if (FULL) {
    // hello を送らない接続（最後に、締め切りで切断されたかを確かめる）
    const SILENT = client("SILENT", { hello: false });
    await SILENT.opened;
    const silentSince = Date.now();

    // --- hello の前のメッセージは無視される ---
    const EARLY = client("EARLY", { hello: false });
    await EARLY.opened;
    const earlyId = newId();
    EARLY.send({ t: "star", id: earlyId, x: 0.3, y: 0.3, c: 0 });
    await sleep(200);
    EARLY.hello();
    const welcomeEarly = await EARLY.welcome();
    // hello のあとに置いた星が A に届くのを待ってから判定する（同じ接続のメッセージは順に処理され、A への配信も順に届く）
    const earlyProbe = newId();
    EARLY.send({ t: "star", id: earlyProbe, x: 0.31, y: 0.3, c: 0 });
    const probeStar = await A.waitFor((m) => m.t === "star" && m.id === earlyProbe);
    EARLY.send({ t: "unstar", id: earlyProbe }); // 確かめ用の星は消しておく
    check(
      "hello の前に送った星は無視される",
      !!welcomeEarly &&
        !!probeStar &&
        !welcomeEarly.stars.some((s) => s.id === earlyId) &&
        !A.got.some((m) => m.id === earlyId),
    );
    check("hello の前には何も届かない（welcome が最初）", EARLY.got[0]?.t === "welcome", EARLY.got[0]?.t);
    EARLY.ws.close();

    // --- 手順の違反（hello 前の hello 以外、2 回目以降の hello）が続く接続は切断される ---
    const NOISY = client("NOISY");
    await NOISY.opened;
    await NOISY.welcome();
    for (let i = 0; i < 25; i++) NOISY.hello();
    const noisyClosed = await NOISY.waitClosed();
    check(
      "hello を繰り返す接続は 1008 で切断される",
      noisyClosed && NOISY.closeCode === 1008,
      `code=${NOISY.closeCode}`,
    );
    const PRE = client("PRE", { hello: false });
    await PRE.opened;
    for (let i = 0; i < 25; i++) PRE.send({ t: "p", x: 0.5, y: 0.5, c: 0 });
    const preClosed = await PRE.waitClosed();
    check(
      "hello の前に hello 以外を送り続ける接続は 1008 で切断される",
      preClosed && PRE.closeCode === 1008 && !PRE.got.some((m) => m.t === "welcome"),
      `code=${PRE.closeCode}`,
    );

    // --- 星と線 ---
    const ids = { s1: newId(), s2: newId(), l1: newId() };
    B.send({ t: "star", id: ids.s1, x: 0.1, y: 0.1, c: 3 });
    B.send({ t: "star", id: ids.s2, x: 0.2, y: 0.2, c: 5 });
    const star = await A.waitFor((m) => m.t === "star" && m.id === ids.s1);
    check("星の配置が他の人に届く", !!star);
    check("配信される星の持ち主は uid ではない", !!star && star.by !== B.uid && HEX32.test(star.by), star?.by);
    check("welcome の me が自分の星の by と一致する", !!star && star.by === welcomeB?.me);
    check("星の色は star メッセージの c", !!star && star.c === 3, `c=${star?.c}`);
    check(
      "配信される星にサーバー専用の born / v が含まれない",
      !!star && !hasServerOnly(star),
      star && Object.keys(star).join(","),
    );
    B.send({ t: "link", id: ids.l1, a: ids.s1, b: ids.s2 });
    const link = await A.waitFor((m) => m.t === "link" && m.id === ids.l1);
    check("線が他の人に届く（持ち主は uid ではない）", !!link && link.by === welcomeB?.me && link.by !== B.uid);

    // 他人は同じ id の星を上書き・移動できない。断られたことが本人に返る
    A.send({ t: "star", id: ids.s1, x: 9, y: 9, c: 1 });
    const rejected = await A.waitFor((m) => m.t === "reject" && m.kind === "star" && m.id === ids.s1);
    check("他人の星を上書きしようとすると reject が返る", !!rejected);
    // 同じ 2 点の線の重複も断られる
    A.send({ t: "link", id: newId(), a: ids.s2, b: ids.s1 });
    check("同じ 2 点の線を重ねると reject が返る", !!(await A.waitFor((m) => m.t === "reject" && m.kind === "link")));

    // --- 線は持ち主だけが消せる ---
    A.send({ t: "unlink", id: ids.l1 });
    // そのあとに A が送った上書き（必ず断られる）の reject が返れば、unlink は処理済み
    A.send({ t: "star", id: ids.s1, x: 9, y: 9, c: 1 });
    await A.waitFor((m) => m.t === "reject" && m.kind === "star" && m.id === ids.s1 && m !== rejected);

    // --- 再接続して welcome に反映されている ---
    const w1 = await snapshot("C");
    const s1 = w1?.stars.find((s) => s.id === ids.s1);
    check("再接続した人の welcome に星と線が入っている", !!s1 && w1.links.some((l) => l.id === ids.l1));
    check("他人は星を上書き・移動できない", !!s1 && s1.by === welcomeB?.me && s1.x === 0.1 && s1.c === 3);
    check("持ち主以外は線を消せない", !!w1?.links.some((l) => l.id === ids.l1));
    check(
      "welcome の星・線にサーバー専用の born / v が含まれない",
      !!w1 && w1.stars.length > 0 && !w1.stars.some(hasServerOnly) && !w1.links.some(hasServerOnly),
    );

    // 同じ uid でつなぎ直すと同じ持ち主になる
    const B2 = client("B2", { uid: B.uid });
    await B2.opened;
    const welcomeB2 = await B2.welcome();
    check("同じ uid でつなぎ直すと同じ持ち主になる", !!welcomeB2 && welcomeB2.me === welcomeB?.me);
    B2.ws.close();

    // 星と線を置いて配信が一巡したあとで、全員が受け取った全フレームの生の文字列に、どの uid も出てこない
    const leaksAfterStars = uidLeaks();
    check(
      "星・線を置いたあと、受信したどのフレームにも uid が含まれない",
      leaksAfterStars.length === 0,
      leaksAfterStars.slice(0, 3).join(" / "),
    );

    // --- 1 つの接続が置ける星の上限 ---
    const H = client("H");
    await H.opened;
    await H.welcome();
    const created = [];
    for (let i = 0; i < 70; i++) {
      const id = newId();
      created.push(id);
      H.send({ t: "star", id, x: 10 + i * 0.3, y: 10, c: i % 8 }); // 2×70 = 140 は一度に使える量(200)に収まる
    }
    const starRejects = () => H.got.filter((m) => m.t === "reject" && m.kind === "star").length;
    for (const t0 = Date.now(); starRejects() < 6 && Date.now() - t0 < 3000;) await sleep(20);
    const rejects = starRejects();
    check("上限(64)を超える星を置くと reject が返る", rejects >= 6, `${rejects} 件`);
    const w3 = await snapshot("C3");
    const heavy = w3.stars.filter((s) => created.includes(s.id)).length;
    check("1 つの接続が置ける星は上限(64)まで", heavy > 0 && heavy <= 64, `${heavy} 個`);

    // --- 後片付け（作った星を消す。線は星の消滅で一緒に消える） ---
    const cleanup = [ids.s1, ids.s2, ...created];
    for (let i = 0; i < cleanup.length; i++) {
      B.send({ t: "unstar", id: cleanup[i] });
      if (i % 20 === 19) await sleep(600); // レート制限に当たらない程度に
    }
    // 残っていた星の unstar がすべて A に届くまで待つ（届いた時点で B の消去は処理済み）
    const existed = cleanup.filter((id) => w3.stars.some((s) => s.id === id));
    const allGone = () => existed.every((id) => A.got.some((m) => m.t === "unstar" && m.id === id));
    for (const t0 = Date.now(); !allGone() && Date.now() - t0 < 5000;) await sleep(20);
    const w4 = await snapshot("C4");
    const mineLeft = w4.stars.filter((s) => cleanup.includes(s.id)).length;
    check(
      "後片付けで作った星と線が残っていない",
      mineLeft === 0 && !w4.links.some((l) => l.id === ids.l1),
      `残り ${mineLeft} 個`,
    );
    H.ws.close();

    // --- hello が来ない接続は締め切り（10 秒）で切られる ---
    // サーバーは 10 秒で切断を始める。終了ハンドシェイクの待ちでクライアントに届くのが数秒遅れることがあるので、25 秒まで待つ
    const silentClosed = await SILENT.waitClosed(Math.max(0, silentSince + 25_000 - Date.now()));
    check(
      "hello を送らない接続は締め切り（10 秒）のあとに 1008 で切断される",
      silentClosed && SILENT.closeCode === 1008 && !SILENT.got.length,
      `${((Date.now() - silentSince) / 1000).toFixed(1)} 秒, code=${SILENT.closeCode}`,
    );
  }

  // --- 切断が伝わる ---
  const leavingId = welcomeB?.id;
  B.ws.close();
  const left = await A.waitFor((m) => m.t === "leave" && m.id === leavingId);
  check("誰かが抜けると leave が届く", !!left);
  const leaks = uidLeaks();
  check(
    "受信したどのフレームにも uid が含まれない（全接続・全フレーム）",
    leaks.length === 0,
    leaks.slice(0, 3).join(" / "),
  );

  A.ws.close();
} catch (err) {
  console.error("ERROR:", err.message);
  failed++;
}

console.log(failed === 0 ? "\nすべて成功" : `\n${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
