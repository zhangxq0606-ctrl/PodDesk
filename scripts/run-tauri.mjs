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
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
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

if (mode === 'build') {
  const npmExec = process.env.npm_execpath;
  if (npmExec && existsSync(npmExec)) {
    run(process.execPath, [npmExec, 'run', 'build']);
  } else if (process.platform === 'win32') {
    run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run build']);
  } else {
    run('npm', ['run', 'build']);
  }
}

const tauriEntry = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
if (!existsSync(tauriEntry)) {
  console.error(`未找到 ${tauriEntry}，请先在项目根目录执行 npm install`);
  process.exit(1);
}

run(process.execPath, [tauriEntry, mode, ...extraArgs], join(root, 'desktop'));
