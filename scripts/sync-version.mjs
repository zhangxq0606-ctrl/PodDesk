import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");

let tagArg = null;
let requested = null;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--check") continue;
  if (arg === "--tag") {
    tagArg = args[i + 1] ?? "";
    i += 1;
    continue;
  }
  if (arg.startsWith("--tag=")) {
    tagArg = arg.slice("--tag=".length);
    continue;
  }
  if (!arg.startsWith("--") && !requested) {
    requested = arg;
  }
}

const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

let tagVersion = null;
if (tagArg !== null) {
  tagVersion = tagArg.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(tagVersion)) {
    console.error(`无效标签格式：${tagArg}（需要 vMAJOR.MINOR.PATCH，例如 v0.2.0）`);
    process.exit(1);
  }
}

const version = requested ?? tagVersion ?? pkg.version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`无效版本号：${version}（需要 MAJOR.MINOR.PATCH，例如 0.2.0）`);
  process.exit(1);
}

function jsonTarget(rel) {
  const path = join(root, rel);
  const data = JSON.parse(readFileSync(path, "utf8"));
  return {
    rel,
    current: data.version,
    apply: () => {
      data.version = version;
      writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
    },
  };
}

function cargoTarget(rel) {
  const path = join(root, rel);
  const raw = readFileSync(path, "utf8");
  const match = raw.match(/^version = "([^"]*)"/m);
  if (!match) {
    throw new Error(`${rel} 中找不到 [package] version`);
  }
  return {
    rel,
    current: match[1],
    apply: () => {
      writeFileSync(path, raw.replace(/^version = "[^"]*"/m, `version = "${version}"`));
    },
  };
}

function websiteTarget(rel) {
  const path = join(root, rel);
  const raw = readFileSync(path, "utf8");
  const patterns = [
    { name: "RELEASE.version", re: /(version:\s*')v(\d+\.\d+\.\d+)(')/, repl: (_, a, _v, b) => `${a}v${version}${b}` },
    { name: "RELEASE.winFileName", re: /(winFileName:\s*'PodDesk_)(\d+\.\d+\.\d+)(_x64-setup\.exe')/, repl: (_, a, _v, b) => `${a}${version}${b}` },
    { name: "RELEASE.winDownloadUrl", re: /(winDownloadUrl:\s*'https:\/\/github\.com\/zhangxq0606-ctrl\/PodDesk\/releases\/download\/v)(\d+\.\d+\.\d+)(\/PodDesk_)(\d+\.\d+\.\d+)(_x64-setup\.exe')/, repl: (_, a, _v1, b, _v2, c) => `${a}${version}${b}${version}${c}` },
    { name: "RELEASE.macFileName", re: /(macFileName:\s*'PodDesk_)(\d+\.\d+\.\d+)(_aarch64\.dmg')/, repl: (_, a, _v, b) => `${a}${version}${b}` },
    { name: "RELEASE.macDownloadUrl", re: /(macDownloadUrl:\s*'https:\/\/github\.com\/zhangxq0606-ctrl\/PodDesk\/releases\/download\/v)(\d+\.\d+\.\d+)(\/PodDesk_)(\d+\.\d+\.\d+)(_aarch64\.dmg')/, repl: (_, a, _v1, b, _v2, c) => `${a}${version}${b}${version}${c}` },
    { name: "#beta-facts", re: /(<span id="beta-facts">)v(\d+\.\d+\.\d+)(\s)/, repl: (_, a, _v, b) => `${a}v${version}${b}` },
    { name: "data-rel=version", re: /(<span data-rel="version">)v(\d+\.\d+\.\d+)(<\/span>)/, repl: (_, a, _v, b) => `${a}v${version}${b}` },
    { name: "data-rel=winFileName", re: /(<span data-rel="winFileName">PodDesk_)(\d+\.\d+\.\d+)(_x64-setup\.exe<\/span>)/, repl: (_, a, _v, b) => `${a}${version}${b}` },
    { name: "data-rel=macFileName", re: /(<span[^>]*data-rel="macFileName"[^>]*>PodDesk_)(\d+\.\d+\.\d+)(_aarch64\.dmg<\/span>)/, repl: (_, a, _v, b) => `${a}${version}${b}` },
  ];

  const found = new Set();
  for (const item of patterns) {
    const m = raw.match(item.re);
    if (!m) {
      throw new Error(`${rel} 中找不到版本字段：${item.name}`);
    }
    for (let k = 2; k < m.length; k += 2) {
      if (m[k] && /^\d+\.\d+\.\d+$/.test(m[k])) found.add(m[k]);
    }
  }

  const current = found.size === 1 ? [...found][0] : `混杂(${[...found].join(", ")})`;
  return {
    rel,
    current,
    apply: () => {
      let next = raw;
      for (const item of patterns) {
        next = next.replace(item.re, item.repl);
      }
      writeFileSync(path, next);
    },
  };
}

const targets = [
  { rel: "package.json", current: pkg.version, apply: () => {
    pkg.version = version;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  } },
  jsonTarget("desktop/tauri.conf.json"),
  cargoTarget("server/Cargo.toml"),
  cargoTarget("desktop/Cargo.toml"),
  websiteTarget("website/index.html"),
];

const mismatched = targets.filter((target) => target.current !== version);

if (checkOnly) {
  if (mismatched.length === 0) {
    console.log(`版本一致：${version}${tagArg ? `（匹配标签 ${tagArg}）` : ""}`);
    process.exit(0);
  }
  console.error(`版本不一致（目标 ${version}${tagArg ? `，来自标签 ${tagArg}` : ""}）：`);
  for (const target of mismatched) {
    console.error(`  ${target.rel}: ${target.current} -> ${version}`);
  }
  console.error("运行 npm run version:sync <版本号> 统一版本。");
  process.exit(1);
}

for (const target of mismatched) {
  target.apply();
  console.log(`  ${target.rel}: ${target.current} -> ${version}`);
}

if (mismatched.length === 0) {
  console.log(`版本已一致：${version}`);
} else {
  console.log("版本已同步；若改了 Rust 版本，请运行 cargo check 刷新 Cargo.lock。");
}
