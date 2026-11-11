import AdmZip from 'adm-zip';
import type { Page } from '@playwright/test';
import { test, expect, TEST_PASSPHRASE, withEmptyVault } from '../support/fixtures';
import { DOCX_MIME, docx } from '../support/docx';
import { makePdf } from '../support/pdf';

// Every title, location, and passage in this suite is invented test data.
const title = 'Keeping Watch at the Sample Gate';
const wording = '8The watchmen are ready at the gate of the town, zephyrdocxbody.';
const lessonPages = [[
  'Saturday/Sunday: November 7/8, 2026',
  `Paksa: ${title}`,
  'ISSUE:', 'Faith and careful preparation',
  'OBJECTIVES:', '1. Keep hope through every difficulty',
  'EXORDIUM:', '1. The first sample point ..........Genesis 6:8 T4T', wording,
], [
  'I. Continuing the sample lesson',
  '1. A second sample point ..........Genesis 6:9 AMP',
  '9The people of the sample town prepare their lamps for another evening.',
]];
const lessonFile = () => ({ name: '2026_Wk45b.pdf.docx', mimeType: DOCX_MIME, buffer: docx(lessonPages) });
const lessons = async (page: Page): Promise<any[]> => (await page.request.get('/api/lessons')).json();
const verses = async (page: Page): Promise<any[]> => (await page.request.get('/api/verses')).json();

async function ready(page: Page, path = '/') {
  await page.goto(path);
  await expect(page.getByTestId('app-shell')).toBeVisible();
}

async function addDocx(page: Page, file = lessonFile(), pastoral = false) {
  const response = await page.request.post('/api/lessons', { multipart: {
    file, ...(pastoral ? { category: 'pastoral' } : {}),
    // DOCX extraction must come from the actual document, never supplied text.
    pages: JSON.stringify(['Paksa: Forged Client Text\nTalata: John 3:16\nDo not save this forged text.']), source_kind: 'ocr',
  } });
  expect(response.ok()).toBe(true);
  return (await response.json()).lesson;
}

test('a DOCX lesson uploads, opens beside its check form, searches, and supplies reviewable verses', async ({ page }) => {
  await withEmptyVault(page, async () => {
    await ready(page);
    await page.getByTestId('side-lessons').click();
    await expect(page.getByTestId('lesson-drop-input')).toHaveAttribute('accept', /\.docx/);
    await page.getByTestId('lesson-drop-input').setInputFiles(lessonFile());
    await expect(page.getByTestId('lesson-drop-summary')).toContainText('1 lesson added');
    const [lesson] = await lessons(page);
    expect(lesson).toMatchObject({ title, category: 'weekend', document_format: 'docx', source_kind: 'text', page_count: 2, issue: 'Faith and careful preparation', objectives: ['Keep hope through every difficulty'], needs_check: true });
    expect((await verses(page)).map((v) => v.canonical_key).sort()).toEqual(['1.6:8', '1.6:9']);

    const row = page.locator(`[data-testid="lesson-row"][data-lesson-id="${lesson.id}"]`);
    await row.getByTestId('lesson-open').click();
    await expect(page.getByTestId('docx-viewer')).toHaveAttribute('data-lesson', lesson.id);
    await expect(page.getByTestId('docx-content').getByText(`Paksa: ${title}`, { exact: true })).toBeVisible();
    await expect(page.getByTestId('viewer-page')).toHaveText('1 / 2');
    await page.getByTestId('viewer-next').click();
    await expect(page.getByTestId('docx-content').getByText('I. Continuing the sample lesson', { exact: true })).toBeVisible();
    await expect(page.getByTestId('viewer-page')).toHaveText('2 / 2');
    await page.getByTestId('viewer-prev').click();
    await row.getByTestId('lesson-edit').click();
    const check = page.getByTestId('edit-dialog');
    await expect(check.getByTestId('docx-viewer')).toBeVisible();
    await expect(check.getByTestId('edit-title')).toHaveValue(title);
    await expect(check.getByTestId('check-verses-title')).toHaveText('Verses found (2)');
    await check.getByTestId('edit-confirm').click();
    await expect(check).toHaveCount(0);
    expect((await lessons(page))[0].needs_check).toBe(false);

    await page.keyboard.press('Control+k');
    await page.getByTestId('advanced-search-input').fill('zephyrdocxbody');
    await expect(page.getByTestId('advanced-search-lesson')).toHaveCount(1);
    await expect(page.getByTestId('advanced-search-lesson')).toContainText(title);
    await page.keyboard.press('Escape');
    await ready(page, '/review');
    await page.getByTestId('review-library-lesson').click();
    await expect(page.getByTestId('docx-viewer')).toHaveAttribute('data-lesson', lesson.id);
    await expect(page.getByTestId('docx-content').getByText(wording.slice(1), { exact: true })).toBeVisible();
    await expect(page.getByTestId('viewer-mark-status')).toHaveAttribute('data-state', 'found');
    await expect(page.getByTestId('review-formatted-text').locator('sup')).toHaveText('8');
    await page.getByTestId('review-compared').check();
    await page.getByTestId('review-verify').click();
    await expect.poll(async () => (await verses(page)).find((v) => v.canonical_key === '1.6:8').status).toBe('verified');
  });
});

test('a DOCX rejected by an older PDF-only server explains how to load the update', async ({ page }) => {
  await withEmptyVault(page, async () => {
    await ready(page);
    await page.getByTestId('side-lessons').click();
    await page.route('**/api/lessons', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({ status: 415, contentType: 'application/json', body: JSON.stringify({ error: 'That file is not a PDF.' }) });
    });
    await page.getByTestId('lesson-drop-input').setInputFiles(lessonFile());
    await expect(page.getByTestId('lesson-drop-summary')).toContainText('0 lessons added');
    await expect(page.getByTestId('lesson-drop-summary')).toContainText('1 could not be added');
    await page.getByTestId('lesson-drop-details').click();
    await expect(page.getByTestId('upload-message')).toHaveText('The running server has not loaded DOCX support. Stop it and run npm start again, then retry this file.');
    expect(await lessons(page)).toHaveLength(0);
  });
});

test('the server reads DOCX bytes, preserves the original download, and refuses corrupt or unsupported documents', async ({ page }) => {
  await withEmptyVault(page, async () => {
    const file = lessonFile();
    const lesson = await addDocx(page, file);
    expect(lesson).toMatchObject({ title, document_format: 'docx', source_kind: 'text', page_count: 2 });
    const found = await verses(page);
    expect(found.map((v) => v.canonical_key).sort()).toEqual(['1.6:8', '1.6:9']);
    expect(found.find((v) => v.canonical_key === '1.6:9').sources[0].page).toBe(2);
    const source = await page.request.get(`/api/lessons/${lesson.id}/file?download=1`);
    expect(source.headers()['content-type']).toContain(DOCX_MIME);
    expect(source.headers()['content-disposition']).toContain(file.name);
    expect(await source.body()).toEqual(file.buffer);
    const duplicate = await page.request.post('/api/lessons', { multipart: { file } });
    expect(duplicate.status()).toBe(409);

    const unrelatedZip = new AdmZip();
    unrelatedZip.addFile('notes.txt', Buffer.from('A zip file is not a Word document.'));
    for (const invalid of [
      { name: 'corrupt.docx', mimeType: DOCX_MIME, buffer: Buffer.from('not a word document') },
      { name: 'unrelated.docx', mimeType: DOCX_MIME, buffer: unrelatedZip.toBuffer() },
      { name: 'legacy.doc', mimeType: 'application/msword', buffer: Buffer.from('legacy documents are unsupported') },
    ]) {
      const response = await page.request.post('/api/lessons', { multipart: { file: invalid } });
      expect([400, 415, 422]).toContain(response.status());
      expect((await response.json()).error).toMatch(/DOCX|Word|PDF|document/i);
    }
    expect(await lessons(page)).toHaveLength(1);
  });
});

test('a mixed pastoral batch keeps PDF viewing, DOCX moves, and encrypted backup restoration working', async ({ page }) => {
  await withEmptyVault(page, async () => {
    const visitTitle = 'Sample Visit to the North Gate';
    const visitPages = [[`Paksa: ${visitTitle}`, 'PASIMULA:', '1. A sample point ..........Genesis 6:20 T4T', '20Ang mga bantay ay handa sa pintuan ng bayan at may ilaw sa kanilang silid.']];
    const visitFile = { name: '20261108_north-gate.docx', mimeType: DOCX_MIME, buffer: docx(visitPages, 'LINGGO: NOBYEMBRE 8, 2026\nSAMPLE LOCAL, SAMPLE DISTRICT') };
    const pdfTitle = 'A Separate Sample PDF Visit';
    const pdfLines = [`Paksa: ${pdfTitle}`, 'PASIMULA:', '1. Another sample point ..........Genesis 6:21 AMP', '21The sample town gathers supplies before the evening.'];
    const pdfFile = { name: '20261109_another-visit.pdf', mimeType: 'application/pdf', buffer: makePdf([pdfLines]) };
    await ready(page);
    await page.getByTestId('side-pv').click();
    // This uses the same mixed-file filtering function as selecting a folder.
    await page.getByTestId('pv-drop-input').setInputFiles([visitFile, pdfFile, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('skip this file') }]);
    await expect(page.getByTestId('pv-drop-summary')).toContainText('2 visits added');
    const records = await lessons(page);
    const visit = records.find((l) => l.document_format === 'docx');
    const pdf = records.find((l) => l.file_name === pdfFile.name);
    expect(visit).toMatchObject({ title: visitTitle, category: 'pastoral', local_congregation: 'Sample Local', district: 'Sample District' });
    const pdfRow = page.locator(`[data-testid="lesson-row"][data-lesson-id="${pdf.id}"]`);
    await pdfRow.getByTestId('lesson-open').click();
    await expect(page.getByTestId('viewer-canvas')).toBeVisible();
    const visitRow = page.locator(`[data-testid="lesson-row"][data-lesson-id="${visit.id}"]`);
    await visitRow.getByTestId('lesson-move').click();
    await page.getByTestId('move-lesson-category').selectOption('midweek');
    await page.getByTestId('move-lesson-confirm').click();
    await expect(page.getByTestId('move-lesson-dialog')).toHaveCount(0);
    await expect(page.getByTestId('list-title')).toHaveText('Lesson Library');
    await expect(page.getByTestId('docx-viewer')).toHaveAttribute('data-lesson', visit.id);
    await expect(page.getByTestId('docx-content').getByText(`Paksa: ${visitTitle}`, { exact: true })).toBeVisible();

    const backup = await page.request.post('/api/backup', { data: { passphrase: TEST_PASSPHRASE } });
    expect(backup.ok()).toBe(true);
    const encrypted = await backup.body();
    expect(encrypted.includes(Buffer.from(visitTitle))).toBe(false);
    expect((await page.request.post('/api/reset', { data: { confirm: 'RESET' } })).ok()).toBe(true);
    const restored = await page.request.post('/api/restore', { multipart: { passphrase: TEST_PASSPHRASE, file: { name: 'docx-sample.lvbackup', mimeType: 'application/octet-stream', buffer: encrypted } } });
    expect(restored.ok()).toBe(true);
    expect((await lessons(page)).find((l) => l.id === visit.id)).toMatchObject({ category: 'midweek', document_format: 'docx', file_name: visitFile.name });
    expect(await (await page.request.get(`/api/lessons/${visit.id}/file`)).body()).toEqual(visitFile.buffer);
    expect(await (await page.request.get(`/api/lessons/${pdf.id}/file`)).body()).toEqual(pdfFile.buffer);
    await page.reload();
    await page.getByTestId('side-lessons').click();
    await page.getByTestId('lesson-open').click();
    await expect(page.getByTestId('docx-content').getByText(`Paksa: ${visitTitle}`, { exact: true })).toBeVisible();
  });
});

test('DOCX lessons remain readable and downloadable on a phone', async ({ page }) => {
  await withEmptyVault(page, async () => {
    const lesson = await addDocx(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await ready(page);
    await page.getByTestId('lesson-open').click();
    await expect(page.getByTestId('mobile-viewer')).toBeVisible();
    const viewer = page.getByTestId('docx-viewer');
    await expect(viewer).toHaveAttribute('data-lesson', lesson.id);
    await expect(viewer.getByTestId('docx-content').getByText(`Paksa: ${title}`, { exact: true })).toBeVisible();
    const bounds = (await viewer.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    const source = await page.request.get(`/api/lessons/${lesson.id}/file?download=1`);
    expect(source.headers()['content-type']).toContain(DOCX_MIME);
    const [download] = await Promise.all([page.waitForEvent('download'), viewer.getByTestId('viewer-download').click()]);
    expect(download.suggestedFilename()).toBe(lesson.file_name);
    await viewer.getByTestId('viewer-back').click();
    await expect(page.getByTestId('mobile-viewer')).toHaveCount(0);
  });
});
