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

const verses = async (page: Page): Promise<any[]> => (await page.request.get('/api/verses')).json();
const lessons = async (page: Page): Promise<any[]> => (await page.request.get('/api/lessons')).json();

test.describe('pastoral visits', () => {
  test('have their own upload, and their verses go to the Verse Library in each language', async ({ page }) => {
    await setAiMode('good');
    await withEmptyVault(page, async () => {
      const lesson = await page.request.post('/api/lessons', { multipart: { source_kind: 'text', pages: JSON.stringify(['Wednesday/Thursday: October 15/16, 2025\nPaksa: Ang Aralin\nTalata: Juan 15:16']), file: midweekLesson } });
      expect(lesson.ok()).toBe(true);
      await page.goto('/');
      await page.getByTestId('side-pv').click();
      await expect(page.getByTestId('empty-pastoral')).toBeVisible();
      await expect(page.getByTestId('viewer-empty'), 'a lesson from another list is not shown here').toBeVisible();

      await page.getByTestId('pastoral-upload').click();
      await page.getByTestId('upload-input').setInputFiles([visit]);
      await expect(page.getByTestId('upload-item')).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
      await expect(page.getByTestId('upload-attention'), 'a pastoral visit has no issue or objectives to miss').toHaveCount(0);
      await page.getByTestId('upload-done').click();

      const added = (await lessons(page)).find((l) => l.file_name === visit.name);
      expect(added).toMatchObject({ category: 'pastoral', title: 'Ang Halimbawa ng mga Bantay', lesson_date: '2021-01-10' });
      await expect(page.getByTestId('side-pv-count')).toHaveText('1');
      await expect(page.getByTestId('side-lessons-count')).toHaveText('1');
      await expect(page.getByTestId('lesson-row')).toHaveCount(1);
      await expect(page.getByTestId('lesson-row')).toContainText('Ang Halimbawa ng mga Bantay');

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
      await expect(page.getByTestId('side-bibles-count')).toHaveText('4');
      await page.getByTestId('side-bibles').click();
      await expect(page.getByTestId('bibles-title')).toHaveText('Verse Library');
      await expect(page.getByTestId('verse-card')).toHaveCount(4);
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
      await expect(page.getByTestId('item-count')).toHaveText('2 items');
      await expect(page.getByTestId('tab-count-pastoral')).toHaveText('1');
    });
  });
});
