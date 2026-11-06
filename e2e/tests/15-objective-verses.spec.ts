import type { Page } from '@playwright/test';
import { test, expect, row, setAiMode, withEmptyVault, fillObjectives } from '../support/fixtures';
import { makePdf } from '../support/pdf';
import { xlsx } from '../support/xlsx';

// Made-up lessons laid out like the real ones, as all test data must be: this repository is public.
// Objective 1 is taught in the beginning (Pasimula), objective 2 in I., 3 in II. and 4 in III.
const WATCH = [
  'Paksa: Ang Tapat na Bantay', 'Isyu', 'Marami ang nakakalimot magbantay.',
  'Mga Layunin', '1. Maunawaan ang tawag sa pagbabantay.', '2. Makilala ang mga bantay na tapat.', '3. Malaman ang tungkulin ng bantay sa pintuan.', '4. Maitaguyod ang pagbabantay sa gabi.',
  'PANIMULA', 'Pambungad.',
  'PASIMULA:', 'T. Ano ang tawag sa mga bantay?', 'S. Sila ay tinawag ..... Juan 3:5 NIRV', 'Ang mga tagapag-ingat ay gising.',
  'I. SINO ANG MGA BANTAY NA TAPAT', 'T. Sino ang tapat?', 'S. Ang tapat ..... Juan 3:6 NIRV', 'Ang ilaw ay hindi namamatay.',
  'II. ANO ANG TUNGKULIN NG BANTAY', 'T. Saan sila nakatayo?', 'S. Sa pintuan ..... Juan 3:7 NIRV', 'Ang tagapag-ingat ay sumisigaw sa pintuan.',
  'III. PAPAANO MAITATAGUYOD ANG PAGBABANTAY', 'T. Kailan tayo magbabantay?', 'S. Sa gabi ..... Juan 3:8 NIRV', 'Ang tagapag-ingat ay hindi natutulog.',
  'KONKLUSYON', 'Wakas.',
];
const HARVEST = [
  'Paksa: Ang Panahon ng Ani', 'Isyu', 'Ang ani ay napapabayaan.',
  'Mga Layunin', '1. Maunawaan ang panahon ng ani.', '2. Makilala ang mga manggagawa sa bukid.', '3. Malaman kung sino ang mga bantay na tapat sa bukid.',
  'PANIMULA', 'Pambungad.',
  'PASIMULA:', 'S. Ang ani ..... Marcos 4:1 NIRV', 'Ang ani ay malapit na.',
  'I. SINO ANG MGA MANGGAGAWA', 'S. Ang manggagawa ..... Marcos 4:2 NIRV', 'Ang manggagawa ay masipag.',
  'II. SINO ANG BANTAY NA TAPAT SA BUKID', 'T. Sino ang tapat na bantay ng bukid?', 'S. Ang tapat ..... Marcos 4:3 NIRV', 'Ang tagabukid ay gising.',
  'KONKLUSYON', 'Wakas.',
];

async function upload(page: Page, name: string, lines: string[]) {
  const file = { name, mimeType: 'application/pdf', buffer: makePdf([lines]) };
  const res = await page.request.post('/api/lessons', { multipart: { source_kind: 'text', pages: JSON.stringify([lines.join('\n')]), file } });
  expect(res.ok()).toBe(true);
  return (await res.json()).lesson;
}

const suggest = async (page: Page, objective: string, count?: number, exclude: string[] = []) =>
  (await (await page.request.post('/api/ai/suggest', { data: { issue: '', objective, count, exclude } })).json()).suggestions as any[];

test.describe('verses suggested for each objective', () => {
  test('come from the part of each lesson that teaches it, and more can be asked for', async ({ page }) => {
    await setAiMode('good');
    await withEmptyVault(page, async () => {
      await upload(page, '2025_Wk01a.pdf', WATCH);
      await upload(page, '2025_Wk02a.pdf', HARVEST);
      const sheet = await page.request.post('/api/verses/import', {
        multipart: { commit: '1', file: { name: 'made-up.xlsx', mimeType: 'application/octet-stream', buffer: xlsx([['PET', 'Book', 'Chapter', 'Verse', 'Content'], ['MSG', 'Colossians', '3', '12', '12Ang bantay na tapat ay hindi umaalis sa kaniyang lugar']]) } },
      });
      expect(sheet.ok()).toBe(true);

      // Through the API: the part's verses, from both lessons, each saying where it was found.
      const found = await suggest(page, 'Makilala ang mga bantay na tapat', 5);
      const keys = found.map((s) => s.canonical_key);
      expect(keys).toEqual(expect.arrayContaining(['43.3:6', '41.4:3']));
      for (const other of ['43.3:5', '43.3:7', '43.3:8', '41.4:1', '41.4:2']) expect(keys, `${other} is in another part`).not.toContain(other);
      expect(found.find((s) => s.canonical_key === '43.3:6').from_lessons).toEqual([
        { lesson_id: expect.any(String), title: 'Ang Tapat na Bantay', file_name: '2025_Wk01a.pdf', section: 2, objective: 'Makilala ang mga bantay na tapat.', question: 'Sino ang tapat?', pastoral: false },
      ]);
      expect(found.find((s) => s.canonical_key === '41.4:3').from_lessons[0]).toMatchObject({ file_name: '2025_Wk02a.pdf', section: 3 });
      const sheetVerse = found.find((s) => s.canonical_key === '51.3:12');
      expect(sheetVerse, 'the Verse Library is searched too').toBeTruthy();
      expect(sheetVerse.from_lessons).toEqual([]);
      const more = await suggest(page, 'Makilala ang mga bantay na tapat', 5, keys);
      expect(more.filter((s) => keys.includes(s.canonical_key)), 'nothing already shown comes back').toEqual([]);

      await page.goto('/lecture');
      await fillObjectives(page, 'Makilala ang mga bantay na tapat\nMaitaguyod ang pagbabantay sa gabi');
      await page.getByTestId('lecture-suggest').click();
      const [first, second] = [page.getByTestId('objective-group').nth(0), page.getByTestId('objective-group').nth(1)];
      await expect(first.getByTestId('objective-title')).toHaveText('Makilala ang mga bantay na tapat');
      await expect(first.getByTestId('suggestion')).toHaveCount(3);
      const fromWatch = first.locator('[data-testid="suggestion"][data-key="43.3:6"]');
      await expect(fromWatch.getByTestId('from-lesson-title')).toHaveText('Ang Tapat na Bantay');
      await expect(fromWatch.getByTestId('from-lesson-file')).toHaveText('2025_Wk01a.pdf');
      await expect(fromWatch.getByTestId('from-lesson-part')).toHaveText('Objective 2 · I.');
      await expect(fromWatch.getByTestId('from-lesson-objective')).toHaveText("The lesson's objective: Makilala ang mga bantay na tapat.");
      await expect(fromWatch.getByTestId('from-lesson-question')).toHaveText('Under the question: Sino ang tapat?');
      const fromFourth = second.locator('[data-testid="suggestion"][data-key="43.3:8"]');
      await expect(fromFourth.getByTestId('from-lesson-part')).toHaveText('Objective 4 · III.');
      await expect(second.locator('[data-testid="suggestion"][data-key="43.3:7"]'), 'part II teaches another objective').toHaveCount(0);

      // More for one objective, until nothing else matches. The other objective is left alone.
      const secondCount = await second.getByTestId('suggestion').count();
      await expect(first.getByTestId('objective-more')).toHaveText('Suggest more for this objective');
      for (let i = 0; i < 10 && (await first.getByTestId('objective-no-more').count()) === 0; i++) {
        const before = await first.getByTestId('suggestion').count();
        await first.getByTestId('objective-more').click();
        await expect(first.getByTestId('objective-more')).toBeEnabled({ timeout: 10_000 }).catch(() => {});
        await expect.poll(async () => (await first.getByTestId('suggestion').count()) > before || (await first.getByTestId('objective-no-more').count()) > 0).toBe(true);
      }
      await expect(first.getByTestId('objective-no-more')).toBeVisible();
      await expect(first.getByTestId('objective-more')).toBeDisabled();
      const shown = await first.getByTestId('suggestion').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')));
      expect(new Set(shown).size, 'no verse is shown twice').toBe(shown.length);
      expect(shown).toEqual(expect.arrayContaining(['43.3:6', '41.4:3', '51.3:12']));
      await expect(first.locator('[data-testid="suggestion"][data-key="51.3:12"]').getByTestId('origin-verse-library')).toBeVisible();
      await expect(first.locator('[data-testid="suggestion"][data-key="51.3:12"]').getByTestId('suggestion-lessons')).toHaveCount(0);
      await expect(second.getByTestId('suggestion')).toHaveCount(secondCount);

      // An issue on its own draws on the whole lesson that matches it.
      await fillObjectives(page, '');
      await page.getByTestId('lecture-issue').fill('nakakalimot magbantay');
      await page.getByTestId('lecture-suggest').click();
      const topic = page.getByTestId('objective-group');
      await expect(topic).toHaveCount(1);
      await expect(topic.getByTestId('suggestion')).toHaveCount(4);
      const parts = await topic.getByTestId('from-lesson-part').allTextContents();
      expect(new Set(parts).size, `verses from across the lesson: ${parts}`).toBe(4);
      await expect(topic.getByTestId('from-lesson-file').first()).toHaveText('2025_Wk01a.pdf');
      await expect(topic.getByTestId('objective-more')).toHaveText('Suggest more');

      // Checking a lesson shows the part each verse was read under.
      await page.goto('/');
      await row(page, 'Ang Tapat na Bantay').getByTestId('lesson-edit').click();
      const partsRead = await page.getByTestId('check-verse-part').allTextContents();
      expect(partsRead.length).toBeGreaterThan(0);
      expect(partsRead.every((p) => /^(Objective \d · (Pasimula|I+\.)|Konklusyon)/.test(p)), partsRead.join(' | ')).toBe(true);
      await page.getByTestId('edit-cancel').click();
    });
  });
});
