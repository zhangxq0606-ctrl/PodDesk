import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const requested = args.find((arg) => !arg.startsWith("--"));

const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const version = requested ?? pkg.version;

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

const targets = [
  { rel: "package.json", current: pkg.version, apply: () => {
    pkg.version = version;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  } },
  jsonTarget("desktop/tauri.conf.json"),
  cargoTarget("server/Cargo.toml"),
  cargoTarget("desktop/Cargo.toml"),
];

const mismatched = targets.filter((target) => target.current !== version);

if (checkOnly) {
  if (mismatched.length === 0) {
    console.log(`版本一致：${version}`);
    process.exit(0);
  }
  console.error(`版本不一致（目标 ${version}）：`);
  for (const target of mismatched) {
    console.error(`  ${target.rel}: ${target.current} -> ${version}`);
  }
  console.error("运行 npm run version:sync 统一版本。");
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
