import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, row, assertSmooth, resetPerf } from '../support/fixtures';
import { samples } from '../support/samples';
import { makePdf, midweekLesson, notAPdf, pastoralLesson, textFile, weekendEnglishLesson } from '../support/pdf';

test.describe.configure({ mode: 'serial' });

const waitForFinished = async (page: Page, count: number, timeout = 15_000) => {
  await expect(page.locator('[data-testid="upload-item"][data-status="done"], [data-testid="upload-item"][data-status="error"]')).toHaveCount(count, { timeout });
};

test('the upload dialog opens and closes every way', async ({ app: page }) => {
  await page.getByTestId('empty-upload').click();
  await expect(page.getByTestId('upload-dialog')).toBeVisible();
  await page.getByTestId('upload-dialog-close').click();
  await expect(page.getByTestId('upload-dialog')).toHaveCount(0);

  await page.getByTestId('header-upload').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('upload-dialog')).toHaveCount(0);

  await page.getByTestId('header-upload').click();
  await page.getByTestId('upload-dialog-backdrop').click({ position: { x: 4, y: 4 } });
  await expect(page.getByTestId('upload-dialog')).toHaveCount(0);

  await page.getByTestId('header-upload').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('upload-browse').click()]);
  expect(chooser.isMultiple()).toBe(true);
  await page.getByTestId('upload-done').click();
  await expect(page.getByTestId('upload-dialog')).toHaveCount(0);
});

test('a non-PDF and a corrupt PDF are refused with a clear message', async ({ app: page }) => {
  await page.getByTestId('header-upload').click();
  await page.getByTestId('upload-input').setInputFiles([textFile, notAPdf]);
  await waitForFinished(page, 2);
  const messages = page.getByTestId('upload-message');
  await expect(messages.nth(0)).toHaveText('Only PDF files can be added.');
  await expect(messages.nth(1)).toHaveText('This file could not be opened as a PDF.');
  await expect(page.getByTestId('toast').first()).toBeVisible();
});

test('digital PDFs are read from their text layer and categorised', async ({ app: page }) => {
  await page.getByTestId('header-upload').click();
  await page.getByTestId('upload-input').setInputFiles([midweekLesson, pastoralLesson, weekendEnglishLesson]);
  await waitForFinished(page, 3);
  await page.getByTestId('upload-done').click();

  await expect(page.getByTestId('item-count')).toHaveText('3 items');
  await expect(page.getByTestId('tab-count-midweek')).toHaveText('1');
  await expect(page.getByTestId('tab-count-weekend')).toHaveText('1');
  await expect(page.getByTestId('tab-count-pastoral')).toHaveText('1');
  await expect(row(page, 'Ang Halimbawa ng Pagbabantay')).toContainText('October 15/16, 2025');
  await expect(row(page, 'Ang Halimbawa ng Tungkulin')).toContainText('Sampleville, Testland');
  await expect(page.getByTestId('year-2025')).toBeVisible();
  await expect(page.getByTestId('year-2024')).toBeVisible();
});

test('uploading the same PDF twice is refused', async ({ app: page }) => {
  await page.getByTestId('header-upload').click();
  await page.getByTestId('upload-input').setInputFiles([midweekLesson]);
  await waitForFinished(page, 1);
  await expect(page.getByTestId('upload-message')).toContainText('already in your vault');
  await expect(page.getByTestId('upload-item')).toHaveAttribute('data-status', 'error');
});

test('real scanned samples go through OCR while the UI stays responsive', async ({ app: page }) => {
  test.setTimeout(420_000);
  await page.getByTestId('header-upload').click();
  await page.getByTestId('upload-input').setInputFiles([samples.pdfs.tl, samples.pdfs.en]);
  await expect(page.getByTestId('upload-message').first()).toContainText('Recognizing text', { timeout: 30_000 });
  await page.getByTestId('upload-done').click();
  await expect(page.getByTestId('header-upload')).toContainText('Processing');

  // Use the app during OCR: nothing may stall while pages are being recognized.
  await resetPerf(page);
  for (let i = 0; i < 6; i++) {
    await page.getByTestId('tab-weekend').click();
    await expect(page.getByTestId('list-title')).toHaveText('Weekend');
    await page.getByTestId('tab-all').click();
    await expect(page.getByTestId('list-title')).toHaveText('All Lessons');
    await page.getByTestId('theme-toggle').click();
    await page.getByTestId('theme-toggle').click();
  }
  await assertSmooth(page, 'interactions during OCR');

  await expect(page.getByTestId('toast').filter({ hasText: samples.tl.short })).toBeVisible({ timeout: 240_000 });
  await expect(page.getByTestId('toast').filter({ hasText: samples.en.short })).toBeVisible({ timeout: 240_000 });
  await expect(page.getByTestId('header-upload')).toContainText('Upload PDF');

  await expect(row(page, samples.tl.row)).toContainText(samples.tl.date);
  await expect(row(page, samples.tl.row)).toContainText(samples.author);
  await expect(row(page, samples.en.row)).toContainText(samples.en.date);
  await expect(page.getByTestId('tab-count-weekend')).toHaveText('3');
  await expect(page.getByTestId('item-count')).toHaveText('5 items');
});

test('paired lessons cross-check book numbers without touching verse text', async ({ app: page }) => {
  const upload = (name: string, pages: string[], body: string) =>
    page.request.post('/api/lessons', {
      multipart: { source_kind: 'ocr', pages: JSON.stringify(pages), file: { name, mimeType: 'application/pdf', buffer: makePdf([[body]]) } },
    });
  const en = await upload('pair-en.pdf', ['Saturday/Sunday: March 3/4, 2001\nThe lesson of the and to that for with God\nA. Only Israel had God ..... I Kings 5:15 NIRV\nSampleton and his attendants returned.\nB Next point'], 'en');
  const tl = await upload('pair-tl.pdf', ['Sabado/Linggo: Marso 3/4, 2001\nAng aralin ng mga sa na ay at natin\nS. Ang Israel lamang ..... II Hari 5:15 NIRV\nSi Sampleton at ang kaniyang mga kasama.\nB Susunod'], 'tl');
  expect(en.ok() && tl.ok()).toBe(true);
  const verses: any[] = await (await page.request.get('/api/verses')).json();
  const fixed = verses.find((v) => v.text === 'Sampleton and his attendants returned.');
  expect(fixed.canonical_key).toBe('12.5:15');
  expect(fixed.ref_printed).toBe('II Kings 5:15');
  expect(fixed.ref_note).toContain('cross-checked');
  expect(fixed.ocr_raw).toBe('Sampleton and his attendants returned.');
  for (const lesson of [en, tl]) expect((await page.request.delete(`/api/lessons/${(await lesson.json()).lesson.id}`)).ok()).toBe(true);
});

test('OCR stored the real verses from both samples', async ({ app: page }) => {
  const verses: any[] = await (await page.request.get('/api/verses')).json();
  const keys: string[] = samples.verseKeys;
  for (const key of keys) {
    const group = verses.filter((v) => v.canonical_key === key);
    expect(group.map((v) => v.language).sort(), `both languages for ${key}`).toEqual(['en', 'tl']);
    for (const v of group) {
      expect(v.text.length, `text for ${key}`).toBeGreaterThan(20);
      expect(v.status).toBe('unverified');
    }
  }
  const en = verses.find((v) => v.canonical_key === samples.firstKey && v.language === 'en');
  const tl = verses.find((v) => v.canonical_key === samples.firstKey && v.language === 'tl');
  expect(en.version).toBe('ESV');
  expect(tl.version).toBe('ESV');
  expect(en.text).toContain(samples.en.verseFragment);
  expect(tl.text).toContain(samples.tl.verseFragment);
  // These pass only because OCR reads the scanner's original pixels.
  const printed = (key: string, lang: string) => verses.find((v) => v.canonical_key === key && v.language === lang).ref_printed;
  for (const [key, lang, text] of samples.printedChecks) expect(printed(key, lang)).toBe(text);
  for (const v of verses.filter((x) => keys.includes(x.canonical_key))) expect(v.ref_note, `no reconciliation needed for ${v.ref_printed}`).toBe('');
});
