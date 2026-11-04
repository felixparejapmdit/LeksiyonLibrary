// Runs Lesson Vault from the project, in this terminal. Ctrl+C stops it cleanly.
//
//   npm start     builds what changed, then serves the app on http://127.0.0.1:47319
//   npm run dev   same backend, plus the hot-reloading frontend on http://127.0.0.1:47320
//
// Both modes use the same data: backend/data.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = join(root, 'backend');
const frontendDir = join(root, 'frontend');
const exe = join(backendDir, 'target', 'release', process.platform === 'win32' ? 'lesson-vault.exe' : 'lesson-vault');
const devMode = process.argv[2] === 'dev';
const port = process.env.LV_PORT ?? '47319';

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function step(label, command, args, cwd) {
  console.log(`> ${label}`);
  // npm is a .cmd script on Windows, which Node only launches through a shell.
  const r = command === 'npm'
    ? spawnSync(`npm ${args.join(' ')}`, { cwd, stdio: 'inherit', shell: true })
    : spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (r.error) fail(`Could not run ${command}: ${r.error.message}. Is it installed and on PATH?`);
  if (r.status !== 0) fail(`${label} failed.`);
}

function newestChange(path) {
  const s = statSync(path);
  if (!s.isDirectory()) return s.mtimeMs;
  let newest = 0;
  for (const name of readdirSync(path)) newest = Math.max(newest, newestChange(join(path, name)));
  return newest;
}

function frontendIsStale() {
  const built = join(frontendDir, 'dist', 'index.html');
  if (!existsSync(built)) return true;
  const inputs = ['src', 'public', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts'];
  const newest = Math.max(...inputs.map((p) => newestChange(join(frontendDir, p))));
  return newest > statSync(built).mtimeMs;
}

async function waitForBackend(backend) {
  for (let i = 0; i < 100 && backend.exitCode === null; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok && (await res.json()).app === 'lesson-vault') return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

if (!existsSync(join(frontendDir, 'node_modules'))) step('Installing frontend packages', 'npm', ['ci'], frontendDir);
if (!devMode && frontendIsStale()) step('Building frontend', 'npm', ['run', 'build'], frontendDir);
step('Building backend', 'cargo', ['build', '--release'], backendDir);

// Ctrl+C reaches every process in this terminal. Stay alive until they have shut
// down, so the prompt only returns once the database is safely closed.
process.on('SIGINT', () => {});

const children = [];
const start = (command, args, cwd) => {
  const child = spawn(command, args, { cwd, stdio: 'inherit' });
  children.push(child);
  child.on('error', (e) => fail(`Could not start ${command}: ${e.message}`));
  // If either process stops, stop the other too rather than leave half an app running.
  child.on('exit', (code) => {
    for (const other of children) if (other !== child && other.exitCode === null) other.kill();
    process.exitCode ||= code ?? 0;
  });
  return child;
};

const backend = start(exe, [], root);

if (devMode && (await waitForBackend(backend))) {
  start(process.execPath, [join(frontendDir, 'node_modules', 'vite', 'bin', 'vite.js')], frontendDir);
}
