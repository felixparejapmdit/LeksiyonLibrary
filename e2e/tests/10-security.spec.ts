import { test, expect, STUB } from '../support/fixtures';
import { makePdf, notAPdf } from '../support/pdf';

const EVIL = { Origin: 'https://evil.example' };

test('requests from other websites are refused on every data route', async ({ page }) => {
  for (const path of ['/api/lessons', '/api/verses', '/api/verse-context', '/api/scripture-context', '/api/folders', '/api/lectures', '/api/backup', '/api/ai/status', '/api/search?q=x']) {
    expect((await page.request.get(path, { headers: EVIL })).status(), path).toBe(403);
  }
  expect((await page.request.post('/api/reset', { headers: EVIL, data: { confirm: 'RESET' } })).status()).toBe(403);
  const restore = await page.request.post('/api/restore', {
    headers: EVIL,
    multipart: { file: { name: 'x.zip', mimeType: 'application/zip', buffer: Buffer.from('x') } },
  });
  expect(restore.status()).toBe(403);
  expect((await page.request.get('/api/lessons', { headers: { Host: 'evil.example:47329' } })).status()).toBe(403);
  expect((await (await page.request.get('/api/lessons')).json()).length).toBeGreaterThan(0);
});

test('a page on another origin cannot upload through the browser', async ({ page, baseURL, errors }) => {
  const before = (await (await page.request.get('/api/lessons')).json()).length;
  await page.goto(STUB + '/');
  await page.evaluate(async (app) => {
    const form = new FormData();
    form.set('source_kind', 'text');
    form.set('pages', JSON.stringify(['Paksa: Forged Upload']));
    form.set('file', new Blob(['%PDF-1.4 forged'], { type: 'application/pdf' }), 'forged.pdf');
    await fetch(`${app}/api/lessons`, { method: 'POST', mode: 'no-cors', body: form });
  }, baseURL);
  expect((await (await page.request.get('/api/lessons')).json()).length).toBe(before);
  errors.length = 0;
});

test('uploads are validated on the server, too', async ({ page }) => {
  const fake = await page.request.post('/api/lessons', {
    multipart: { pages: '[]', source_kind: 'text', file: { name: 'x.pdf', mimeType: 'application/pdf', buffer: notAPdf.buffer } },
  });
  expect(fake.status()).toBe(415);
  const none = await page.request.post('/api/lessons', { multipart: { pages: '[]' } });
  expect(none.status()).toBe(400);
  expect((await page.request.post('/api/reset', { data: { confirm: 'nope' } })).status()).toBe(400);
  expect((await page.request.get('/api/lessons')).ok()).toBe(true);
});

test('a path-traversal file name cannot escape, and downloads stay safe', async ({ page }) => {
  const res = await page.request.post('/api/lessons', {
    multipart: {
      pages: JSON.stringify(['Paksa: Traversal Test']),
      source_kind: 'text',
      file: { name: '..\\..\\evil".pdf', mimeType: 'application/pdf', buffer: makePdf([['traversal test body']]) },
    },
  });
  expect(res.ok()).toBeTruthy();
  const { lesson } = await res.json();
  expect(lesson.file_name).not.toContain('\\');
  expect(lesson.file_name).not.toContain('..');
  const dl = await page.request.get(`/api/lessons/${lesson.id}/file?download=1`);
  expect(dl.headers()['content-disposition'].match(/"/g)).toHaveLength(2);
  expect((await page.request.delete(`/api/lessons/${lesson.id}`)).ok()).toBe(true);
  expect((await page.request.get('/api/lessons/..%2F..%2Fsecret/file')).status()).toBe(404);
});

test('security headers are strict and no session cookie is set', async ({ page }) => {
  const res = await page.request.get('/');
  const h = res.headers();
  expect(h['set-cookie']).toBeUndefined();
  expect(h['content-security-policy']).toContain("default-src 'self'");
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['x-content-type-options']).toBe('nosniff');
});

test('the app makes no requests to other hosts', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:47329') && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) external.push(r.url());
  });
  await page.goto('/');
  await expect(page.locator('[data-testid="viewer-canvas"][data-rendered-key]')).toBeVisible();
  await page.goto('/bibles');
  await page.goto('/lecture');
  await page.goto('/settings');
  await page.waitForTimeout(300);
  expect(external).toEqual([]);
});

test('unknown API routes return JSON 404, unknown pages load the app', async ({ page }) => {
  const api = await page.request.get('/api/nope');
  expect(api.status()).toBe(404);
  expect((await api.json()).error).toBe('Not found.');
  await page.goto('/this/does/not/exist');
  await expect(page.getByTestId('vault-page')).toBeVisible();
});
