import type { Page } from '@playwright/test';
import { test, expect, fillObjectives, setAiMode, withEmptyVault } from '../support/fixtures';
import { makePdf, midweekLesson } from '../support/pdf';

// A made-up pastoral visit laid out like the real ones, as all test data must be: this
// repository is public. One verse is printed in English and then in Tagalog. The file name
// does not mark it as a pastoral visit: where it is uploaded does.
const visit = {
  name: '20210110_Sample Verses.pdf',
  mimeType: 'application/pdf',
  buffer: makePdf([
    [
      'ANG HALIMBAWA NG MGA BANTAY',
      'PASIMULA:',
      'ANO ANG DAPAT GAWIN NG MGA BANTAY?',
      '1. Ang dapat gawin ..........II Tim. 3:1-5 TPTB',
      'But you need to be aware that the watchmen will be awake and they will not sleep.',
      'They will be faithful to the people of God with all of their strength.',
      'Subalit kailangan ninyong malaman na ang mga bantay ay gising at hindi sila natutulog.',
      'Sila ay tapat sa mga tao ng Diyos sa kanilang buong lakas.',
      '2. Ang aral ..........Filip. 2:12a at 13 AMP',
      'Ang mga bantay ay hindi natutulog sa gabi at sila ay laging handa sa pintuan.',
      'I. ANO ANG TUNGKULIN NG BANTAY?',
      '1. Ang tungkulin ..........Gawa 20:28 Lamsa',
      'Ingatan ninyo ang inyong sarili at ang mga bantay sa pintuan ng bayan.',
      'LINGGO: ENERO 10, 2021 BY:',
    ],
  ]),
};

// A second visit, whose scan garbled one book name: that verse is reported, not guessed.
const second = {
  name: '20210117_Sample Workers.pdf',
  mimeType: 'application/pdf',
  buffer: makePdf([
    [
      'ANG MGA MANGGAGAWA SA BUKID',
      'PASIMULA:',
      '1. Ang manggagawa ..........Marcos 4:2 NIRV',
      'Ang manggagawa ay masipag sa bukid at hindi siya umaalis.',
      '2. Ang aral wnmsoee oom]) Xyq: 4:9 ABC',
      'Ang tagapag-ingat ay hindi natutulog sa gabi.',
      'LINGGO: ENERO 17, 2021 BY:',
    ],
  ]),
};
const notPdf = { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a visit') };

/** Drags files over the Pastoral Visits list and drops them, as from a file manager. */
async function drop(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  const data = await page.evaluateHandle(
    (list) => {
      const dt = new DataTransfer();
      for (const f of list) dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
      return dt;
    },
    files.map((f) => ({ name: f.name, type: f.mimeType, bytes: [...f.buffer] })),
  );
  const pane = page.getByTestId('list-pane');
  await pane.dispatchEvent('dragover', { dataTransfer: data });
  await expect(page.getByTestId('pv-drop')).toHaveAttribute('data-dragging', 'true');
  await pane.dispatchEvent('drop', { dataTransfer: data });
  await expect(page.getByTestId('pv-drop')).not.toHaveAttribute('data-dragging');
}

const verses = async (page: Page): Promise<any[]> => (await page.request.get('/api/verses')).json();
const lessons = async (page: Page): Promise<any[]> => (await page.request.get('/api/lessons')).json();

test.describe('pastoral visits', () => {
  test('are dropped on their page several at once, and their verses go to the Verse Library in each language', async ({ page }) => {
    await setAiMode('good');
    await withEmptyVault(page, async () => {
      const lesson = await page.request.post('/api/lessons', { multipart: { source_kind: 'text', pages: JSON.stringify(['Wednesday/Thursday: October 15/16, 2025\nPaksa: Ang Aralin\nTalata: Juan 15:16']), file: midweekLesson } });
      expect(lesson.ok()).toBe(true);
      await page.goto('/');
      await page.getByTestId('side-pv').click();
      await expect(page.getByTestId('empty-pastoral')).toBeVisible();
      await expect(page.getByTestId('viewer-empty'), 'a lesson from another list is not shown here').toBeVisible();

      // Several PDFs dropped on the page at once; anything that is not a PDF is skipped.
      await drop(page, [visit, second, notPdf]);
      await expect(page.getByTestId('toast').filter({ hasText: 'Adding 2 PDF files, skipping 1 other file' })).toBeVisible();
      await expect(page.getByTestId('pv-drop-progress')).toContainText(/Reading \d of 2/);
      await expect(page.getByTestId('pv-drop-summary')).toHaveText('2 visits added, with 5 verses, 1 to check.', { timeout: 20_000 });
      await expect(page.getByTestId('upload-dialog'), 'the page shows the progress itself').toHaveCount(0);

      // The details say which reference could not be read.
      await page.getByTestId('pv-drop-details').click();
      await expect(page.getByTestId('upload-item')).toHaveCount(2);
      const attention = page.getByTestId('upload-attention');
      await expect(attention, 'a pastoral visit has no issue or objectives to miss').toHaveCount(1);
      await expect(attention).toHaveText('A reference on page 1 could not be read, so its verse was not added: "Xyq: 4:9 ABC". Add it by hand.');
      await page.getByTestId('upload-done').click();
      await page.getByTestId('pv-drop-clear').click();
      await expect(page.getByTestId('pv-drop-status')).toHaveCount(0);

      // Choosing files, or a folder, works as well as dropping them.
      const chooser = page.waitForEvent('filechooser');
      await page.getByTestId('pv-drop-browse').click();
      expect((await chooser).isMultiple()).toBe(true);
      const folder = page.waitForEvent('filechooser');
      await page.getByTestId('pv-drop-folder').click();
      await folder;

      const added = (await lessons(page)).find((l) => l.file_name === visit.name);
      expect(added).toMatchObject({ category: 'pastoral', title: 'Ang Halimbawa ng mga Bantay', lesson_date: '2021-01-10' });
      const workers = (await lessons(page)).find((l) => l.file_name === second.name);
      expect(workers).toMatchObject({ category: 'pastoral', lesson_date: '2021-01-17' });
      const workersVerses = (await verses(page)).filter((v) => v.sources.some((s: any) => s.lesson_id === workers.id));
      expect(workersVerses.map((v) => v.canonical_key), 'the unread verse is not added to the one before it').toEqual(['41.4:2']);
      expect(workersVerses[0].text).toBe('Ang manggagawa ay masipag sa bukid at hindi siya umaalis.');
      await expect(page.getByTestId('side-pv-count')).toHaveText('2');
      await expect(page.getByTestId('side-lessons-count')).toHaveText('1');
      await expect(page.getByTestId('lesson-row')).toHaveCount(2);
      await expect(page.getByTestId('lesson-row').filter({ hasText: 'Ang Halimbawa ng mga Bantay' })).toHaveCount(1);

      // Each verse in its own language, the English and its Tagalog translation kept apart.
      const read = (await verses(page)).filter((v) => v.sources.some((s: any) => s.lesson_id === added.id));
      expect(read.map((v) => [v.canonical_key, v.language, v.version]).sort()).toEqual([
        ['44.20:28', 'tl', 'LAMSA'],
        ['50.2:12a,13', 'tl', 'AMP'],
        ['55.3:1-5', 'en', 'TPTB'],
        ['55.3:1-5', 'tl', 'TPTB'],
      ]);
      const english = read.find((v) => v.language === 'en');
      expect(english.text).toBe('But you need to be aware that the watchmen will be awake and they will not sleep. They will be faithful to the people of God with all of their strength.');
      expect(read.find((v) => v.canonical_key === '55.3:1-5' && v.language === 'tl').text).toMatch(/^Subalit .* buong lakas\.$/);
      expect(read.every((v) => v.sources.every((s: any) => s.pastoral))).toBe(true);

      // They are in the Verse Library, not with the verses from lessons.
      await expect(page.getByTestId('side-bibles-count')).toHaveText('5');
      await page.getByTestId('side-bibles').click();
      await expect(page.getByTestId('bibles-title')).toHaveText('Verse Library');
      await expect(page.getByTestId('verse-card')).toHaveCount(5);
      await page.getByTestId('side-lesson-verses').click();
      await expect(page.getByTestId('verse-card')).toHaveCount(1);

      // The Lesson Assistant says which pastoral visit a verse came from.
      await page.getByTestId('side-lecture').click();
      await fillObjectives(page, 'Ang tungkulin ng bantay');
      await page.getByTestId('lecture-suggest').click();
      const found = page.getByTestId('suggestion').filter({ has: page.getByTestId('origin-pastoral') }).first();
      await expect(found.getByTestId('origin-pastoral').first()).toHaveText(/^Verse Library · Pastoral visit: Ang Halimbawa ng mga Bantay, p\.1$/);
      await expect(found.getByTestId('from-lesson-kind').first()).toHaveText('Pastoral visit');
      await expect(found.getByTestId('from-lesson-file').first()).toHaveText(visit.name);

      // All Archives shows both kinds of lesson.
      await page.getByTestId('side-all').click();
      await expect(page.getByTestId('item-count')).toHaveText('3 items');
      await expect(page.getByTestId('tab-count-pastoral')).toHaveText('2');
    });
  });
});
