// Starts a stand-in AI service and the real release backend on test ports.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const APP_PORT = '47329';
const STUB_PORT = 47321;

let mode = 'good';
let lastPrompt = null;

const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url === '/__mode') {
      mode = JSON.parse(body).mode;
      return send(200, { mode });
    }
    if (req.url === '/__last') return send(200, { lastPrompt });
    if (mode === 'down') return req.socket.destroy();
    if (req.url === '/api/tags') return send(200, { models: [{ name: 'llama3.2:3b' }] });
    if (req.url === '/api/chat') {
      lastPrompt = body;
      const candidates = [...body.matchAll(/Candidate (\d+):/g)].map((m) => Number(m[1]));
      const notes =
        mode === 'hostile'
          ? [
              { candidate: 1, note: 'Better wording: "God picked you and made you his special people forever"', speaker: 'HOSTILE-SPEAKER', context: 'As John 3:16 also teaches.' },
              { candidate: 999, note: 'John 3:16 fits better than all of these.', speaker: 'INVENTED', context: 'INVENTED' },
              { candidate: 2, note: 'Fits the topic.', text: 'TAMPERED SCRIPTURE', verse: 'TAMPERED SCRIPTURE', context: 'It reads "God picked you and made you his special people forever".' },
            ]
          : candidates.map((n) => ({ candidate: n, note: `STUB-NOTE-${n}: relevant to the stated objective.`, speaker: `STUB-SPEAKER-${n}`, context: `STUB-CONTEXT-${n}: what is happening here.` }));
      const reply = () => send(200, { message: { content: JSON.stringify({ notes }) } });
      return mode === 'slow' ? setTimeout(reply, 1500) : reply();
    }
    send(404, {});
  });
});
stub.listen(STUB_PORT, '127.0.0.1');

const data = join(here, '..', '.tmp-data');
rmSync(data, { recursive: true, force: true });
const exe = join(root, 'backend', 'target', 'release', 'lesson-vault.exe');
if (!existsSync(exe)) throw new Error('Build the backend first: cargo build --release');

const app = spawn(exe, [], {
  env: {
    ...process.env,
    LV_PORT: APP_PORT,
    LV_DATA: data,
    LV_STATIC: join(root, 'frontend', 'dist'),
    LV_OLLAMA_URL: `http://127.0.0.1:${STUB_PORT}`,
    LV_OLLAMA_MODEL: 'llama3.2:3b',
  },
  stdio: 'inherit',
});
app.on('exit', (code) => process.exit(code ?? 1));
const stop = () => {
  app.kill();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
