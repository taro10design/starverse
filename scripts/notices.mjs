// サードパーティのライセンス表記（THIRD_PARTY_NOTICES）を生成する。
//
//   node scripts/notices.mjs          # THIRD_PARTY_NOTICES.md と client/public/THIRD_PARTY_NOTICES.txt を書き出す
//   node scripts/notices.mjs --check  # 最新か確認する（古ければ終了コード 1。CI で使う）
//
// 配布物に入る部品（package.json の `dependencies` と、その `dependencies` を辿った先）だけを対象にする。
// 開発用のツール（devDependencies）や、peerDependencies だけの部品は、配布物に入らないので含めない。
// MIT / ISC などの許諾は「著作権表示とライセンス文を、複製物に付けること」を条件にしているので、
// ブラウザへ配るファイルとして `/THIRD_PARTY_NOTICES.txt` を一緒に公開する。

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputs = [path.join(root, "THIRD_PARTY_NOTICES.md"), path.join(root, "client/public/THIRD_PARTY_NOTICES.txt")];

// npm パッケージに LICENSE ファイルが入っていない部品の、公式リポジトリのライセンス文
const FALLBACK = {
  partyserver: {
    source: "https://github.com/cloudflare/partykit/blob/main/LICENSE",
    text: `Copyright 2024 Sunil Pai <spai@cloudflare.com>

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,
  },
};

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

// from のディレクトリから見える node_modules の中で、name の package.json を探す（Node の解決と同じ順序）
function findPackageDir(name, from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`${name} が見つかりません（${from} から）`);
  }
}

function licenseFile(dir) {
  const file = readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f));
  return file ? path.join(dir, file) : null;
}

// 配布物に入る部品を、dependencies だけを辿って集める
function collect() {
  const found = new Map(); // "name@version" -> { name, version, dir }
  const queue = Object.keys(readJson(path.join(root, "package.json")).dependencies ?? {}).map((name) => ({
    name,
    from: root,
  }));
  while (queue.length) {
    const { name, from } = queue.shift();
    const dir = findPackageDir(name, from);
    const pkg = readJson(path.join(dir, "package.json"));
    const key = `${pkg.name}@${pkg.version}`;
    if (found.has(key)) continue;
    found.set(key, { name: pkg.name, version: pkg.version, license: pkg.license, repository: pkg.repository, dir });
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, from: dir });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function repositoryUrl(repository) {
  const url = typeof repository === "string" ? repository : (repository?.url ?? "");
  return url
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "");
}

function render(packages) {
  const parts = [
    "# サードパーティのライセンス表記 / Third-party notices",
    "",
    "このアプリは、次のオープンソースのソフトウェアを使っています。",
    "This application uses the following open source software.",
    "",
    "（このファイルは `npm run notices` で生成します。手で編集しないでください。）",
    "",
  ];
  for (const p of packages) {
    const file = licenseFile(p.dir);
    const fallback = FALLBACK[p.name];
    let text;
    let source;
    if (file) {
      text = readFileSync(file, "utf8");
      source = "";
    } else if (fallback) {
      text = fallback.text;
      source = `（npm パッケージに LICENSE ファイルが無いため、公式リポジトリのライセンス文: ${fallback.source}）`;
    } else {
      throw new Error(`${p.name}@${p.version}: LICENSE ファイルが見つかりません。FALLBACK に追加してください`);
    }
    parts.push("-".repeat(80), "", `## ${p.name} ${p.version}`, "", `- License: ${p.license ?? "(不明)"}`);
    const repo = repositoryUrl(p.repository);
    if (repo) parts.push(`- Source: ${repo}`);
    if (source) parts.push(`- ${source}`);
    parts.push("", text.replace(/\r\n/g, "\n").trim(), "");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

const content = render(collect());

if (process.argv.includes("--check")) {
  const stale = outputs.filter(
    (file) => !existsSync(file) || readFileSync(file, "utf8").replace(/\r\n/g, "\n") !== content,
  );
  if (stale.length) {
    console.error(
      `ライセンス表記が最新ではありません（${stale.map((f) => path.relative(root, f)).join(", ")}）。\`npm run notices\` を実行してください。`,
    );
    process.exit(1);
  }
  console.log("ライセンス表記は最新です");
} else {
  for (const file of outputs) writeFileSync(file, content);
  console.log(`書き出しました: ${outputs.map((f) => path.relative(root, f)).join(", ")}`);
}
