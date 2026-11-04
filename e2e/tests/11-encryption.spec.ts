import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../support/fixtures';
import { samples } from '../support/samples';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp-data');

function everyFile(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? everyFile(join(dir, e.name)) : [join(dir, e.name)]));
}

test('nothing in the data folder can be read without the key', async ({ page }) => {
  // Every kind of write has happened by this point in the suite.
  const lessons: any[] = await (await page.request.get('/api/lessons')).json();
  expect(lessons.length).toBeGreaterThan(0);
  const files = everyFile(dataDir);
  expect(files.some((f) => f.endsWith('vault.db.enc'))).toBe(true);
  const secrets = ['%PDF', 'SQLite format 3', 'zephyrword', samples.en.short, samples.tl.short, samples.author, samples.en.issueStart, lessons[0].title];
  for (const file of files) {
    const text = readFileSync(file).toString('latin1');
    for (const secret of secrets) expect(text.includes(secret), `${secret} in ${file}`).toBe(false);
  }
  expect(files.filter((f) => /\.(pdf|sqlite3|sqlite3-wal|sqlite3-shm)$/.test(f)), 'no plaintext file types').toEqual([]);
  for (const lesson of lessons) {
    expect(files.some((f) => f.endsWith(`${lesson.id}.pdf.enc`)), lesson.title).toBe(true);
  }
});

test('lesson data is never left in the browser cache', async ({ page }) => {
  const lessons: any[] = await (await page.request.get('/api/lessons')).json();
  for (const path of ['/api/lessons', '/api/verses', '/api/verse-context', '/api/lectures', `/api/lessons/${lessons[0].id}/file`]) {
    expect((await page.request.get(path)).headers()['cache-control'], path).toBe('no-store');
  }
});

test('the encrypted PDF still opens normally in the app', async ({ app: page }) => {
  await expect(page.locator('[data-testid="viewer-canvas"][data-rendered-key]')).toBeVisible();
  const lessons: any[] = await (await page.request.get('/api/lessons')).json();
  const pdf = await page.request.get(`/api/lessons/${lessons[0].id}/file`);
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
});
