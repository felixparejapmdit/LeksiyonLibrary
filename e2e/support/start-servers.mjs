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

// A stand-in for a meaning model: words go to fixed positions, and synonyms share one.
const SYNONYMS = { calling: 'vocation', duty: 'vocation' };
const FILLER = new Set('a about above at by first fourth from in it made now second speaks spring the third up verse water'.split(' '));
function embed(text) {
  const vector = new Array(1024).fill(0);
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (FILLER.has(raw)) continue;
    const word = SYNONYMS[raw] ?? raw;
    let hash = 7;
    for (const ch of word) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    vector[hash % vector.length] += 1;
  }
  return vector;
}

let mode = 'good';
let lastPrompt = null;
// The models the stand-in has installed. A download adds one; /__models sets them for a test.
const ALL_MODELS = ['llama3.2:3b', 'bge-m3:latest'];
let models = [...ALL_MODELS];
// How a download goes: 'ok', 'fail' (Ollama reports an error) or 'hang' (it never finishes).
let pullMode = 'ok';

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
    if (req.url === '/__models') {
      const wanted = JSON.parse(body);
      models = wanted.models ?? [...ALL_MODELS];
      pullMode = wanted.pull ?? 'ok';
      return send(200, { models });
    }
    if (mode === 'down') return req.socket.destroy();
    if (req.url === '/api/tags') return send(200, { models: models.map((name) => ({ name })) });
    if (req.url === '/api/pull') {
      // Ollama answers with one line of JSON per step.
      const { model } = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const steps = [{ status: 'pulling manifest' }, ...[1, 2, 3, 4].map((n) => ({ status: 'pulling 6a0746a1ec1a', digest: 'sha256:6a07', total: 4000, completed: n * 1000 })), { status: 'verifying sha256 digest' }, { status: 'writing manifest' }, { status: 'success' }];
      if (pullMode === 'fail') return res.end(JSON.stringify({ error: 'pull model manifest: file does not exist' }) + '\n');
      let i = 0;
      const next = () => {
        if (pullMode === 'hang' && i === 3) return; // stays open until cancelled
        if (i === steps.length) {
          if (!models.some((m) => m.split(':')[0] === model.split(':')[0])) models.push(model.includes(':') ? model : `${model}:latest`);
          return res.end();
        }
        res.write(JSON.stringify(steps[i++]) + '\n');
        setTimeout(next, 150);
      };
      return next();
    }
    if (req.url === '/api/embed') return send(200, { embeddings: JSON.parse(body).input.map(embed) });
    if (req.url === '/api/chat') {
      // Speakers and background are asked for one at a time, separately from verse notes.
      const verse = /Verse: ([^"]+)/.exec(body);
      if (verse) {
        const speaker = mode === 'hostile' ? 'See John 3:16' : `STUB-SPEAKER-${verse[1].length}`;
        return send(200, { message: { content: JSON.stringify({ speaker }) } });
      }
      const translation = /Translate into Tagalog: ([^"]+)/.exec(body);
      if (translation) {
        if (mode === 'hostile') return send(200, { message: { content: JSON.stringify({ tagalog: 'This reply stayed in English and it is of no use to the people.' }) } });
        const tagalog = `STUB-TAGALOG ang mga ito ay para sa kanila: ${translation[1]}`;
        return send(200, { message: { content: JSON.stringify({ tagalog }) } });
      }
      const scope = /Background on: ([^"]+)/.exec(body);
      if (scope) {
        const isChapter = scope[1].startsWith('chapter');
        if (scope[1].startsWith('the historical')) {
          if (mode === 'hostile') return send(200, { message: { content: JSON.stringify({ context: 'See Romans 13:1 for this.' }) } });
          return send(200, { message: { content: JSON.stringify({ context: `STUB-HISTORY: ${scope[1]}.` }) } });
        }
        const context =
          mode === 'hostile'
            ? isChapter
              ? 'As John 3:16 also teaches.'
              : 'It reads "God picked you and made you his special people forever".'
            : `${isChapter ? 'STUB-CHAPTER' : 'STUB-BOOK'}: background on ${scope[1]}.`;
        return send(200, { message: { content: JSON.stringify({ context }) } });
      }
      lastPrompt = body;
      const candidates = [...body.matchAll(/Candidate (\d+):/g)].map((m) => Number(m[1]));
      const notes =
        mode === 'hostile'
          ? [
              { candidate: 1, note: 'Better wording: "God picked you and made you his special people forever"' },
              { candidate: 999, note: 'John 3:16 fits better than all of these.', speaker: 'INVENTED', context: 'INVENTED' },
              { candidate: 2, note: 'Fits the topic.', text: 'TAMPERED SCRIPTURE', verse: 'TAMPERED SCRIPTURE' },
            ]
          : candidates.map((n) => ({ candidate: n, note: `STUB-NOTE-${n}: relevant to the stated objective.` }));
      const reply = () => send(200, { message: { content: JSON.stringify({ notes }) } });
      return mode === 'slow' ? setTimeout(reply, 1500) : reply();
    }
    send(404, {});
  });
});
stub.listen(STUB_PORT, '127.0.0.1');

const data = join(here, '..', '.tmp-data');
rmSync(data, { recursive: true, force: true });
// Windows can keep the live app's executable locked. Tests may use a separate build.
const exe = process.env.LV_TEST_EXE ?? join(root, 'backend', 'target', 'release', process.platform === 'win32' ? 'lesson-vault.exe' : 'lesson-vault');
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
