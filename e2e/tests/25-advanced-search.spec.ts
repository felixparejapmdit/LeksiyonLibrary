import type { Page } from '@playwright/test';
import { test, expect, withEmptyVault } from '../support/fixtures';
import { makePdf } from '../support/pdf';
import { xlsx } from '../support/xlsx';
import { matchesSearch, normalizeSearch } from '../../frontend/src/search';

// All wording, titles, locations, and documents in this suite are made up.
async function seed(page: Page) {
  const records = [
    { key: 'english', title: 'Steady Course Zephyr', language: 'en', date: '2026-11-08', pastoral: false, reference: 'Genesis 6:8 T4T', text: '8The watchmen serve the people of the town, zephyrbody.', issue: 'Responsibility with patience', objectives: ['Keep hope in every difficulty'] },
    { key: 'tagalog', title: 'Pananampalataya Zephyr', language: 'tl', date: '2025-05-18', pastoral: false, reference: 'Genesis 6:9 AMP', text: '9Ang mga tao ay may pananampalataya at umaasa sa mga pangako, zephyrverse.', issue: 'Pananampalataya sa Diyos', objectives: ['Maging handa sa bawat gawain'] },
    { key: 'visit', title: 'Pagdalaw Zephyr', language: 'tl', date: '2026-03-08', pastoral: true, reference: 'Genesis 6:20 T4T', text: '20Ang mga bantay ay handa sa pintuan ng bayan, zephyrverse.', issue: 'Care for the community', objectives: [] },
  ] as const;
  const saved: Record<string, { id: string; title: string }> = {};
  for (const record of records) {
    const lines = [`Paksa: ${record.title}`, 'PASIMULA:', `1. A sample point ..........${record.reference}`, record.text];
    const result = await page.request.post('/api/lessons', { multipart: {
      source_kind: 'text',
      ...(record.pastoral ? { category: 'pastoral' } : {}),
      pages: JSON.stringify([lines.join('\n')]),
      file: { name: `advanced-${record.key}.pdf`, mimeType: 'application/pdf', buffer: makePdf([lines]) },
    } });
    expect(result.ok()).toBe(true);
    const lesson = (await result.json()).lesson;
    saved[record.key] = { id: lesson.id, title: record.title };
    const patch = await page.request.patch(`/api/lessons/${lesson.id}`, { data: {
      language: record.language, lesson_date: record.date, issue: record.issue, objectives: [...record.objectives],
      ...(record.pastoral ? { local_congregation: 'Sample Local', district: 'Northern District' } : {}),
      ...(record.key === 'english' ? { checked: true } : {}),
    } });
    expect(patch.ok()).toBe(true);
  }
  const imported = await page.request.post('/api/verses/import', { multipart: {
    commit: '1',
    file: { name: 'advanced.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsx([
      ['Translation', 'Book', 'Chapter', 'Verse', 'Content'],
      ['T4T', 'John', '3', '5', '5A kind reply brings hope to the people in the town, zephyrimport.'],
    ]) },
  } });
  expect(imported.ok()).toBe(true);
  const all = await (await page.request.get('/api/verses')).json();
  const verse = all.find((v: any) => v.import_source.startsWith('advanced.xlsx'));
  expect(verse).toBeTruthy();
  expect((await page.request.post(`/api/verses/${verse.id}/verify`)).ok()).toBe(true);
  return { english: saved.english, tagalog: saved.tagalog, visit: saved.visit, imported: { id: verse.id, text: verse.text } };
}

async function openSearch(page: Page) {
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('advanced-search-dialog')).toBeVisible();
  await expect(page.getByTestId('advanced-search-input')).toBeFocused();
}

test('bilingual matching keeps concepts, book names, accents, and literal terms consistent', () => {
  expect(matchesSearch('A lesson on service and hope', 'paglilingkod pag-asa')).toBe(true);
  expect(matchesSearch('Pananampalataya sa Diyos', 'faith')).toBe(true);
  expect(matchesSearch('II Hari 5:15', '2 Kings 5:15')).toBe(true);
  expect(matchesSearch('Genesis 8:6', 'Genesis 6:8')).toBe(false);
  expect(matchesSearch('Ang mga bantay ay handa.', 'watchmen')).toBe(true);
  expect(normalizeSearch('LÓKAL — 8Ang mga tao')).toBe('lokal 8 ang mga tao');
  expect(matchesSearch('Faithful service', 'faith')).toBe(false);
  expect(matchesSearch('A lesson on service', 'service nonexistentword')).toBe(false);
});

test('Ctrl+K searches English or Tagalog metadata and PDF text, then opens a result with the keyboard', async ({ page }) => {
  await withEmptyVault(page, async () => {
    const records = await seed(page);
    await page.goto('/settings');
    await openSearch(page);
    const input = page.getByTestId('advanced-search-input');
    await input.fill('faith');
    await expect(page.getByTestId('advanced-search-lesson')).toHaveCount(1);
    await expect(page.getByTestId('advanced-search-lesson')).toContainText(records.tagalog.title);
    const faith = await page.request.get('/api/search?q=faith');
    expect(faith.ok()).toBe(true);
    expect((await faith.json()).lesson_ids).toContain(records.tagalog.id);

    // These two words occur only in the English PDF body, not its metadata.
    const body = await page.request.get(`/api/search?q=${encodeURIComponent('paglilingkod zephyrbody')}`);
    expect(body.ok()).toBe(true);
    expect((await body.json()).lesson_ids).toContain(records.english.id);
    await input.fill('paglilingkod zephyrbody');
    await expect(page.getByTestId('advanced-search-lesson')).toHaveCount(1);
    await expect(page.getByTestId('advanced-search-lesson')).toContainText(records.english.title);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('advanced-search-dialog')).toHaveCount(0);
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await page.getByTestId('advanced-search-open').click();
    await expect(input).toBeFocused();
    await input.fill('steady course');
    const result = page.getByTestId('advanced-search-lesson');
    await expect(result).toHaveCount(1);
    await input.press('ArrowDown');
    await expect(result).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('advanced-search-dialog')).toHaveCount(0);
    await expect(page.getByTestId('pdf-viewer')).toHaveAttribute('data-lesson', records.english.id);
    await expect(page.getByTestId('viewer-canvas')).toBeVisible();

    // The Search page keeps its shortcut to lessons that use a verse.
    await page.goto('/search');
    await page.getByTestId('page-search-input').fill('Genesis 6:8');
    await page.getByTestId('search-verse').click();
    await expect(page.getByTestId('chip-verse')).toBeVisible();
    await expect(page.getByTestId('lesson-row')).toHaveCount(1);
    await expect(page.getByTestId('lesson-row')).toContainText(records.english.title);
  });
});

test('advanced filters combine correctly and verse/place results open their own libraries', async ({ page }) => {
  await withEmptyVault(page, async () => {
    const records = await seed(page);
    await page.goto('/settings');
    await openSearch(page);
    const input = page.getByTestId('advanced-search-input');
    const lessonResults = page.getByTestId('advanced-search-lesson');
    const verseResults = page.getByTestId('advanced-search-verse');
    const kind = page.getByTestId('advanced-search-kind');
    const language = page.getByTestId('advanced-search-language');
    const year = page.getByTestId('advanced-search-year');
    const status = page.getByTestId('advanced-search-status');

    await input.fill('zephyr');
    await kind.selectOption('lessons');
    await expect(lessonResults).toHaveCount(2);
    await expect(verseResults).toHaveCount(0);
    await expect(page.getByTestId('search-meaning')).toHaveCount(0);
    await language.selectOption('en');
    await year.selectOption('2026');
    await status.selectOption('reviewed');
    await expect(lessonResults).toHaveCount(1);
    await expect(lessonResults).toContainText(records.english.title);
    await status.selectOption('review');
    await expect(lessonResults).toHaveCount(0);
    await page.getByTestId('advanced-search-reset').click();
    await expect(kind).toHaveValue('all');
    await expect(language).toHaveValue('all');
    await expect(year).toHaveValue('all');
    await expect(status).toHaveValue('all');

    await kind.selectOption('visits');
    await language.selectOption('tl');
    await year.selectOption('2026');
    await status.selectOption('review');
    await expect(lessonResults).toHaveCount(1);
    await expect(lessonResults).toContainText(records.visit.title);
    await page.getByTestId('advanced-search-reset').click();

    await page.getByTestId('advanced-search-translation').selectOption('T4T');
    await expect(kind).toHaveValue('verses');
    // A verse-only filter must not silently hide lessons after changing scope.
    await kind.selectOption('lessons');
    await expect(page.getByTestId('advanced-search-translation')).toHaveValue('all');
    await expect(lessonResults).toHaveCount(2);
    await page.getByTestId('advanced-search-translation').selectOption('T4T');
    await language.selectOption('en');
    await status.selectOption('reviewed');
    await expect(lessonResults).toHaveCount(0);
    await expect(verseResults).toHaveCount(1);
    await expect(verseResults).toContainText('zephyrimport');
    // A spreadsheet verse without a lesson source has no inferred year.
    await year.selectOption('2026');
    await expect(verseResults).toHaveCount(0);
    await year.selectOption('all');
    await verseResults.click();
    await expect(page.getByTestId('advanced-search-dialog')).toHaveCount(0);
    await expect(page).toHaveURL(/\/bibles$/);
    await expect(page.locator(`[data-testid="verse-card"][data-verse-id="${records.imported.id}"]`)).toBeVisible();

    await openSearch(page);
    await input.fill('northern district');
    await kind.selectOption('locations');
    const place = page.getByTestId('advanced-search-location');
    await expect(place).toHaveCount(1);
    await expect(place).toContainText('Sample Local');
    await place.click();
    await expect(page.getByTestId('advanced-search-dialog')).toHaveCount(0);
    await expect(page.getByTestId('list-title')).toHaveText('Pastoral Visits');
    await expect(page.getByTestId('library-search')).toHaveValue('Sample Local Northern District');
    await expect(page.getByTestId('lesson-title')).toHaveText(records.visit.title);
  });
});

test('the advanced search dialog fits a small phone and keeps keyboard navigation usable', async ({ page }) => {
  await withEmptyVault(page, async () => {
    const records = await seed(page);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/settings');
    await openSearch(page);
    const dialog = page.getByTestId('advanced-search-dialog');
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(800);
    await expect(page.getByTestId('advanced-search-close')).toBeInViewport();
    for (const control of await dialog.locator('select').all()) {
      const rect = (await control.boundingBox())!;
      expect(rect.x).toBeGreaterThanOrEqual(box.x);
      expect(rect.x + rect.width).toBeLessThanOrEqual(box.x + box.width);
    }
    await page.getByTestId('advanced-search-input').fill('steady course');
    await expect(page.getByTestId('advanced-search-lesson')).toHaveCount(1);
    await page.getByTestId('advanced-search-input').press('ArrowDown');
    await expect(page.getByTestId('advanced-search-lesson')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('mobile-viewer')).toBeVisible();
    await expect(page.getByTestId('pdf-viewer')).toHaveAttribute('data-lesson', records.english.id);
  });
});
