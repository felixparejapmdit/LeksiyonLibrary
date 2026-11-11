import type { Page } from '@playwright/test';
import { test, expect, TEST_PASSPHRASE, withEmptyVault } from '../support/fixtures';
import { makePdf } from '../support/pdf';
import { xlsx } from '../support/xlsx';

// Made-up lesson wording and spreadsheet rows only. The location/footer format is
// the public example supplied with this feature request.
const lessons = async (page: Page): Promise<any[]> => (await page.request.get('/api/lessons')).json();
const verses = async (page: Page): Promise<any[]> => (await page.request.get('/api/verses')).json();

function pdf(name: string, pages: string[][]) {
  return { name, mimeType: 'application/pdf', buffer: makePdf(pages) };
}

async function upload(page: Page, name: string, pages: string[][], pastoral = true) {
  const response = await page.request.post('/api/lessons', {
    multipart: {
      source_kind: 'text',
      pages: JSON.stringify(pages.map((p) => p.join('\n'))),
      ...(pastoral ? { category: 'pastoral' } : {}),
      file: pdf(name, pages),
    },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).lesson;
}

function visitPages(title: string, footerDate: string, local: string, district: string, wording = 'Ang mga bantay ay gising sa gabi at sila ay handa sa kanilang tungkulin.') {
  return [
    [`Paksa: ${title}`, 'PASIMULA:', '1. Ang mga bantay ..........Juan 3:5 NIRV', wording],
    [footerDate, `${local}, ${district}`],
  ];
}

test.describe('library metadata and PDF batches', () => {
  for (const legacyValue of ['missing', 'null'] as const) {
    test(`pastoral year-folder PDFs open when optional metadata is ${legacyValue}`, async ({ page }) => {
      await withEmptyVault(page, async () => {
        await upload(page, `legacy-${legacyValue}.pdf`, visitPages('Legacy Visit Keeps Opening', 'SABADO: ABRIL 4, 2026', 'DEPARO', 'CALOOCAN NORTH'));
        // Simulate a response from an older running backend, before the frontend
        // gained these metadata fields. The real PDF and API stay in use.
        await page.route('**/api/lessons', async (route) => {
          const response = await route.fetch();
          const records = await response.json();
          for (const record of records) {
            for (const field of ['local_congregation', 'district', 'issue', 'objectives']) {
              if (legacyValue === 'missing') delete record[field];
              else record[field] = null;
            }
          }
          await route.fulfill({ response, json: records });
        });
        await page.goto('/');
        await page.getByTestId('side-pv').click();
        await expect(page.getByTestId('list-title')).toHaveText('Pastoral Visits');
        await expect(page.getByTestId('lesson-row')).toHaveCount(1);
        await page.getByTestId('side-bibles').click();
        await expect(page.getByTestId('bibles-title')).toHaveText('Verse Library');
        await page.getByTestId('pv-year-2026').click();
        await expect(page.getByTestId('list-title')).toHaveText('Pastoral Visits');
        await page.getByTestId('pv-year-expand-2026').click();
        await page.getByTestId('tree-lesson').filter({ hasText: 'Legacy Visit Keeps Opening' }).click();
        await expect(page.getByTestId('viewer-canvas')).toBeVisible();
        await expect(page.getByTestId('lesson-title')).toHaveText('Legacy Visit Keeps Opening');
        const search = page.getByTestId('library-search');
        await expect(search).toHaveValue('');
        await expect(page.getByTestId('library-filters').locator('input')).toHaveCount(1);
        await expect(page.locator('input[type="date"]')).toHaveCount(0);
        await search.fill('legacy visit');
        await expect(page.getByTestId('lesson-row')).toHaveCount(1);
        await search.fill('legacy visit nonexistentword');
        await expect(page.getByTestId('lesson-row')).toHaveCount(0);
        await search.fill('legacy visit');
        await expect(page.getByTestId('lesson-row')).toHaveCount(1);
        await expect(page.getByTestId('viewer-canvas')).toBeVisible();
      });
    });
  }

  test('pastoral footer fields and date survive reload and filter together', async ({ page }) => {
    await withEmptyVault(page, async () => {
      const first = await upload(page, 'sample-visit.pdf', visitPages('Keeping Watch', 'SABADO: ABRIL 4, 2026', 'DEPARO', 'CALOOCAN NORTH'));
      await upload(page, 'another-visit.pdf', visitPages('Serving Together', 'LINGGO: ABRIL 5, 2026', 'DEPARO', 'CALOOCAN SOUTH'));
      await upload(page, 'older-visit.pdf', visitPages('Keeping Watch Again', 'BIYERNES: ABRIL 4, 2025', 'SAMPLEVILLE', 'CALOOCAN NORTH'));
      expect(first).toMatchObject({ lesson_date: '2026-04-04', year: 2026 });
      expect(first.local_congregation.toLowerCase()).toBe('deparo');
      expect(first.district.toLowerCase()).toBe('caloocan north');
      expect((await verses(page)).every((v) => !v.text.includes('CALOOCAN') && !v.text.includes('ABRIL'))).toBe(true);

      await page.goto('/');
      await page.getByTestId('side-pv').click();
      await expect(page.getByTestId('lesson-row')).toHaveCount(3);
      const search = page.getByTestId('library-search');
      await expect(page.getByTestId('library-filters').locator('input')).toHaveCount(1);
      await expect(page.locator('input[type="date"]')).toHaveCount(0);
      await search.fill('dePaRo');
      await expect(page.getByTestId('lesson-row')).toHaveCount(2);
      await search.fill('deparo north');
      await expect(page.getByTestId('lesson-row')).toHaveCount(1);
      await expect(page.getByTestId('lesson-title')).toHaveText('Keeping Watch');
      await search.fill('WATCH deparo north');
      await expect(page.getByTestId('lesson-row')).toHaveCount(1);
      await search.fill('watch deparo south');
      await expect(page.getByTestId('lesson-row')).toHaveCount(0);
      await search.fill('paglilingkod deparo south');
      await expect(page.getByTestId('lesson-title')).toHaveText('Serving Together');
      await search.fill('watch deparo north');
      await expect(page.getByTestId('lesson-row')).toHaveCount(1);

      // Corrections replace the searchable fields, and are not lost on reload.
      await page.getByTestId('lesson-edit').click();
      await expect(page.getByTestId('edit-local-congregation')).toHaveValue(/deparo/i);
      await expect(page.getByTestId('edit-district')).toHaveValue(/caloocan north/i);
      await expect(page.getByTestId('edit-date')).toHaveValue('2026-04-04');
      await page.getByTestId('edit-local-congregation').fill('Sample Local');
      await page.getByTestId('edit-district').fill('Sample District');
      await page.getByTestId('edit-save').click();
      await expect(page.getByTestId('edit-dialog')).toHaveCount(0);
      await page.reload();
      await page.getByTestId('side-pv').click();
      await page.getByTestId('library-search').fill('sample local sample district');
      await expect(page.getByTestId('lesson-row')).toHaveCount(1);
      await expect(page.getByTestId('lesson-title')).toHaveText('Keeping Watch');
      expect((await lessons(page)).find((l) => l.id === first.id)).toMatchObject({ local_congregation: 'Sample Local', district: 'Sample District' });

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId('library-search')).toBeInViewport();
      await expect(page.getByTestId('lesson-row')).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.getByTestId('open-drawer').click();
      await page.getByTestId('side-lessons').click();
      await expect(page.getByTestId('library-search')).toBeVisible();
      await expect(page.getByTestId('library-search')).toHaveValue('');
      await expect(page.locator('input[type="date"]')).toHaveCount(0);
      await expect(page.getByTestId('library-filter-issue')).toHaveCount(0);
      await expect(page.getByTestId('library-filter-objective')).toHaveCount(0);
      await expect(page.getByTestId('lesson-drop-browse')).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  });

  test('lesson PDFs can be selected together, filed by year, and searched by their own metadata', async ({ page }) => {
    await withEmptyVault(page, async () => {
      const files = [
        pdf('2025_Wk42a.pdf', [['Wednesday/Thursday: October 15/16, 2025', 'Paksa: Keeping the Night Watch', 'PASIMULA:', 'Talata: Juan 3:5 NIRV']]),
        pdf('2024_Wk41b.pdf', [['Saturday/Sunday: October 12/13, 2024', 'Paksa: Serving the Community', 'PASIMULA:', 'Talata: Juan 3:6 NIRV']]),
      ];
      await page.goto('/');
      await page.getByTestId('side-lessons').click();
      await expect(page.getByTestId('lesson-drop-input')).toHaveAttribute('multiple', '');
      await page.getByTestId('lesson-drop-input').setInputFiles(files);
      await expect(page.getByTestId('lesson-row')).toHaveCount(2, { timeout: 20_000 });
      await expect(page.getByTestId('lesson-folder-2025')).toBeVisible();
      await expect(page.getByTestId('lesson-folder-2024')).toBeVisible();
      await page.getByTestId('lesson-folder-2024').click();
      await expect(page.getByTestId('lesson-title')).toHaveText('Serving the Community');
      await page.getByTestId('lesson-folder-all').click();
      const all = await lessons(page);
      const watch = all.find((l) => l.title === 'Keeping the Night Watch');
      expect(watch).toBeTruthy();
      expect((await page.request.patch(`/api/lessons/${watch.id}`, { data: { issue: 'The watch is often overlooked', objectives: ['Learn patient service', 'Keep watch through the night'] } })).ok()).toBe(true);
      await page.reload();
      await page.getByTestId('side-lessons').click();
      const search = page.getByTestId('library-search');
      await expect(page.getByTestId('library-filters').locator('input')).toHaveCount(1);
      await expect(page.locator('input[type="date"]')).toHaveCount(0);
      await search.fill('night watch OVERLOOKED patient service');
      await expect(page.getByTestId('lesson-title')).toHaveText('Keeping the Night Watch');
      await search.fill('night watch unrelated objective');
      await expect(page.getByTestId('lesson-row')).toHaveCount(0);
      await search.fill('patient service');
      await expect(page.getByTestId('lesson-row')).toHaveCount(1);
      await search.fill('paglilingkod patient');
      await expect(page.getByTestId('lesson-title')).toHaveText('Keeping the Night Watch');
      await search.fill('OVERLOOKED');
      await expect(page.getByTestId('lesson-title')).toHaveText('Keeping the Night Watch');
      await search.fill('community');
      await expect(page.getByTestId('lesson-title')).toHaveText('Serving the Community');
    });
  });
});

test.describe('pastoral verses already in the Verse Library', () => {
  test('identical wording still has a manual keep-both choice, with other languages excluded', async ({ page }) => {
    await withEmptyVault(page, async () => {
      const wording = 'Ang mga bantay ay gising sa gabi at sila ay handa sa kanilang tungkulin.';
      const imported = await page.request.post('/api/verses/import', {
        multipart: { commit: '1', file: { name: 'sample-parallel.xlsx', mimeType: 'application/octet-stream', buffer: xlsx([
          ['PET', 'Book', 'Chapter', 'Verse', 'Content'],
          ['NIRV', 'John', '3', '5', wording],
          ['NIRV', 'John', '3', '5', 'The watchmen are awake in the night and they are ready to do their duty.'],
        ]) } },
      });
      expect(imported.ok()).toBe(true);
      const original = (await verses(page)).find((v) => v.language === 'tl');
      const lesson = await upload(page, 'sample-identical.pdf', visitPages('The Watchmen Wait', 'SABADO: ABRIL 4, 2026', 'DEPARO', 'CALOOCAN NORTH', wording));
      const [comparison] = await (await page.request.get(`/api/lessons/${lesson.id}/verse-comparisons`)).json();
      expect(comparison.candidates.map((v: any) => v.id)).toEqual([original.id]);
      expect(comparison.verse_id).not.toBe(original.id);
      const backup = await (await page.request.post('/api/backup', { data: { passphrase: TEST_PASSPHRASE } })).body();
      expect((await page.request.post('/api/reset', { data: { confirm: 'RESET' } })).ok()).toBe(true);
      const restored = await page.request.post('/api/restore', {
        multipart: { passphrase: TEST_PASSPHRASE, file: { name: 'sample-comparison.lvbackup', mimeType: 'application/octet-stream', buffer: backup } },
      });
      expect(restored.ok()).toBe(true);
      const [pendingAfterRestore] = await (await page.request.get(`/api/lessons/${lesson.id}/verse-comparisons`)).json();
      expect(pendingAfterRestore).toMatchObject({ id: comparison.id, verse_id: comparison.verse_id, decision: '' });
      expect(pendingAfterRestore.candidates.map((v: any) => v.id)).toEqual([original.id]);
      const kept = await page.request.post(`/api/lessons/${lesson.id}/verse-comparisons/${comparison.id}`, { data: { decision: 'both' } });
      expect(kept.ok()).toBe(true);
      const matching = (await verses(page)).filter((v) => v.language === 'tl');
      expect(matching).toHaveLength(2);
      expect(matching.every((v) => v.text === wording)).toBe(true);
      expect(matching.find((v) => v.id === comparison.verse_id).sources[0].lesson_date).toBe('2026-04-04');
    });
  });

  for (const decision of ['existing', 'both'] as const) {
    test(`manual comparison can ${decision === 'existing' ? 'use the existing verse' : 'keep both wordings'} and retain the usage date`, async ({ page }) => {
      await withEmptyVault(page, async () => {
        const importedText = 'Ang mga bantay ay naglilingkod sa bayan at sila ay tapat sa kanilang tungkulin.';
        const parsedText = 'Ang mga bantay ay gising sa gabi at sila ay handa sa kanilang tungkulin.';
        const imported = await page.request.post('/api/verses/import', {
          multipart: { commit: '1', file: { name: 'sample-translations.xlsx', mimeType: 'application/octet-stream', buffer: xlsx([['PET', 'Book', 'Chapter', 'Verse', 'Content'], ['NIRV', 'John', '3', '5', importedText]]) } },
        });
        expect(imported.ok()).toBe(true);
        const [original] = await verses(page);
        expect((await page.request.post(`/api/verses/${original.id}/verify`)).ok()).toBe(true);
        const lesson = await upload(page, `sample-${decision}.pdf`, visitPages('The Watchmen Serve Together', 'SABADO: ABRIL 4, 2026', 'DEPARO', 'CALOOCAN NORTH', parsedText));
        const response = await page.request.get(`/api/lessons/${lesson.id}/verse-comparisons`);
        expect(response.ok()).toBe(true);
        const comparisons = await response.json();
        expect(comparisons).toHaveLength(1);
        expect(comparisons[0].decision).toBe('');
        expect(comparisons[0].candidates.some((v: any) => v.id === original.id)).toBe(true);
        const before = await page.request.patch(`/api/lessons/${lesson.id}`, { data: { checked: true } });
        expect(before.status()).toBe(409);

        await page.goto('/');
        await page.getByTestId('side-pv').click();
        await page.getByTestId('lesson-edit').click();
        const comparison = page.getByTestId('verse-comparison');
        await expect(comparison).toHaveCount(1);
        await expect(comparison.getByTestId('comparison-pdf-text')).toHaveText(parsedText);
        await expect(comparison.getByTestId('comparison-existing-text')).toHaveText(importedText);
        await expect(page.getByTestId('edit-confirm')).toBeDisabled();
        await comparison.getByTestId(decision === 'existing' ? 'comparison-use-existing' : 'comparison-keep-both').click();
        await expect(page.getByTestId('verse-comparison')).toHaveCount(0);
        await expect(page.getByTestId('edit-confirm')).toBeEnabled();
        await page.getByTestId('edit-confirm').click();
        await expect(page.getByTestId('edit-dialog')).toHaveCount(0);
        const all = await verses(page);
        const savedOriginal = all.find((v) => v.id === original.id);
        expect(savedOriginal).toMatchObject({ text: importedText, status: 'verified' });
        const linked = all.filter((v) => v.sources.some((s: any) => s.lesson_id === lesson.id));
        expect(linked).toHaveLength(1);
        expect(linked[0].sources.find((s: any) => s.lesson_id === lesson.id).lesson_date).toBe('2026-04-04');
        expect(linked[0].text).toBe(decision === 'existing' ? importedText : parsedText);
        expect(all).toHaveLength(decision === 'existing' ? 1 : 2);
        const [resolved] = await (await page.request.get(`/api/lessons/${lesson.id}/verse-comparisons`)).json();
        expect(resolved.decision).toBe(decision);
        expect(resolved.resolved_at).toBeTruthy();
        await page.getByTestId('side-bibles').click();
        await expect(page.getByTestId('verse-usage-date')).toContainText('2026-04-04');

        // Usage dates follow the visit's editable date rather than its upload time.
        expect((await page.request.patch(`/api/lessons/${lesson.id}`, { data: { lesson_date: '2026-04-11' } })).ok()).toBe(true);
        const linkedAfter = (await verses(page)).find((v) => v.id === linked[0].id);
        expect(linkedAfter.sources.find((s: any) => s.lesson_id === lesson.id).lesson_date).toBe('2026-04-11');

        if (decision === 'existing') {
          const nextLesson = await upload(page, 'sample-repeated-use.pdf', visitPages('The Watchmen Return', 'SABADO: ABRIL 18, 2026', 'DEPARO', 'CALOOCAN NORTH', parsedText));
          const [nextComparison] = await (await page.request.get(`/api/lessons/${nextLesson.id}/verse-comparisons`)).json();
          expect((await page.request.post(`/api/lessons/${nextLesson.id}/verse-comparisons/${nextComparison.id}`, { data: { decision: 'existing', verse_id: original.id } })).ok()).toBe(true);
          const reused = (await verses(page)).find((v) => v.id === original.id);
          expect(reused.sources.map((s: any) => s.lesson_date).sort()).toEqual(['2026-04-11', '2026-04-18']);
          expect(reused.text).toBe(importedText);
        }
      });
    });
  }
});
