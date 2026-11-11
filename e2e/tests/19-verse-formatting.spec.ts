import type { Locator, Page } from '@playwright/test';
import { test, expect, setAiMode, withEmptyVault } from '../support/fixtures';
import { makePdf } from '../support/pdf';
import { xlsx } from '../support/xlsx';
import { verseTextParts } from '../../frontend/src/verseText';

test('verse markers preserve wording and leave ordinary numbers at the baseline', () => {
  const examples: [string, string[]][] = [
    ['8Subalit gising ang mga bantay. 20Ang pintuan ay bukas.', ['8', '20']],
    ['“20 Ang mga bantay ay handa.”\n  21 “Sila ay gising.”', ['20', '21']],
    ['176Áng pintuan. 9Évery watchman.', ['176', '9']],
    ['May 12,000 bantay, 40-taon, 3 araw at 3rd sa pila, noong 2021.', []],
    ['3rd watch, 21st guard, 22nd bell, 24th hour.', []],
    ['No verse numbers here. ⁸Already raised.', []],
    ['<script>20Ang</script> & 8Subalit', ['8']],
    ['', []],
  ];
  for (const [text, numbers] of examples) {
    const parts = verseTextParts(text);
    expect(parts.map((p) => p.text).join('')).toBe(text);
    expect(parts.filter((p) => p.superscript).map((p) => p.text)).toEqual(numbers);
  }
});

// Synthetic wording only; these test fixtures are not scripture or private lessons.
const lessonText = '8Subalit ang mga bantay ay gising sa pintuan ng bayan, zephyrword.';
const visitText = '20Ang mga bantay ay handa sa pintuan ng bayan, zephyrword.';

async function upload(page: Page, pastoral: boolean) {
  const text = pastoral ? visitText : lessonText;
  const lines = [
    ...(pastoral ? [] : ['Wednesday/Thursday: October 15/16, 2025']),
    'Paksa: Zephyrword at ang mga bantay',
    'PASIMULA:',
    `1. Ang mga bantay ..........Genesis 6:${pastoral ? '20 T4T' : '8 TAT'}`,
    text,
  ];
  const response = await page.request.post('/api/lessons', { multipart: {
    source_kind: 'text',
    ...(pastoral ? { category: 'pastoral' } : {}),
    pages: JSON.stringify([lines.join('\n')]),
    file: { name: pastoral ? '20210110_Markers.pdf' : '2025_Wk42a_Markers.pdf', mimeType: 'application/pdf', buffer: makePdf([lines]) },
  } });
  expect(response.ok()).toBe(true);
  return (await response.json()).lesson;
}

async function formatted(element: Locator, text: string, marker: string) {
  await expect(element).toBeVisible();
  expect(await element.textContent()).toBe(text);
  await expect(element.locator('sup.verse-number')).toHaveText(marker);
  const size = await element.evaluate((el) => ({
    text: parseFloat(getComputedStyle(el).fontSize),
    number: parseFloat(getComputedStyle(el.querySelector('sup')!).fontSize),
    top: parseFloat(getComputedStyle(el.querySelector('sup')!).top),
  }));
  expect(size.number).toBeLessThan(size.text);
  expect(size.top).toBeLessThan(0);
}

test('all verse views raise markers in both libraries, review, checking, and lecture documents', async ({ page }) => {
  await setAiMode('good');
  await withEmptyVault(page, async () => {
    const lesson = await upload(page, false);
    const visit = await upload(page, true);
    const stored = await (await page.request.get('/api/verses')).json();
    expect(stored).toHaveLength(2);
    expect(stored.map((v: any) => v.version)).toEqual(['T4T', 'T4T']);

    for (const [route, text, marker, library] of [
      ['/lesson-verses', lessonText, '8', 'lesson'],
      ['/bibles', visitText, '20', 'verse'],
    ]) {
      await page.goto(route);
      await page.getByTestId('bibles-layout-cards').click();
      await formatted(page.getByTestId('verse-text'), text, marker);
      await expect(page.getByTestId('verse-version')).toHaveText('T4T');
      await page.getByTestId('bibles-search').fill('bantay');
      await expect(page.getByTestId('verse-text').locator('mark')).toContainText(['bantay']);
      await formatted(page.getByTestId('verse-text'), text, marker);
      const firstWord = text.split(' ')[0];
      await page.getByTestId('bibles-search').fill(firstWord);
      expect(await page.getByTestId('verse-text').locator('mark').allTextContents()).toEqual([marker, firstWord.slice(marker.length)]);
      await page.getByTestId('verse-copy').click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(text);
      await page.getByTestId('bibles-layout-table').click();
      await formatted(page.getByTestId('table-text'), text, marker);
      await page.getByTestId('bibles-layout-parallel').click();
      await formatted(page.getByTestId('parallel-text'), text, marker);
      await page.getByTestId('bibles-review').click();
      await expect(page.getByTestId(`review-library-${library}`)).toHaveAttribute('aria-selected', 'true');
      await formatted(page.getByTestId('review-formatted-text'), text, marker);
      await expect(page.getByTestId('review-text')).toHaveValue(text);
    }

    await page.goto('/');
    for (const [id, text, marker] of [[lesson.id, lessonText, '8'], [visit.id, visitText, '20']]) {
      await page.locator(`[data-testid="lesson-row"][data-lesson-id="${id}"]`).getByTestId('lesson-edit').click();
      await formatted(page.getByTestId('check-verse-text'), text, marker);
      await page.getByTestId('check-verse-correct').click();
      await formatted(page.getByTestId('correct-formatted-text'), text, marker);
      await formatted(page.getByTestId('correct-raw'), text, marker);
      await page.getByTestId('correct-text').fill('21Ang mga bantay ay handa.');
      await formatted(page.getByTestId('correct-formatted-text'), '21Ang mga bantay ay handa.', '21');
      await page.getByTestId('correct-cancel').click();
      await page.getByTestId('edit-cancel').click();
    }

    await page.goto('/search');
    await page.getByTestId('page-search-input').fill('zephyrword');
    await expect.poll(async () => (await page.getByTestId('search-verse').locator('sup.verse-number').allTextContents()).sort()).toEqual(['20', '8']);
    await page.getByTestId('page-search-input').fill(visitText);
    await page.getByTestId('search-meaning').click();
    await expect(page.getByTestId('search-meaning-verse').locator('sup.verse-number').first()).toHaveText(/^(8|20)$/);

    await page.goto('/lecture');
    await page.getByTestId('lecture-issue').fill('zephyrword');
    await page.getByTestId('lecture-suggest').click();
    await expect(page.getByTestId('suggested-text')).toHaveCount(2);
    await expect(page.getByTestId('suggested-text').locator('sup.verse-number')).toHaveCount(2);
    const text = (await page.getByTestId('suggested-text').first().textContent())!;
    const marker = text.startsWith('8') ? '8' : '20';
    await page.getByTestId('suggestion-add').first().click();
    await formatted(page.getByTestId('workspace-text'), text, marker);
    await page.getByTestId('lecture-title').fill('Markers in a lecture');
    await page.getByTestId('lecture-preview').click();
    await formatted(page.getByTestId('preview-dialog').getByTestId('doc-text'), text, marker);
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByTestId('print-doc').getByTestId('doc-text').locator('sup.verse-number')).toHaveText(marker);
    await page.emulateMedia({ media: 'screen' });
    await page.getByTestId('preview-close').click();
    await page.getByTestId('lecture-copy').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(text);
    expect(await (await page.request.get('/api/verses')).json()).toEqual(stored);
  });
});

test('imported verse numbers are superscript in the original cell and expanded review source', async ({ page }) => {
  await withEmptyVault(page, async () => {
    const response = await page.request.post('/api/verses/import', { multipart: {
      commit: '1',
      file: { name: 'review-markers.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsx([
        ['Translation', 'Book', 'Chapter', 'Verse', 'Content'],
        ['T4T', 'Genesis', '6', '8', lessonText],
        ['T4T', 'Genesis', '6', '20', visitText],
      ]) },
    } });
    expect(response.ok()).toBe(true);
    const stored = await (await page.request.get('/api/verses')).json();
    expect(stored).toHaveLength(2);
    await page.goto('/review');
    for (const [text, marker] of [[lessonText, '8'], [visitText, '20']]) {
      await formatted(page.getByTestId('review-original'), text, marker);
      if (!(await page.getByTestId('review-raw').isVisible())) await page.getByTestId('review-raw-toggle').click();
      await formatted(page.getByTestId('review-raw'), text, marker);
      // The import removes the marker from editable text, but keeps the original cell.
      await expect(page.getByTestId('review-text')).toHaveValue(text.slice(marker.length));
      await expect(page.getByTestId('review-formatted-text')).toHaveText(text.slice(marker.length));
      if (marker === '8') await page.getByTestId('review-skip').click();
    }
    expect(await (await page.request.get('/api/verses')).json()).toEqual(stored);
  });
});
