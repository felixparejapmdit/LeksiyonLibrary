import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import type { Page } from '@playwright/test';
import { test, expect, setAiMode, STUB, withEmptyVault, TEST_PASSPHRASE } from '../support/fixtures';
import { makePdf } from '../support/pdf';
import { xlsx } from '../support/xlsx';

// Everything here is made up, as all test data must be: this repository is public.
const MARKER = 'ZEPHYRWORD';
const tl = (extra = '') => `Ang mga tao ay nakinig sa kaniya at hindi sila natakot ${MARKER} ${extra}`.trim();
const en = 'So we continue to tell all of the people about the one who made them.';
const HEADER = ['PET', 'Book', 'Chapter', 'Verse', 'Content'];
const ROWS: string[][] = [
  HEADER,
  ['MSG', 'Colossians', '3', '12', `12${tl()}`],
  ['MSG', 'Colossians', '3', '12', `12${tl()}`], // repeated
  ['ETRB', 'Colossians', '3', '12', `12${en}`], // English under the same reference
  ['MSG', 'Colossians', '3', '12', tl('pangalawa')], // a second wording
  ['AMP2015', 'Mathew', '5', '1', `1${tl('una')}`], // misspelled book
  ['AMP2016', 'Mathew', '5', '2', `‪2${tl('dalawa')}`], // drag-fill, hidden character
  ['NIV', 'John', '1', '7', `9${tl('mali')}`], // number does not match the verse
  ['TLB', 'Peter', '2', '21', tl('walang bilang')], // which Peter?
];

const SHEET = '1abcDEFghiJKLmnoPQRstuVWXyz_0123456789-abcd';
const LINK = `https://docs.google.com/spreadsheets/d/${SHEET}/edit?gid=0#gid=0`;

const csv = (rows: string[][]) => rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
const setSheet = (sheet: { body?: string; status?: number; type?: string }) => fetch(`${STUB}/__sheet`, { method: 'POST', body: JSON.stringify(sheet) });

async function chooseFile(page: Page, name: string, buffer: Buffer) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('import-choose').click();
  await (await chooser).setFiles({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
}

const verses = async (page: Page): Promise<any[]> => (await page.request.get('/api/verses')).json();
const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp-data');
// The app replaces its temporary file as it saves, so one can vanish between listing and reading.
const contentsOf = (file: string) => {
  try {
    return readFileSync(file);
  } catch {
    return Buffer.alloc(0);
  }
};
const everyFile = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? everyFile(join(dir, e.name)) : [join(dir, e.name)]));

test.describe('importing verses', () => {
  test('an Excel file is previewed, then imported with its slips corrected and reported', async ({ page }) => {
    await withEmptyVault(page, async () => {
      // Importing is done in the Verse Library, open while it is still empty.
      await page.goto('/settings');
      await page.getByTestId('settings-open-import').click();
      await expect(page.getByTestId('bibles-title')).toHaveText('Verse Library');
      await expect(page.getByTestId('import-panel')).toHaveAttribute('open', '');
      await chooseFile(page, 'made-up.xlsx', xlsx(ROWS));

      await expect(page.getByTestId('import-summary')).toHaveText('6 new verses ready to import from made-up.xlsx');
      const counts = page.getByTestId('import-counts');
      await expect(counts).toContainText('8 rows read');
      await expect(counts).toContainText('5 Tagalog, 1 English');
      await expect(counts).toContainText('1 repeated rows skipped');
      await expect(counts).toContainText('1 are another wording');
      await expect(page.getByTestId('import-problems')).toContainText('Row 9:');
      await expect(page.getByTestId('import-problems')).toContainText('could be more than one book');
      await expect(page.getByTestId('import-book-fixes')).toContainText('Mathew became Matthew (2)');
      await expect(page.getByTestId('import-translation-fixes')).toContainText('AMP2016 became AMP2015 (1)');
      await expect(page.getByTestId('import-number-fixes')).toContainText('Row 8:');
      await expect(page.getByTestId('import-number-fixes')).toContainText('The Verse column says 7');
      await expect(page.getByTestId('import-flagged')).toHaveCount(0);
      expect(await verses(page), 'a preview saves nothing').toEqual([]);

      await page.getByTestId('import-cancel').click();
      await expect(page.getByTestId('import-preview')).toHaveCount(0);
      expect(await verses(page)).toEqual([]);

      await chooseFile(page, 'made-up.xlsx', xlsx(ROWS));
      await page.getByTestId('import-confirm').click();
      await expect(page.getByTestId('import-count')).toHaveText('6 imported verses in your vault.');
      await expect(page.getByTestId('import-panel-counts')).toHaveText('6 imported, 1 row to fix');
      await expect(page.getByTestId('verse-group')).toHaveCount(4);

      const saved = await verses(page);
      const byRow = (n: number) => saved.find((v) => v.import_source === `made-up.xlsx, row ${n}`);
      expect(byRow(2)).toMatchObject({ canonical_key: '51.3:12', ref_en: 'Colossians 3:12', ref_tl: 'Colosas 3:12', version: 'MSG', language: 'tl', status: 'unverified', text: tl(), ocr_raw: `12${tl()}` });
      expect(byRow(4)).toMatchObject({ canonical_key: '51.3:12', version: 'ETRB', language: 'en', text: en });
      expect(byRow(6)).toMatchObject({ ref_en: 'Matthew 5:1', version: 'AMP2015' });
      expect(byRow(7)).toMatchObject({ version: 'AMP2015', text: tl('dalawa'), ocr_raw: `‪2${tl('dalawa')}` });
      expect(byRow(8), 'the Verse column wins over a number stuck to the text').toMatchObject({ ref_en: 'John 1:7', text: tl('mali'), ref_note: '', ocr_raw: `9${tl('mali')}` });

      // Importing the same file again adds nothing.
      await chooseFile(page, 'made-up.xlsx', xlsx(ROWS));
      await expect(page.getByTestId('import-summary')).toHaveText('0 new verses ready to import from made-up.xlsx');
      await expect(page.getByTestId('import-confirm')).toHaveText('Keep 1 row to fix');
      await expect(page.getByTestId('import-counts')).toContainText('6 already in your vault');
      await page.getByTestId('import-cancel').click();
    });
  });

  test('the Verse Library filters by translation and says where a verse came from', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await page.request.post('/api/verses/import', { multipart: { commit: '1', file: { name: 'made-up.xlsx', mimeType: 'application/octet-stream', buffer: xlsx(ROWS) } } });
      await page.goto('/bibles');
      await expect(page.getByTestId('verse-group')).toHaveCount(4);
      await page.getByTestId('bibles-translation').selectOption('ETRB');
      const card = page.getByTestId('verse-card');
      await expect(card).toHaveCount(1);
      await expect(card.getByTestId('verse-version')).toHaveText('ETRB');
      await expect(card.getByTestId('verse-unverified')).toContainText('Unverified import');
      await expect(card.getByTestId('verse-import-source')).toHaveText('From made-up.xlsx, row 4');
      await expect(card.getByTestId('verse-source')).toHaveCount(0);

      await page.goto('/review');
      await expect(page.getByTestId('review-no-source')).toContainText('Imported from made-up.xlsx');
      await expect(page.getByTestId('review-panel')).toContainText('compared this with the original');
    });
  });

  test('imported verses never appear in the list that filters lessons', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await page.request.post('/api/verses/import', { multipart: { commit: '1', file: { name: 'made-up.xlsx', mimeType: 'application/octet-stream', buffer: xlsx(ROWS) } } });
      await page.goto('/');
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await expect(page.getByRole('button', { name: /Colossians 3:12/ })).toHaveCount(0);
      await expect(page.getByTestId('side-verses-count')).toHaveText('0');
      await expect(page.getByTestId('side-bibles-count'), 'they still count towards the library').toHaveText('6');
    });
  });

  test('the library and review counts are both counts of verses', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await page.request.post('/api/verses/import', { multipart: { commit: '1', file: { name: 'made-up.xlsx', mimeType: 'application/octet-stream', buffer: xlsx(ROWS) } } });
      await page.goto('/');
      await expect(page.getByTestId('side-bibles-count')).toHaveText('6');
      await expect(page.getByTestId('side-review-count'), 'nothing verified yet, so they are equal').toHaveText('6');
      const [first] = await verses(page);
      await page.request.post(`/api/verses/${first.id}/verify`);
      await page.reload();
      await expect(page.getByTestId('side-bibles-count')).toHaveText('6');
      await expect(page.getByTestId('side-review-count'), 'they differ by what has been verified').toHaveText('5');
      await expect(page.getByTestId('side-review-count')).toHaveAttribute('title', '5 of 6 verses still to review: 5 in the Verse Library, 0 in the Lesson Library');
    });
  });

  test('a row left out can be fixed in the app, and stays sealed until then', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await page.goto('/bibles');
      await chooseFile(page, 'made-up.xlsx', xlsx(ROWS));
      await expect(page.getByTestId('rows-to-fix'), 'a preview keeps nothing').toHaveCount(0);
      await page.getByTestId('import-confirm').click();
      await expect(page.getByTestId('toast').filter({ hasText: '1 row to fix below' })).toBeVisible();

      const row = page.getByTestId('fix-row');
      await expect(page.getByTestId('rows-to-fix-title')).toHaveText('Rows to fix (1)');
      await expect(row.getByTestId('fix-row-title')).toHaveText('Row 9 of made-up.xlsx');
      await expect(row.getByTestId('fix-row-message')).toContainText('could be more than one book');
      await expect(row.getByTestId('fix-row-content')).toHaveValue(tl('walang bilang'));
      await expect(row.getByTestId('fix-row-book').locator('option')).toHaveText(['Choose the book (Peter)', 'I Peter', 'II Peter']);
      await expect(row.getByTestId('fix-row-save'), 'the book has to be chosen').toBeDisabled();

      // Sealed on disk, like the verses, and in a backup.
      for (const file of everyFile(dataDir)) expect(contentsOf(file).includes('walang bilang'), file).toBe(false);
      const backup = await (await page.request.post('/api/backup', { data: { passphrase: TEST_PASSPHRASE } })).body();
      await page.request.post('/api/reset', { data: { confirm: 'RESET' } });
      expect(await (await page.request.get('/api/verses/import/rows')).json()).toEqual([]);
      await page.request.post('/api/restore', { multipart: { passphrase: TEST_PASSPHRASE, file: { name: 'b.lvbackup', mimeType: 'application/octet-stream', buffer: backup } } });

      // The Verse Library points to it, and opens the panel it is fixed in.
      await page.goto('/bibles');
      await expect(page.getByTestId('bibles-rows-to-fix')).toContainText('1 imported row was left out');
      await expect(page.getByTestId('import-panel'), 'closed once verses are imported').not.toHaveAttribute('open', '');
      await page.getByTestId('bibles-rows-to-fix-open').click();
      await expect(page.getByTestId('rows-to-fix')).toBeVisible();
      await expect(page.getByTestId('rows-to-fix')).toBeInViewport();

      // A correction goes through the same checks as the sheet.
      await row.getByTestId('fix-row-book').selectOption('II Peter');
      await row.getByTestId('fix-row-chapter').fill('x');
      await row.getByTestId('fix-row-save').click();
      await expect(page.getByTestId('toast').filter({ hasText: 'were not understood' })).toBeVisible();
      expect(await verses(page)).toHaveLength(6);
      await row.getByTestId('fix-row-chapter').fill('2');
      await row.getByTestId('fix-row-save').click();
      await expect(page.getByTestId('rows-to-fix')).toHaveCount(0);
      await expect(page.getByTestId('side-bibles-count')).toHaveText('7');
      const fixed = (await verses(page)).find((v) => v.import_source === 'made-up.xlsx, row 9');
      expect(fixed).toMatchObject({ ref_en: 'II Peter 2:21', version: 'TLB', status: 'unverified', text: tl('walang bilang') });

      // Importing the same sheet again neither adds it twice nor asks again.
      await chooseFile(page, 'made-up.xlsx', xlsx(ROWS));
      await expect(page.getByTestId('import-summary')).toHaveText('0 new verses ready to import from made-up.xlsx');
      await expect(page.getByTestId('import-problems')).toHaveCount(0);
      await expect(page.getByTestId('import-confirm')).toBeDisabled();
      await page.getByTestId('import-cancel').click();
    });
  });

  test('a row left out can be set aside, and fixing the sheet clears it', async ({ page }) => {
    await withEmptyVault(page, async () => {
      const send = (rows: string[][]) => page.request.post('/api/verses/import', { multipart: { commit: '1', file: { name: 'made-up.xlsx', mimeType: 'application/octet-stream', buffer: xlsx(rows) } } });
      await send(ROWS);
      await page.goto('/bibles');
      await page.getByTestId('import-panel-toggle').click();
      await page.getByTestId('fix-row-dismiss').click();
      await page.getByTestId('confirm-accept').click();
      await expect(page.getByTestId('rows-to-fix')).toHaveCount(0);

      // The sheet still has the slip, so importing it brings the row back.
      await send(ROWS);
      await page.reload();
      await page.getByTestId('bibles-rows-to-fix-open').click();
      await expect(page.getByTestId('rows-to-fix-title')).toHaveText('Rows to fix (1)');

      // Fixed in the sheet, it becomes a verse and leaves the list.
      await send(ROWS.map((r) => (r[1] === 'Peter' ? ['TLB', 'I Peter', r[2], r[3], r[4]] : r)));
      await page.reload();
      await expect(page.getByTestId('rows-to-fix')).toHaveCount(0);
      expect((await verses(page)).filter((v) => v.ref_en === 'I Peter 2:21')).toHaveLength(1);

      expect((await page.request.post('/api/verses/import/rows/nope', { data: { translation: 'A', book: 'John', chapter: '1', verse: '1', content: 'x' } })).status()).toBe(404);
      expect((await page.request.delete('/api/verses/import/rows/nope')).status()).toBe(404);

      // Undoing an import clears what it left behind.
      await send(ROWS);
      await page.request.delete('/api/verses/import');
      expect(await (await page.request.get('/api/verses/import/rows')).json()).toEqual([]);
    });
  });

  test('a left-out row the sheet also has under its full reference needs no fixing, and is never saved twice', async ({ page }) => {
    await withEmptyVault(page, async () => {
      const send = async (rows: string[][]) => (await page.request.post('/api/verses/import', { multipart: { commit: '1', file: { name: 'made-up.xlsx', mimeType: 'application/octet-stream', buffer: xlsx(rows) } } })).json();
      const words = tl('parehong salita');
      const report = await send([HEADER, ['TLB', 'I Peter', '2', '21', `21${words}`], ['TLB', 'Peter', '2', '21', `21 ${words}`], ['TLB', 'Peter', '2', '23', `23${words}`]]);
      expect(report.problems.map((p: { row: number }) => p.row), 'only the one that really needs a book').toEqual([4]);

      // Saving it as a verse already there does not make a second copy.
      const [row] = await (await page.request.get('/api/verses/import/rows')).json();
      await send([HEADER, ['TLB', 'I Peter', '2', '23', `23 ${words}`], ['TLB', 'Peter', '2', '23', `23${words}`]]);
      expect(await (await page.request.get('/api/verses/import/rows')).json(), 'settled by the sheet').toEqual([]);
      expect((await verses(page)).filter((v) => v.ref_en === 'I Peter 2:23')).toHaveLength(1);
      expect(row.choices).toEqual(['I Peter', 'II Peter']);

      await send([HEADER, ['TLB', 'II Timothy', '3', '14', `14 ${words}`], ['TLB', 'Kings', '1', '1', `1${words}`]]);
      const [kings] = await (await page.request.get('/api/verses/import/rows')).json();
      const before = (await verses(page)).length;
      await page.request.post(`/api/verses/import/rows/${kings.id}`, { data: { translation: 'TLB', book: 'II Timothy', chapter: '3', verse: '14', content: `1${words}` } });
      expect((await verses(page)).length, 'the same words on the same verse are not added again').toBe(before);
      expect(await (await page.request.get('/api/verses/import/rows')).json()).toEqual([]);
    });
  });

  test('a file that is not right is refused with a clear reason', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await page.goto('/bibles');
      await chooseFile(page, 'wrong.xlsx', xlsx([['Name', 'Age'], ['A', '1']]));
      await expect(page.getByTestId('toast').filter({ hasText: 'needs a sheet with these columns' })).toBeVisible();
      await chooseFile(page, 'text.xlsx', Buffer.from('not a spreadsheet'));
      await expect(page.getByTestId('toast').filter({ hasText: 'not an .xlsx file' })).toBeVisible();
      await expect(page.getByTestId('import-preview')).toHaveCount(0);
    });
  });

  test('imported verses are sealed on disk, and travel in a backup', async ({ page }) => {
    await withEmptyVault(page, async () => {
      const res = await page.request.post('/api/verses/import', { multipart: { commit: '1', file: { name: 'made-up.xlsx', mimeType: 'application/octet-stream', buffer: xlsx(ROWS) } } });
      expect((await res.json()).new_verses).toBe(6);
      for (const file of everyFile(dataDir)) {
        expect(contentsOf(file).includes(MARKER), `${file} must not hold readable verse text`).toBe(false);
        expect(file.toLowerCase()).not.toMatch(/\.xlsx$/);
      }
      const backup = await (await page.request.post('/api/backup', { data: { passphrase: TEST_PASSPHRASE } })).body();
      expect(backup.includes(MARKER)).toBe(false);
      await page.request.post('/api/reset', { data: { confirm: 'RESET' } });
      expect(await verses(page)).toEqual([]);
      await page.request.post('/api/restore', { multipart: { passphrase: TEST_PASSPHRASE, file: { name: 'b.lvbackup', mimeType: 'application/octet-stream', buffer: backup } } });
      const restored = await verses(page);
      expect(restored).toHaveLength(6);
      expect(restored.every((v) => v.import_source.startsWith('made-up.xlsx, row'))).toBe(true);
    });
  });

  test('an import can be undone, but never takes a verse the user verified or uses', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await page.request.post('/api/verses/import', { multipart: { commit: '1', file: { name: 'made-up.xlsx', mimeType: 'application/octet-stream', buffer: xlsx(ROWS) } } });
      const [verified, used] = await verses(page);
      await page.request.post(`/api/verses/${verified.id}/verify`);
      await page.request.post('/api/lectures', { data: { title: 'Keeps it', issue: '', objective: '', verse_ids: [used.id] } });

      await page.goto('/bibles');
      await page.getByTestId('import-panel-toggle').click();
      await page.getByTestId('import-remove').click();
      await page.getByTestId('confirm-accept').click();
      await expect(page.getByTestId('import-count')).toHaveText('2 imported verses in your vault.');
      expect((await verses(page)).map((v) => v.id).sort()).toEqual([verified.id, used.id].sort());
    });
  });
});

test.describe('a large Bibles Library', () => {
  const large = () => {
    const rows = [HEADER];
    for (let chapter = 1; chapter <= 12; chapter++) {
      for (let verse = 1; verse <= 10; verse++) rows.push(['NIV', 'Romans', String(chapter), String(verse), `Ang mga tao ay nakinig sa kaniya at hindi sila natakot blg${chapter}x${verse}`]);
    }
    for (const code of ['AAA', 'BBB', 'CCC', 'DDD']) rows.push([code, 'John', '3', '5', `Ang salita ay ${code} para sa mga tao at sila ay natuwa`]);
    return rows;
  };
  const load = async (page: Page) => {
    await page.request.post('/api/verses/import', { multipart: { commit: '1', file: { name: 'large.xlsx', mimeType: 'application/octet-stream', buffer: xlsx(large()) } } });
    await page.goto('/bibles');
    await expect(page.getByTestId('bibles-range')).toHaveText('1–25 of 121 references, 124 verses');
  };

  test('verses are paged, and only one page is ever on screen', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await load(page);
      const groups = page.getByTestId('verse-group');
      await expect(groups).toHaveCount(25);
      await expect(page.getByTestId('bibles-page-prev')).toBeDisabled();
      const firstKey = await groups.first().getAttribute('data-key');

      await page.getByTestId('bibles-page-next').click();
      await expect(page.getByTestId('bibles-range')).toHaveText('26–50 of 121 references, 124 verses');
      expect(await groups.first().getAttribute('data-key')).not.toBe(firstKey);
      await page.getByTestId('bibles-page-prev').click();
      await expect(groups.first()).toHaveAttribute('data-key', firstKey!);

      await page.getByRole('button', { name: 'Page 5', exact: true }).click();
      await expect(page.getByTestId('bibles-range')).toHaveText('101–121 of 121 references, 124 verses');
      await expect(page.getByTestId('bibles-page-next')).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Page 5', exact: true })).toHaveAttribute('aria-current', 'page');

      await page.getByTestId('bibles-page-size').selectOption('100');
      await expect(page.getByTestId('bibles-range')).toHaveText('1–100 of 121 references, 124 verses');
      await expect(groups).toHaveCount(100);
      await page.getByTestId('bibles-page-size').selectOption('25');
    });
  });

  test('filters start again from page one, and clearing them brings everything back', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await load(page);
      await page.getByTestId('bibles-page-next').click();
      await page.getByTestId('bibles-book').selectOption({ label: 'John' });
      await expect(page.getByTestId('bibles-range')).toHaveText('1–1 of 1 reference, 4 verses');
      await expect(page.getByTestId('bibles-pagination')).toHaveCount(0);

      await page.getByTestId('bibles-clear').click();
      await expect(page.getByTestId('bibles-range')).toHaveText('1–25 of 121 references, 124 verses');
      await expect(page.getByTestId('bibles-clear')).toHaveCount(0);

      await page.getByTestId('bibles-search').fill('blg7x3');
      await expect(page.getByTestId('bibles-range')).toHaveText('1–1 of 1 reference, 1 verse');
      await expect(page.getByTestId('verse-group-title')).toContainText('Romans 7:3');
      await page.getByTestId('bibles-clear').click();
    });
  });

  test('extra translations of a reference fold away until asked for', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await load(page);
      await page.getByTestId('bibles-book').selectOption({ label: 'John' });
      const group = page.getByTestId('verse-group');
      await expect(group.getByTestId('verse-card')).toHaveCount(1);
      await expect(group.getByTestId('verse-group-count')).toContainText('4 verses');
      await group.getByTestId('verse-group-more').click();
      await expect(group.getByTestId('verse-card')).toHaveCount(4);
      await expect(group.getByTestId('verse-group-more')).toHaveCount(0);
      await page.getByTestId('bibles-clear').click();
    });
  });

  test('coming back to the page finds it where it was left', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await load(page);
      await page.getByTestId('bibles-page-next').click();
      await expect(page.getByTestId('bibles-range')).toHaveText('26–50 of 121 references, 124 verses');
      await page.getByTestId('side-lecture').click();
      await expect(page.getByTestId('lecture-page')).toBeVisible();
      await page.getByTestId('side-bibles').click();
      await expect(page.getByTestId('bibles-range')).toHaveText('26–50 of 121 references, 124 verses');
    });
  });

  test('the table shows every verse on one line, in the columns of the sheet', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await load(page);
      await page.getByTestId('bibles-layout-table').click();
      await expect(page.getByTestId('bibles-layout-table')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('bibles-range')).toHaveText('1–25 of 124 verses');
      await expect(page.getByTestId('table-row')).toHaveCount(25);
      await expect(page.getByTestId('bibles-table').locator('th')).toHaveText(['Open', 'Translation', 'Book', 'Chapter', 'Verse', 'Content', 'Language', 'Status']);

      await page.getByTestId('bibles-book').selectOption({ label: 'John' });
      await expect(page.getByTestId('bibles-range')).toHaveText('1–4 of 4 verses');
      const row = page.getByTestId('table-row').first();
      await expect(row.getByTestId('table-translation')).toHaveText('AAA');
      await expect(row.getByTestId('table-book')).toHaveText('John');
      await expect(row.getByTestId('table-chapter')).toHaveText('3');
      await expect(row.getByTestId('table-verse')).toHaveText('5');
      await expect(row.getByTestId('table-text')).toContainText('Ang salita ay AAA');
      await expect(row.getByTestId('table-language')).toHaveText('Tagalog');
      await expect(row.getByTestId('table-status')).toHaveText('Unverified');

      // A row stays one line tall however long its verse is, and opens to the full card.
      const height = (await row.boundingBox())!.height;
      expect(height).toBeLessThan(45);
      await row.getByTestId('table-row-toggle').click();
      await expect(page.getByTestId('table-row-detail').getByTestId('verse-text')).toContainText('Ang salita ay AAA');
      await page.getByTestId('table-row-detail').getByTestId('verse-verify').click();
      await page.getByTestId('confirm-accept').click();
      await expect(row.getByTestId('table-status')).toHaveText('Verified');
      await row.getByTestId('table-row-toggle').click();
      await expect(page.getByTestId('table-row-detail')).toHaveCount(0);

      // Paged by lines, and the choice of view is still there after a reload.
      await page.getByTestId('bibles-clear').click();
      await page.getByTestId('bibles-page-next').click();
      await expect(page.getByTestId('bibles-range')).toHaveText('26–50 of 124 verses');
      await page.reload();
      await expect(page.getByTestId('bibles-table')).toBeVisible();
      await page.getByTestId('bibles-layout-cards').click();
      await expect(page.getByTestId('bibles-table')).toHaveCount(0);
      await expect(page.getByTestId('verse-group')).toHaveCount(25);
    });
  });

  test('the parallel view lines up two translations of the same verse', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await page.request.post('/api/verses/import', {
        multipart: {
          commit: '1',
          file: {
            name: 'parallel.xlsx',
            mimeType: 'application/octet-stream',
            buffer: xlsx([HEADER, ['MSG', 'John', '1', '1', tl('una')], ['ETRB', 'John', '1', '1', en], ['CEV', 'John', '1', '1', tl('pangalawa')], ['MSG', 'John', '1', '2', tl('dalawa')]]),
          },
        },
      });
      await page.goto('/bibles');
      await page.getByTestId('bibles-layout-parallel').click();
      await expect(page.getByTestId('bibles-translation'), 'the sides choose these instead').toHaveCount(0);
      await expect(page.getByTestId('bibles-language')).toHaveCount(0);
      await expect(page.getByTestId('bibles-range')).toHaveText('1–2 of 2 references');

      const first = page.getByTestId('parallel-row').first();
      await expect(first.getByTestId('parallel-title')).toContainText('John 1:1');
      await expect(first.getByTestId('parallel-side-left')).toContainText('ETRB');
      await expect(first.getByTestId('parallel-side-left')).toContainText(en);
      await expect(first.getByTestId('parallel-side-right').getByTestId('parallel-verse'), 'every wording on that side').toHaveCount(2);

      // They really sit side by side at this width.
      const [a, b] = [await first.getByTestId('parallel-side-left').boundingBox(), await first.getByTestId('parallel-side-right').boundingBox()];
      expect(b!.x).toBeGreaterThan(a!.x + a!.width - 2);
      expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);

      // A side with nothing says so, and can be left out.
      await expect(page.getByTestId('parallel-row').nth(1).getByTestId('parallel-empty')).toHaveText('No English for this verse.');
      await page.getByTestId('parallel-both').check();
      await expect(page.getByTestId('parallel-row')).toHaveCount(1);
      await page.getByTestId('parallel-both').uncheck();

      // Each side can be one translation.
      await page.getByTestId('parallel-left').selectOption('MSG');
      await page.getByTestId('parallel-right').selectOption('CEV');
      await expect(first.getByTestId('parallel-side-left').getByTestId('parallel-text')).toHaveText(tl('una'));
      await expect(first.getByTestId('parallel-side-right').getByTestId('parallel-text')).toHaveText(tl('pangalawa'));
      await first.getByTestId('parallel-side-left').getByTestId('parallel-copy').click();
      await expect(page.getByTestId('toast').first()).toBeVisible();

      // No match says why, and search still applies to both sides.
      await page.getByTestId('parallel-both').check();
      await page.getByTestId('bibles-search').fill('dalawa');
      await expect(page.getByTestId('bibles-empty')).toContainText('No verses match these two sides');
      await page.getByTestId('bibles-clear').click();

      await page.setViewportSize({ width: 390, height: 800 });
      await page.getByTestId('parallel-both').uncheck();
      const narrow = [await first.getByTestId('parallel-side-left').boundingBox(), await first.getByTestId('parallel-side-right').boundingBox()];
      expect(narrow[1]!.y, 'on a phone the sides stack').toBeGreaterThan(narrow[0]!.y);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.getByTestId('bibles-layout-cards').click();
    });
  });

  test('verse text is never written to the browser cache', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await load(page);
      const res = await page.request.get('/api/verses');
      expect(res.headers()['cache-control']).toBe('no-store');
    });
  });
});

test.describe('importing from Google Sheets', () => {
  test('a link loads the sheet, and after that the gid alone is enough', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await setSheet({ body: csv(ROWS) });
      await page.goto('/bibles');
      await expect(page.getByTestId('import-sheet-warning')).toContainText('anyone who gets the link can read it');
      await expect(page.getByTestId('import-sheet-saved')).toHaveCount(0);

      // A gid means nothing until a spreadsheet is known.
      await page.getByTestId('import-sheet').fill('0');
      await page.getByTestId('import-sheet-load').click();
      await expect(page.getByTestId('toast').filter({ hasText: 'Paste the whole Google Sheets link' })).toBeVisible();

      await page.getByTestId('import-sheet').fill(LINK);
      await page.getByTestId('import-sheet-load').click();
      await expect(page.getByTestId('import-summary')).toHaveText('6 new verses ready to import from Google Sheet');
      expect(await verses(page), 'a preview saves nothing').toEqual([]);
      await page.getByTestId('import-confirm').click();
      await expect(page.getByTestId('import-count')).toHaveText('6 imported verses in your vault.');
      expect((await verses(page)).some((v) => v.import_source === 'Google Sheet, row 2')).toBe(true);
      await expect(page.getByTestId('import-sheet-saved')).toBeVisible();

      // Another tab of the same spreadsheet, by gid alone.
      await setSheet({ body: csv([HEADER, ['NLT', 'John', '3', '5', `5${tl('ibang tab')}`]]) });
      await page.getByTestId('import-sheet').fill('1945');
      await page.getByTestId('import-sheet-load').click();
      await expect(page.getByTestId('import-summary')).toHaveText('1 new verse ready to import from Google Sheet');
      await page.getByTestId('import-cancel').click();

      // Reset forgets the spreadsheet too.
      await page.request.post('/api/reset', { data: { confirm: 'RESET' } });
      expect((await (await page.request.get('/api/status')).json()).has_saved_sheet).toBe(false);
    });
  });

  test('a private or missing sheet explains what to do, and saves nothing', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await page.goto('/bibles');
      const load = async (value: string) => {
        await page.getByTestId('import-sheet').fill(value);
        await page.getByTestId('import-sheet-load').click();
      };
      // Google answers a private sheet with a sign-in page, not an error.
      await setSheet({ status: 200, type: 'text/html', body: '<!doctype html><title>Sign in</title>' });
      await load(LINK);
      await expect(page.getByTestId('toast').filter({ hasText: 'Anyone with the link' }).last()).toBeVisible();

      await setSheet({ status: 403, type: 'text/html', body: 'no' });
      await load(LINK);
      await expect(page.getByTestId('toast').filter({ hasText: 'Anyone with the link' }).last()).toBeVisible();

      await setSheet({ status: 404, type: 'text/html', body: 'no' });
      await load(LINK);
      await expect(page.getByTestId('toast').filter({ hasText: 'could not find that spreadsheet' })).toBeVisible();

      await load('https://evil.example/data.csv');
      await expect(page.getByTestId('toast').filter({ hasText: 'not a Google Sheets link' })).toBeVisible();

      expect(await verses(page)).toEqual([]);
      expect((await (await page.request.get('/api/status')).json()).has_saved_sheet, 'a sheet that failed is not remembered').toBe(false);
      await setSheet({ status: 200, type: 'text/csv', body: '' });
    });
  });
});

async function lessonVerse(page: Page) {
  const res = await page.request.post('/api/lessons', {
    multipart: {
      source_kind: 'text',
      pages: JSON.stringify(['Saturday/Sunday: March 3/4, 2001\nPaksa: Made Up\nA. A point ..... Juan 3:5 NIRV\nThe first made up verse speaks about a vocation from above.\nB Next point']),
      file: { name: 'made-up.pdf', mimeType: 'application/pdf', buffer: makePdf([['Made Up']]) },
    },
  });
  expect(res.ok()).toBeTruthy();
}

async function ask(page: Page, objective = 'vocation') {
  await page.goto('/lecture');
  await page.getByTestId('lecture-objective').fill(objective);
  await page.getByTestId('lecture-suggest').click();
  await expect(page.getByTestId('suggestions')).toBeVisible();
  await expect(page.getByTestId('notes-loading')).toHaveCount(0, { timeout: 15_000 });
}

test.describe('verse details', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('lv.langReset')) {
        localStorage.removeItem('lv.contextLanguage');
        sessionStorage.setItem('lv.langReset', '1');
      }
    });
    await setAiMode('good');
  });

  test('details stay folded until asked for, and hold all three contexts', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await lessonVerse(page);
      await ask(page);
      const chapter = page.getByTestId('verse-context-chapter');
      const toggle = page.getByTestId('verse-context-toggle');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(toggle).toContainText('AI, review before use');
      await expect(chapter).toBeHidden();
      await expect(page.getByTestId('ai-note')).toBeHidden();
      await expect(page.getByTestId('context-edit')).toBeHidden();

      // The folded card is shorter than the open one.
      const card = page.getByTestId('suggestion').first();
      const folded = (await card.boundingBox())!.height;
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(chapter).toContainText('Chapter context (John 3): STUB-CHAPTER');
      await expect(page.getByTestId('verse-context-book')).toContainText('Book context (John): STUB-BOOK');
      await expect(page.getByTestId('verse-context-history')).toContainText('Historical and political context (John): STUB-HISTORY');
      await expect(page.getByTestId('ai-note')).toContainText('AI note, not scripture');
      expect(folded).toBeLessThan((await card.boundingBox())!.height);

      await toggle.click();
      await expect(chapter).toBeHidden();
    });
  });

  test('printing a lecture includes the details even though they are folded on screen', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await lessonVerse(page);
      await ask(page);
      await page.getByTestId('suggestion-add').first().click();
      const chapter = page.getByTestId('workspace-context-chapter');
      await expect(chapter).toBeHidden();
      await page.emulateMedia({ media: 'print' });
      await expect(chapter).toBeVisible();
      await expect(page.getByTestId('workspace-context-toggle')).toBeHidden();
      await expect(page.getByTestId('context-language').last()).toBeHidden();
      await page.emulateMedia({ media: 'screen' });
    });
  });

  test('the switch slides across and shows the context in Tagalog, still labelled as AI', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await lessonVerse(page);
      await ask(page);
      await page.getByTestId('verse-context-toggle').click();
      const toggle = page.getByTestId('context-language').first();
      const thumb = page.getByTestId('context-language-thumb').first();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      const left = (await thumb.boundingBox())!.x;
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect.poll(async () => (await thumb.boundingBox())!.x).toBeGreaterThan(left);

      await expect(page.getByTestId('verse-context-chapter')).toContainText('Konteksto ng kabanata (Juan 3): STUB-TAGALOG');
      await expect(page.getByTestId('verse-context-book')).toContainText('Konteksto ng aklat (Juan): STUB-TAGALOG');
      await expect(page.getByTestId('verse-context-history')).toContainText('Kontekstong pangkasaysayan at pampulitika (Juan): STUB-TAGALOG');
      await expect(page.getByTestId('verse-context-speaker')).toContainText('Nagsasalita: STUB-TAGALOG');
      await expect(page.getByTestId('ai-note')).toContainText('STUB-TAGALOG');
      await expect(page.getByTestId('verse-context-label')).toHaveText('Konteksto mula sa AI, hindi Kasulatan. Suriin bago gamitin.');

      // The choice and the translations last.
      await page.reload();
      await ask(page);
      await page.getByTestId('verse-context-toggle').click();
      await expect(page.getByTestId('context-language').first()).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('verse-context-chapter')).toContainText('STUB-TAGALOG');
      expect(Object.keys(await (await page.request.get('/api/context-tagalog')).json()).length).toBeGreaterThanOrEqual(4);

      // And back again.
      await page.getByTestId('context-language').first().click();
      await expect(page.getByTestId('verse-context-chapter')).toContainText('Chapter context (John 3): STUB-CHAPTER');
    });
  });

  test('nothing is translated until the details are open in Tagalog', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await lessonVerse(page);
      await page.addInitScript(() => localStorage.setItem('lv.contextLanguage', 'tl'));
      await ask(page);
      expect(await (await page.request.get('/api/context-tagalog')).json()).toEqual({});
    });
  });

  test('a review in one language does not vouch for the other', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await lessonVerse(page);
      await ask(page);
      await page.getByTestId('verse-context-toggle').click();
      await page.getByTestId('context-edit').click();
      await expect(page.getByTestId('context-history')).toHaveValue(/STUB-HISTORY/);
      await page.getByTestId('context-chapter').fill('My chapter wording.');
      await page.getByTestId('context-history').fill('My history wording.');
      await page.getByTestId('context-save').click();
      await expect(page.getByTestId('verse-context-label')).toHaveText('Reviewed by you.');

      // The AI translating reviewed English is still the AI's work.
      await page.getByTestId('context-language').first().click();
      await expect(page.getByTestId('verse-context-chapter')).toContainText('STUB-TAGALOG');
      await expect(page.getByTestId('verse-context-label')).toHaveText('Konteksto mula sa AI, hindi Kasulatan. Suriin bago gamitin.');

      // Correcting the Tagalog leaves it reviewed, and the English untouched.
      await page.getByTestId('context-edit').click();
      await page.getByTestId('context-chapter').fill('Sariling salita ko para sa kabanata.');
      await page.getByTestId('context-save').click();
      await expect(page.getByTestId('verse-context-chapter')).toContainText('Sariling salita ko');
      const scripture: any = await (await page.request.get('/api/scripture-context')).json();
      expect(scripture['chapter:43.3'].context).toBe('My chapter wording.');
      const saved: any = await (await page.request.get('/api/context-tagalog')).json();
      expect(saved['chapter:43.3']).toEqual({ text: 'Sariling salita ko para sa kabanata.', reviewed: true });

      // Both tabs of the dialog were used, so both are saved.
      await page.getByTestId('context-edit').click();
      await page.getByTestId('context-dialog-language').click();
      await expect(page.getByTestId('context-chapter')).toHaveValue('My chapter wording.');
      await page.getByTestId('context-cancel').click();
    });
  });

  test('changing the English drops a stale AI translation but keeps the user\'s own', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await lessonVerse(page);
      await ask(page);
      await page.getByTestId('verse-context-toggle').click();
      const post = (scope: string, context: string) => page.request.post('/api/scripture-context', { data: { scope, context } });
      await page.getByTestId('context-language').first().click();
      await expect(page.getByTestId('verse-context-history')).toContainText('STUB-TAGALOG');
      await page.request.post('/api/context-tagalog', { data: { item: 'book:43', text: 'Akin ito.' } });

      await post('history:43', 'Different English.');
      await post('book:43', 'Different English too.');
      const saved: any = await (await page.request.get('/api/context-tagalog')).json();
      expect(saved['history:43'], 'stale AI wording is gone').toBeUndefined();
      expect(saved['book:43']).toEqual({ text: 'Akin ito.', reviewed: true });
    });
  });

  test('a poor or missing translation falls back to English and says so', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await lessonVerse(page);
      await ask(page);
      await setAiMode('hostile');
      await page.getByTestId('verse-context-toggle').click();
      await page.getByTestId('context-language').first().click();
      await expect(page.getByTestId('verse-context-translating')).toContainText('could not give a usable Tagalog');
      await expect(page.getByTestId('verse-context-chapter')).toContainText('STUB-CHAPTER');
      expect(await (await page.request.get('/api/context-tagalog')).json()).toEqual({});

      await setAiMode('down');
      await page.reload();
      await setAiMode('good');
      await ask(page);
      await setAiMode('down');
      await page.getByTestId('verse-context-toggle').click();
      await expect(page.getByTestId('verse-context-translating')).toContainText('Local AI is offline');
      await expect(page.getByTestId('verse-context-chapter')).toContainText('STUB-CHAPTER');
      await setAiMode('good');
    });
  });

  test('presentations, copies and Word files follow the language chosen', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await lessonVerse(page);
      await ask(page);
      await page.getByTestId('suggestion-add').first().click();
      await page.getByTestId('lecture-title').fill('Made up');

      await page.getByTestId('lecture-present').click();
      await page.getByTestId('present-context').click();
      const panel = page.getByTestId('present-context-text');
      await expect(panel).toContainText('Historical and political context (John): STUB-HISTORY');
      await page.getByTestId('present-context-language').click();
      await expect(panel).toContainText('Kontekstong pangkasaysayan at pampulitika (Juan): STUB-TAGALOG');
      await page.getByTestId('present-exit').click();

      const body = { title: 'Made up', issue: '', objective: '', verse_ids: (await verses(page)).map((v) => v.id), verse_objectives: [] };
      const word = async (context_language: string) => {
        const res = await page.request.post('/api/lectures/export', { data: { ...body, context_language } });
        return new AdmZip(await res.body()).readAsText('word/document.xml');
      };
      await expect.poll(async () => (await word('tl')).includes('Kontekstong pangkasaysayan at pampulitika: STUB-TAGALOG'), { timeout: 15_000 }).toBe(true);
      expect(await word('tl')).toContain('Konteksto mula sa AI, hindi Kasulatan');
      const english = await word('en');
      expect(english).toContain('Historical and political context: STUB-HISTORY');
      expect(english).not.toContain('STUB-TAGALOG');
    });
  });

  test('a verse in many translations shows one per language, with the rest a click away', async ({ page }) => {
    await withEmptyVault(page, async () => {
      const rows = [HEADER, ...['AAA', 'BBB', 'CCC'].map((code) => [code, 'John', '3', '5', `Ang vocation ay ${code} para sa mga tao at sila ay natuwa`]), ['DDD', 'John', '3', '5', 'The vocation is for all of the people and they are glad']];
      await page.request.post('/api/verses/import', { multipart: { commit: '1', file: { name: 'made-up.xlsx', mimeType: 'application/octet-stream', buffer: xlsx(rows) } } });
      await ask(page);
      const shown = page.getByTestId('suggested-verse');
      await expect(shown).toHaveCount(2);
      await expect(page.getByTestId('suggested-status').first()).toHaveText('Unverified import');
      await page.getByTestId('suggestion-more').click();
      await expect(shown).toHaveCount(4);
      await expect(page.getByTestId('suggestion-more')).toHaveCount(0);
    });
  });
});
