import type { Page } from '@playwright/test';
import { test, expect, assertSmooth, resetPerf } from '../support/fixtures';
import { samples } from '../support/samples';

const group = (page: Page, key: string) => page.locator(`[data-testid="verse-group"][data-key="${key}"]`);
const card = (page: Page, key: string, lang: string) => group(page, key).locator(`[data-testid="verse-card"][data-language="${lang}"]`);

// The verses read from lessons, which the Lesson Library keeps apart from imported ones.
test.beforeEach(async ({ app: page }) => {
  await page.getByTestId('side-lesson-verses').click();
  await expect(page.getByTestId('bibles-page')).toBeVisible();
  await expect(page.getByTestId('bibles-title')).toHaveText('Verses from lessons');
});

test('verses are grouped by reference with Tagalog and English side by side', async ({ page }) => {
  await expect(group(page, samples.firstKey).getByTestId('verse-group-title')).toContainText(samples.firstRefEn);
  await expect(card(page, samples.firstKey, 'tl').getByTestId('verse-text')).toContainText(samples.tl.verseFragment);
  await expect(card(page, samples.firstKey, 'en').getByTestId('verse-text')).toContainText(samples.en.cardFragment);
  await expect(card(page, samples.firstKey, 'en').getByTestId('verse-version')).toHaveText('ESV');
  await expect(group(page, '19.138:7-8,2').getByTestId('verse-group-title')).toContainText('Psalms 138:7-8 & 2');
  await expect(group(page, '19.138:7-8,2').getByTestId('verse-group-title')).toContainText('Awit 138:7-8 at 2');
  await expect(card(page, samples.firstKey, 'en').getByTestId('verse-unverified')).toBeVisible();
});

test('search and filters narrow the list quickly', async ({ page }) => {
  await resetPerf(page);
  await page.getByTestId('bibles-search').fill(samples.searchWord);
  await expect(page.getByTestId('verse-group')).toHaveCount(1);
  await expect(page.locator('[data-testid="verse-text"] mark').first()).toHaveText(/naaman/i);
  await page.getByTestId('bibles-search').fill('Awit 138');
  await expect(page.getByTestId('verse-group')).toHaveCount(1);
  await page.getByTestId('bibles-search').fill('zzzzzz');
  await expect(page.getByTestId('bibles-empty')).toContainText('No verses match');
  await page.getByTestId('bibles-search').fill('');

  await page.getByTestId('bibles-language').selectOption('tl');
  await expect(page.locator('[data-testid="verse-card"][data-language="en"]')).toHaveCount(0);
  await page.getByTestId('bibles-language').selectOption('en');
  await expect(page.locator('[data-testid="verse-card"][data-language="tl"]')).toHaveCount(0);
  await page.getByTestId('bibles-language').selectOption('all');
  await page.getByTestId('bibles-status').selectOption('verified');
  await page.getByTestId('bibles-status').selectOption('unverified');
  await expect(page.locator('[data-testid="verse-card"][data-status="verified"]')).toHaveCount(0);
  await page.getByTestId('bibles-status').selectOption('all');
  await assertSmooth(page, 'bibles search and filters');
});

test('the sidebar stays available on every desktop section', async ({ page }) => {
  await page.getByTestId('side-lecture').click();
  await expect(page.getByTestId('lecture-page')).toBeVisible();
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await page.getByTestId('side-bibles').click();
  await expect(page.getByTestId('bibles-page')).toBeVisible();
  await expect(page.getByTestId('sidebar')).toBeVisible();
});

test('copy places the reference and exact text on the clipboard', async ({ page }) => {
  const c = card(page, samples.firstKey, 'en');
  const text = await c.getByTestId('verse-text').textContent();
  await c.getByTestId('verse-copy').click();
  await expect(page.getByTestId('toast')).toContainText('Verse copied');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain(samples.firstCopied);
  expect(clip).toContain(text!);
});

test('the source button opens the lesson at the citing page', async ({ page }) => {
  await card(page, samples.thirdKey, 'en').getByTestId('verse-source').click();
  await expect(page.getByTestId('vault-page')).toBeVisible();
  await expect(page.locator('[data-testid="lesson-row"][data-selected="true"]')).toContainText(samples.en.short);
  await expect(page.getByTestId('viewer-page')).toHaveText('2 / 6');
});

test('scan errors can be corrected, and the original extraction is preserved', async ({ page }) => {
  const c = card(page, samples.secondKey, 'en');
  const all: any[] = await (await page.request.get('/api/verses')).json();
  const original = all.find((v) => v.canonical_key === samples.secondKey && v.language === 'en');
  await c.getByTestId('verse-correct').click();
  await expect(page.getByTestId('correct-raw')).toContainText(samples.searchWord);
  await page.getByTestId('correct-cancel').click();
  await expect(page.getByTestId('correct-dialog')).toHaveCount(0);

  await c.getByTestId('verse-correct').click();
  await page.getByTestId('correct-dialog-close').click();
  await c.getByTestId('verse-correct').click();
  await page.getByTestId('correct-text').fill(`${original.text} CORRECTED-MARKER`);
  await page.getByTestId('correct-save').click();
  await expect(page.getByTestId('correct-dialog')).toHaveCount(0);
  await expect(c.getByTestId('verse-text')).toContainText('CORRECTED-MARKER');

  const updated: any[] = await (await page.request.get('/api/verses')).json();
  expect(updated.find((v) => v.id === original.id).ocr_raw).toBe(original.ocr_raw);

  await c.getByTestId('verse-correct').click();
  await page.getByTestId('correct-text').fill(original.text);
  await page.getByTestId('correct-save').click();
  await expect(c.getByTestId('verse-text')).not.toContainText('CORRECTED-MARKER');
});

test('a wrong reference can be corrected, and bad input is refused', async ({ page }) => {
  const c = card(page, '19.138:7-8,2', 'en');
  const id = await c.getAttribute('data-verse-id');
  await c.getByTestId('verse-correct').click();
  await page.getByTestId('correct-reference').fill('Not a reference');
  await page.getByTestId('correct-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'not recognized' })).toBeVisible();
  await page.getByTestId('correct-reference').fill('I Kings 8:1');
  await page.getByTestId('correct-save').click();
  await expect(page.getByTestId('correct-dialog')).toHaveCount(0);
  const moved = group(page, '11.8:1');
  await expect(moved.getByTestId('verse-group-title')).toContainText('I Kings 8:1');
  await expect(moved.getByTestId('verse-group-title')).toContainText('I Hari 8:1');

  const res = await page.request.patch(`/api/verses/${id}`, { data: { reference: 'PS. 138:7-8 & 2' } });
  expect(res.ok()).toBe(true);
});

test('verifying locks a verse for good: no UI path and no API path can change it', async ({ page }) => {
  const c = card(page, samples.firstKey, 'en');
  const id = await c.getAttribute('data-verse-id');
  const text = await c.getByTestId('verse-text').textContent();

  await c.getByTestId('verse-verify').click();
  await page.getByTestId('confirm-cancel').click();
  await expect(c).toHaveAttribute('data-status', 'unverified');

  await c.getByTestId('verse-verify').click();
  await expect(page.getByTestId('confirm-body')).toContainText('can never be edited');
  await page.getByTestId('confirm-accept').click();
  await expect(c.getByTestId('verse-verified')).toBeVisible();
  await expect(c.getByTestId('verse-correct')).toHaveCount(0);
  await expect(c.getByTestId('verse-verify')).toHaveCount(0);

  const tamper = await page.request.patch(`/api/verses/${id}`, { data: { text: 'TAMPERED' } });
  expect(tamper.status()).toBe(409);
  expect((await tamper.json()).error).toContain('cannot be changed');

  await page.reload();
  await page.getByTestId('side-lesson-verses').click();
  await expect(c.getByTestId('verse-text')).toHaveText(text!);
  await expect(c).toHaveAttribute('data-status', 'verified');
  await expect(page.getByTestId('bibles-policy')).toContainText('1 of');
});
