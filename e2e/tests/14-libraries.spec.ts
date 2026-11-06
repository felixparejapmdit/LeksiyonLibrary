import type { Page } from '@playwright/test';
import { test, expect, setAiMode, withEmptyVault } from '../support/fixtures';
import { midweekLesson } from '../support/pdf';
import { xlsx } from '../support/xlsx';

// Everything here is made up, as all test data must be: this repository is public.
const HEADER = ['PET', 'Book', 'Chapter', 'Verse', 'Content'];

const verses = async (page: Page): Promise<any[]> => (await page.request.get('/api/verses')).json();
const lessons = async (page: Page): Promise<any[]> => (await page.request.get('/api/lessons')).json();

/** A lesson whose verses have their wording printed, uploaded the way the app does it. */
async function uploadLesson(page: Page) {
  const verses = [
    ['Juan 3:5', 'Ang mga bantay ay gising sa buong magdamag na walang tulog.'],
    ['Juan 3:6', 'Ang ilaw ng lampara ay hindi namamatay sa gabi.'],
  ];
  const lines = verses.flatMap(([reference, text]) => [`A. A point ..... ${reference} NIRV`, text, 'B Next point']);
  const pages = [`Wednesday/Thursday: October 15/16, 2025\nPaksa: Ang Halimbawa ng Pagbabantay\n${lines.join('\n')}`];
  const res = await page.request.post('/api/lessons', { multipart: { source_kind: 'text', pages: JSON.stringify(pages), file: midweekLesson } });
  expect(res.ok()).toBe(true);
  return (await res.json()).lesson;
}

async function importSheet(page: Page, rows: string[][]) {
  const res = await page.request.post('/api/verses/import', { multipart: { commit: '1', file: { name: 'made-up.xlsx', mimeType: 'application/octet-stream', buffer: xlsx([HEADER, ...rows]) } } });
  expect(res.ok()).toBe(true);
}

test.describe('checking an uploaded lesson', () => {
  test('what was read is compared with the PDF, corrected, and confirmed', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await page.goto('/');
      await page.getByTestId('header-upload').click();
      await page.getByTestId('upload-input').setInputFiles([midweekLesson]);
      await expect(page.getByTestId('upload-item')).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
      const [lesson] = await lessons(page);
      expect(lesson.needs_check, 'a new upload starts unchecked').toBe(true);

      // The check opens beside the PDF.
      await page.getByTestId('upload-check').click();
      await expect(page.getByTestId('upload-dialog')).toHaveCount(0);
      const dialog = page.getByTestId('edit-dialog');
      await expect(dialog).toHaveAccessibleName('Check what was read from this PDF');
      await expect(page.getByTestId('edit-body')).toHaveAttribute('data-mode', 'check');
      await expect(page.getByTestId('check-pdf').getByTestId('viewer-canvas')).toBeVisible();
      await expect(page.getByTestId('check-pdf').getByTestId('lesson-summary'), 'the form already shows it').toHaveCount(0);
      await expect(page.getByTestId('edit-title')).toHaveValue(lesson.title);
      const found = page.getByTestId('check-verse');
      const count = await found.count();
      expect(count).toBeGreaterThan(1);
      await expect(page.getByTestId('check-verses-title')).toHaveText(`Verses found (${count})`);

      // A misread verse is corrected here. Escape closes only the dialog on top.
      await found.first().getByTestId('check-verse-correct').click();
      await expect(page.getByTestId('correct-dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('correct-dialog')).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await found.first().getByTestId('check-verse-correct').click();
      await page.getByTestId('correct-text').fill('Words corrected while checking');
      await page.getByTestId('correct-save').click();
      await expect(found.first().getByTestId('check-verse-text')).toHaveText('Words corrected while checking');

      // Something that is not a verse of this lesson is taken out of it.
      const last = found.last();
      const removedRef = await last.getByTestId('check-verse-ref').textContent();
      await last.getByTestId('check-verse-remove').click();
      await expect(page.getByTestId('confirm-body')).toContainText('not a verse of this lesson');
      await page.getByTestId('confirm-accept').click();
      await expect(found).toHaveCount(count - 1);
      await expect(page.getByTestId('check-verses-title')).toHaveText(`Verses found (${count - 1})`);
      expect((await verses(page)).some((v) => v.ref_printed === removedRef), 'an unverified scan nothing uses is deleted').toBe(false);

      // Saved without confirming, it stays marked as not checked.
      await page.getByTestId('edit-title').fill('A checked lesson title');
      await page.getByTestId('edit-save').click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('lesson-edit')).toHaveAttribute('data-needs-check', 'true');
      await expect(page.getByTestId('lesson-not-checked')).toHaveText(' · Not checked yet');
      await expect(page.getByTestId('viewer-needs-check')).toBeVisible();
      await expect(page.getByTestId('side-to-check-count')).toHaveText('1');

      // The sidebar lists only the lessons still to check.
      await page.getByTestId('side-to-check').click();
      await expect(page.getByTestId('chip-to-check')).toBeVisible();
      await expect(page.getByTestId('item-count')).toHaveText('1 item');
      await page.getByTestId('chip-to-check-clear').click();
      await expect(page.getByTestId('chip-to-check')).toHaveCount(0);

      await page.getByTestId('lesson-edit').click();
      await expect(page.getByTestId('edit-body')).toHaveAttribute('data-mode', 'check');
      await page.getByTestId('edit-cancel').click();

      // Confirmed from the viewer's banner.
      await page.getByTestId('viewer-check').click();
      await expect(page.getByTestId('edit-title')).toHaveValue('A checked lesson title');
      await page.getByTestId('edit-confirm').click();
      await expect(page.getByTestId('toast').filter({ hasText: 'Lesson checked and confirmed' })).toBeVisible();
      await expect(page.getByTestId('lesson-not-checked')).toHaveCount(0);
      await expect(page.getByTestId('lesson-edit')).toHaveAttribute('data-needs-check', 'false');
      await expect(page.getByTestId('viewer-needs-check')).toHaveCount(0);
      await expect(page.getByTestId('side-to-check')).toHaveCount(0);
      expect((await lessons(page))[0]).toMatchObject({ needs_check: false, title: 'A checked lesson title' });

      // From then on it opens as a plain edit.
      await page.getByTestId('lesson-edit').click();
      await expect(page.getByTestId('edit-body')).toHaveAttribute('data-mode', 'edit');
      await expect(page.getByTestId('edit-confirm')).toHaveCount(0);
      await expect(dialog).toHaveAccessibleName('Edit lesson details');
      await page.getByTestId('edit-cancel').click();
      await page.getByTestId('header-upload').click();
      await expect(page.getByTestId('upload-checked')).toHaveText('Checked');
      await page.getByTestId('upload-done').click();
    });
  });

  test('being checked can be set either way, and removing a verse that is not there is refused', async ({ page }) => {
    const before = await lessons(page);
    expect(before.length).toBeGreaterThan(0);
    const res = await page.request.patch(`/api/lessons/${before[0].id}`, { data: { checked: false } });
    expect((await res.json()).needs_check).toBe(true);
    expect((await (await page.request.patch(`/api/lessons/${before[0].id}`, { data: { checked: true } })).json()).needs_check).toBe(false);
    expect((await page.request.delete(`/api/lessons/${before[0].id}/verses/nope`)).status()).toBe(404);
  });
});

test.describe('the Verse Library and the Lesson Library', () => {
  test('keep their verses apart, and Review Verses takes each on its own', async ({ page }) => {
    await withEmptyVault(page, async () => {
      const lesson = await uploadLesson(page);
      await importSheet(page, [
        ['MSG', 'Colossians', '3', '12', '12Ang mga tao ay nakinig sa kaniya at hindi sila natakot'],
        ['ETRB', 'Colossians', '3', '12', '12So we continue to tell all of the people about the one who made them.'],
      ]);
      const all = await verses(page);
      const fromLesson = all.filter((v) => v.sources.length > 0);
      expect(fromLesson.length).toBeGreaterThan(0);
      expect(all.filter((v) => v.import_source)).toHaveLength(2);

      await page.goto('/');
      await expect(page.getByTestId('side-bibles-count')).toHaveText('2');
      await expect(page.getByTestId('side-lesson-verses-count')).toHaveText(String(fromLesson.length));
      await expect(page.getByTestId('side-review-count')).toHaveText(String(2 + fromLesson.length));
      await expect(page.getByTestId('side-review-count')).toHaveAttribute('title', new RegExp(`2 in the Verse Library, ${fromLesson.length} in the Lesson Library$`));

      await page.getByTestId('side-bibles').click();
      await expect(page.getByTestId('bibles-title')).toHaveText('Verse Library');
      await expect(page.getByTestId('verse-card')).toHaveCount(2);
      await expect(page.getByTestId('verse-import-source')).toHaveCount(2);
      await expect(page.getByTestId('verse-source'), 'no lesson verse here').toHaveCount(0);

      await page.getByTestId('side-lesson-verses').click();
      await expect(page.getByTestId('bibles-title')).toHaveText('Verses from lessons');
      await expect(page.getByTestId('verse-card')).toHaveCount(fromLesson.length);
      await expect(page.getByTestId('verse-import-source'), 'no imported verse here').toHaveCount(0);
      await expect(page.getByTestId('bibles-import'), 'importing is only for the Verse Library').toHaveCount(0);

      // Review starts on the library it was opened from.
      await page.getByTestId('bibles-review').click();
      await expect(page.getByTestId('review-library-lesson')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('review-count-lesson')).toHaveText(String(fromLesson.length));
      await expect(page.getByTestId('review-count-verse')).toHaveText('2');
      await expect(page.getByTestId('review-progress')).toHaveText(`1 of ${fromLesson.length} to review`);
      await expect(page.getByTestId('pdf-viewer')).toBeVisible();

      await page.getByTestId('review-library-verse').click();
      await expect(page.getByTestId('review-library-verse')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('review-progress')).toHaveText('1 of 2 to review');
      await expect(page.getByTestId('review-no-source')).toContainText('Imported from made-up.xlsx');

      // Once one library is done, it says how many the other still has.
      for (const v of all.filter((x) => x.import_source)) await page.request.post(`/api/verses/${v.id}/verify`);
      await page.reload();
      await expect(page.getByTestId('review-library-lesson'), 'opens on the library with verses left').toHaveAttribute('aria-selected', 'true');
      await page.getByTestId('review-library-verse').click();
      await expect(page.getByTestId('review-done')).toHaveText('Every verse in the Verse Library is verified');
      await expect(page.getByTestId('review-other')).toHaveText(`${fromLesson.length} still to review in the Lesson Library.`);
      await page.getByTestId('review-library-lesson').click();
      await expect(page.getByTestId('review-progress')).toHaveText(`1 of ${fromLesson.length} to review`);
      await page.getByTestId('review-library-verse').click();
      await page.getByTestId('review-back').click();
      await expect(page.getByTestId('bibles-title')).toHaveText('Verse Library');

      // Deleting the lesson leaves the imported verses alone.
      await page.request.delete(`/api/lessons/${lesson.id}`);
      expect((await verses(page)).filter((v) => v.import_source)).toHaveLength(2);
    });
  });

  test('the Lesson Assistant labels every verse with the library it came from', async ({ page }) => {
    await setAiMode('good');
    await withEmptyVault(page, async () => {
      await uploadLesson(page);
      const lessonVerse = (await verses(page)).find((v) => v.sources.length > 0 && v.text.split(/\s+/).length >= 4);
      expect(lessonVerse, 'a lesson verse with words to match').toBeTruthy();
      const words = lessonVerse.text.split(/\s+/).filter((w: string) => w.length > 4).slice(0, 2).join(' ');
      // A sheet verse with the same words, under another reference.
      await importSheet(page, [['MSG', 'Colossians', '3', '12', `12Ang mga ito ay ${words} na isinulat sa sheet`]]);

      await page.goto('/lecture');
      await expect(page.getByTestId('lecture-intro')).toContainText('both your Verse Library and your Lesson Library');
      await expect(page.getByTestId('lecture-from-lesson')).toHaveCount(0);
      await page.getByTestId('lecture-issue').fill(words);
      await page.getByTestId('lecture-suggest').click();
      const fromSheet = page.getByTestId('suggested-verse').filter({ has: page.getByTestId('origin-verse-library') });
      const fromLesson = page.getByTestId('suggested-verse').filter({ has: page.getByTestId('origin-lesson-library') });
      await expect(fromSheet).toHaveCount(1);
      await expect(fromSheet.getByTestId('origin-verse-library')).toHaveText('Verse Library · made-up.xlsx, row 2');
      await expect(fromLesson.first().getByTestId('origin-lesson-library')).toContainText(/^Lesson Library · Ang Halimbawa ng Pagbabantay.*, p\.\d+$/);

      // The label stays with a verse added to the lecture.
      await page.getByTestId('suggestion').filter({ has: fromSheet }).getByTestId('suggestion-add').first().click();
      await expect(page.getByTestId('workspace-verse').getByTestId('origin-verse-library')).toBeVisible();
    });
  });
});
