import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [mode, ...extraArgs] = process.argv.slice(2);

if (mode !== 'dev' && mode !== 'build') {
  console.error('Usage: node scripts/run-tauri.mjs <dev|build> [...tauriArgs]');
  process.exit(1);
}

function run(cmd, args, cwd = root) {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd),
  });
  if (res.error) throw res.error;
  if (res.status !== 0) process.exit(res.status ?? 1);
}

if (process.platform === 'win32') {
  const stageScript = join(root, 'scripts', 'stage-vcrt.ps1');
  const pwsh = spawnSync('pwsh', ['-NoProfile', '-File', stageScript], { cwd: root, stdio: 'inherit' });
  if (pwsh.error) {
    run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stageScript]);
  } else if (pwsh.status !== 0) {
    process.exit(pwsh.status ?? 1);
  }
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
if (mode === 'build') {
  const res = spawnSync(npmCmd, ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.error) throw res.error;
  if (res.status !== 0) process.exit(res.status ?? 1);
}

const tauriBin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
if (!existsSync(tauriBin)) {
  console.error(`未找到 ${tauriBin}，请先在项目根目录执行 npm install`);
  process.exit(1);
}

run(tauriBin, [mode, ...extraArgs], join(root, 'desktop'));
