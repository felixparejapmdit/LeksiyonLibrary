import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import type { Page } from '@playwright/test';
import { test, expect, setAiMode, STUB, withEmptyVault, TEST_PASSPHRASE } from '../support/fixtures';
import { makePdf } from '../support/pdf';

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

function xlsx(rows: string[][]) {
  const zip = new AdmZip();
  const add = (name: string, body: string) => zip.addFile(name, Buffer.from(body));
  add('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>');
  add('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  add('xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Verses" sheetId="1" r:id="rId1"/></sheets></workbook>');
  add('xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  const data = rows
    .map((cells, r) => `<row r="${r + 1}">${cells.map((cell, c) => {
      const at = `${String.fromCharCode(65 + c)}${r + 1}`;
      return /^\d+$/.test(cell) ? `<c r="${at}"><v>${cell}</v></c>` : `<c r="${at}" t="inlineStr"><is><t>${cell}</t></is></c>`;
    }).join('')}</row>`)
    .join('');
  add('xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data}</sheetData></worksheet>`);
  return zip.toBuffer();
}

const csv = (rows: string[][]) => rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
const setSheet = (sheet: { body?: string; status?: number; type?: string }) => fetch(`${STUB}/__sheet`, { method: 'POST', body: JSON.stringify(sheet) });

async function chooseFile(page: Page, name: string, buffer: Buffer) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('import-choose').click();
  await (await chooser).setFiles({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
}

const verses = async (page: Page): Promise<any[]> => (await page.request.get('/api/verses')).json();
const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp-data');
const everyFile = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? everyFile(join(dir, e.name)) : [join(dir, e.name)]));

test.describe('importing verses', () => {
  test('an Excel file is previewed, then imported with its slips corrected and reported', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await page.goto('/settings');
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
      await expect(page.getByTestId('import-flagged')).toContainText('Row 8:');
      expect(await verses(page), 'a preview saves nothing').toEqual([]);

      await page.getByTestId('import-cancel').click();
      await expect(page.getByTestId('import-preview')).toHaveCount(0);
      expect(await verses(page)).toEqual([]);

      await chooseFile(page, 'made-up.xlsx', xlsx(ROWS));
      await page.getByTestId('import-confirm').click();
      await expect(page.getByTestId('import-count')).toHaveText('6 imported verses in your vault.');
      await expect(page.getByTestId('settings-stats')).toContainText('6 verse records');

      const saved = await verses(page);
      const byRow = (n: number) => saved.find((v) => v.import_source === `made-up.xlsx, row ${n}`);
      expect(byRow(2)).toMatchObject({ canonical_key: '51.3:12', ref_en: 'Colossians 3:12', ref_tl: 'Colosas 3:12', version: 'MSG', language: 'tl', status: 'unverified', text: tl(), ocr_raw: `12${tl()}` });
      expect(byRow(4)).toMatchObject({ canonical_key: '51.3:12', version: 'ETRB', language: 'en', text: en });
      expect(byRow(6)).toMatchObject({ ref_en: 'Matthew 5:1', version: 'AMP2015' });
      expect(byRow(7)).toMatchObject({ version: 'AMP2015', text: tl('dalawa'), ocr_raw: `‪2${tl('dalawa')}` });
      expect(byRow(8).text, 'a number that does not match stays visible').toBe(`9${tl('mali')}`);
      expect(byRow(8).ref_note).toContain('number 9');

      // Importing the same file again adds nothing.
      await chooseFile(page, 'made-up.xlsx', xlsx(ROWS));
      await expect(page.getByTestId('import-summary')).toHaveText('0 new verses ready to import from made-up.xlsx');
      await expect(page.getByTestId('import-confirm')).toBeDisabled();
      await expect(page.getByTestId('import-counts')).toContainText('6 already in your vault');
      await page.getByTestId('import-cancel').click();
    });
  });

  test('the Bibles Library filters by translation and says where a verse came from', async ({ page }) => {
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
      await expect(page.getByTestId('side-bibles-count'), 'they still count towards the library').toHaveText('4');
    });
  });

  test('a file that is not right is refused with a clear reason', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await page.goto('/settings');
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
        expect(readFileSync(file).includes(MARKER), `${file} must not hold readable verse text`).toBe(false);
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

      await page.goto('/settings');
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
    await expect(page.getByTestId('bibles-range')).toHaveText('1–25 of 121 references, 124 records');
  };

  test('verses are paged, and only one page is ever on screen', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await load(page);
      const groups = page.getByTestId('verse-group');
      await expect(groups).toHaveCount(25);
      await expect(page.getByTestId('bibles-page-prev')).toBeDisabled();
      const firstKey = await groups.first().getAttribute('data-key');

      await page.getByTestId('bibles-page-next').click();
      await expect(page.getByTestId('bibles-range')).toHaveText('26–50 of 121 references, 124 records');
      expect(await groups.first().getAttribute('data-key')).not.toBe(firstKey);
      await page.getByTestId('bibles-page-prev').click();
      await expect(groups.first()).toHaveAttribute('data-key', firstKey!);

      await page.getByRole('button', { name: 'Page 5', exact: true }).click();
      await expect(page.getByTestId('bibles-range')).toHaveText('101–121 of 121 references, 124 records');
      await expect(page.getByTestId('bibles-page-next')).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Page 5', exact: true })).toHaveAttribute('aria-current', 'page');

      await page.getByTestId('bibles-page-size').selectOption('100');
      await expect(page.getByTestId('bibles-range')).toHaveText('1–100 of 121 references, 124 records');
      await expect(groups).toHaveCount(100);
      await page.getByTestId('bibles-page-size').selectOption('25');
    });
  });

  test('filters start again from page one, and clearing them brings everything back', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await load(page);
      await page.getByTestId('bibles-page-next').click();
      await page.getByTestId('bibles-book').selectOption({ label: 'John' });
      await expect(page.getByTestId('bibles-range')).toHaveText('1–1 of 1 reference, 4 records');
      await expect(page.getByTestId('bibles-pagination')).toHaveCount(0);

      await page.getByTestId('bibles-clear').click();
      await expect(page.getByTestId('bibles-range')).toHaveText('1–25 of 121 references, 124 records');
      await expect(page.getByTestId('bibles-clear')).toHaveCount(0);

      await page.getByTestId('bibles-search').fill('blg7x3');
      await expect(page.getByTestId('bibles-range')).toHaveText('1–1 of 1 reference, 1 record');
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
      await expect(group.getByTestId('verse-group-count')).toContainText('4 records');
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
      await expect(page.getByTestId('bibles-range')).toHaveText('26–50 of 121 references, 124 records');
      await page.getByTestId('side-lecture').click();
      await expect(page.getByTestId('lecture-page')).toBeVisible();
      await page.getByTestId('side-bibles').click();
      await expect(page.getByTestId('bibles-range')).toHaveText('26–50 of 121 references, 124 records');
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
      await page.goto('/settings');
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
      await page.goto('/settings');
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
