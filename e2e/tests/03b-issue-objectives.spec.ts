import { test, expect, row, setAiMode, withEmptyVault } from '../support/fixtures';
import { samples } from '../support/samples';
import { makePdf } from '../support/pdf';

test.describe.configure({ mode: 'serial' });

test('the issue and objectives are read from the scanned PDFs, in each language', async ({ app: page }) => {
  await row(page, samples.en.row).getByTestId('lesson-open').click();
  await page.getByTestId('lesson-summary-toggle').click();
  await expect(page.getByTestId('lesson-summary-toggle')).toHaveText('Issue and Objectives');
  await expect(page.getByTestId('lesson-issue')).toContainText(samples.en.issueStart);
  await expect(page.getByTestId('lesson-objective')).toHaveCount(4);
  await expect(page.getByTestId('lesson-objective').first()).toContainText(samples.en.objectiveStart);

  await row(page, samples.tl.row).getByTestId('lesson-open').click();
  await expect(page.getByTestId('lesson-summary-toggle')).toHaveText('Isyu at Mga Layunin');
  await expect(page.getByTestId('lesson-summary-body').getByRole('heading', { name: 'Mga Layunin' })).toBeVisible();
  await expect(page.getByTestId('lesson-issue')).toContainText(samples.tl.issueStart);
  await expect(page.getByTestId('lesson-objective')).toHaveCount(4);

  // The panel stays open across a reload once opened.
  await page.reload();
  await expect(page.getByTestId('lesson-summary')).toHaveAttribute('open', '');
});

test('the issue and objectives can be edited, stay edited, and are searchable', async ({ app: page }) => {
  const lessons: any[] = await (await page.request.get('/api/lessons')).json();
  const lesson = lessons.find((l) => l.title.startsWith(samples.en.short));
  const versesBefore = await (await page.request.get('/api/verses')).json();

  await row(page, samples.en.row).getByTestId('lesson-open').click();
  await page.getByTestId('lesson-summary-toggle').click();
  await page.getByTestId('lesson-summary-edit').click();
  await expect(page.getByTestId('edit-issue')).toHaveValue(lesson.issue);
  await expect(page.getByTestId('edit-objectives')).toHaveValue(lesson.objectives.join('\n'));

  await page.getByTestId('edit-issue').fill('Corrected zephyrquark issue');
  await page.getByTestId('edit-objectives').fill('First corrected objective\n\n   \nSecond xylonite objective');
  await page.getByTestId('edit-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Lesson updated' })).toBeVisible();
  await expect(page.getByTestId('lesson-issue')).toHaveText('Corrected zephyrquark issue');
  await expect(page.getByTestId('lesson-objective')).toHaveText(['First corrected objective', 'Second xylonite objective']);

  await page.reload();
  await row(page, samples.en.row).getByTestId('lesson-open').click();
  await page.getByTestId('lesson-summary-toggle').click();
  await expect(page.getByTestId('lesson-issue')).toHaveText('Corrected zephyrquark issue');

  for (const word of ['zephyrquark', 'xylonite']) {
    const found = await (await page.request.get(`/api/search?q=${word}`)).json();
    expect(found.lesson_ids, word).toEqual([lesson.id]);
  }
  expect(await (await page.request.get('/api/verses')).json(), 'editing a lesson must not touch verses').toEqual(versesBefore);

  const restored = await page.request.patch(`/api/lessons/${lesson.id}`, { data: { issue: lesson.issue, objectives: lesson.objectives } });
  expect(restored.ok()).toBeTruthy();
  expect((await (await page.request.get('/api/search?q=zephyrquark')).json()).lesson_ids).toEqual([]);
});

test('a lesson with no issue or objectives says so and can have them added', async ({ page }) => {
  await withEmptyVault(page, async () => {
    const res = await page.request.post('/api/lessons', {
      multipart: { source_kind: 'text', pages: JSON.stringify(['Paksa: Plain Lesson']), file: { name: 'plain.pdf', mimeType: 'application/pdf', buffer: makePdf([['Plain lesson']]) } },
    });
    expect(res.ok()).toBeTruthy();
    await page.goto('/');
    await page.getByTestId('lesson-summary-toggle').click();
    await expect(page.getByTestId('lesson-summary-empty')).toBeVisible();
    await page.getByTestId('lesson-summary-edit').click();
    await page.getByTestId('edit-objectives').fill('A newly added objective');
    await page.getByTestId('edit-save').click();
    await expect(page.getByTestId('lesson-objective')).toHaveText(['A newly added objective']);
    await expect(page.getByTestId('lesson-summary-empty')).toHaveCount(0);
  });
});

test("the Lesson Assistant takes a lesson's objectives typed in, and says which library each verse is from", async ({ app: page }) => {
  await setAiMode('good');
  const lessons: any[] = await (await page.request.get('/api/lessons')).json();
  const lesson = lessons.find((l) => l.title.startsWith(samples.en.short));
  await page.getByTestId('side-lecture').click();
  await expect(page.getByTestId('lecture-from-lesson'), 'the lesson picker was removed').toHaveCount(0);
  await page.getByTestId('lecture-issue').fill(lesson.issue);
  await page.getByTestId('lecture-objective').fill(lesson.objectives.slice(0, 2).join('\n'));
  await page.getByTestId('lecture-coverage').selectOption('3');
  await page.getByTestId('lecture-suggest').click();
  await expect(page.getByTestId('objective-title')).toHaveText(lesson.objectives.slice(0, 2));
  await expect(page.getByTestId('objective-group').nth(0).getByTestId('suggestion')).toHaveCount(3);
  await expect(page.getByTestId('objective-group').nth(1).getByTestId('suggestion')).toHaveCount(3);
  // Only lessons are in this vault, so every suggested verse says it is from the Lesson Library.
  const verses = page.getByTestId('suggested-verse');
  expect(await verses.count()).toBeGreaterThan(0);
  await expect(verses.getByTestId('origin-verse-library')).toHaveCount(0);
  await expect(verses.first().getByTestId('origin-lesson-library').first()).toContainText(/^Lesson Library · .+, p\.\d+$/);
  const after: any[] = await (await page.request.get('/api/lessons')).json();
  expect(after.find((l) => l.id === lesson.id).objectives).toEqual(lesson.objectives);
});
