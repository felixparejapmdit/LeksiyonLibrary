import { test, expect, row, assertSmooth, resetPerf, watchFrames, recordClick } from '../support/fixtures';
import { samples } from '../support/samples';
import { makePdf } from '../support/pdf';

test('category tabs filter the list and show live counts', async ({ app: page }) => {
  await resetPerf(page);
  await page.getByTestId('tab-midweek').click();
  await expect(page.getByTestId('list-title')).toHaveText('Midweek');
  await expect(page.getByTestId('item-count')).toHaveText('1 item');
  await page.getByTestId('tab-weekend').click();
  await expect(page.getByTestId('item-count')).toHaveText('3 items');
  await page.getByTestId('tab-pastoral').click();
  await expect(page.getByTestId('list-title')).toHaveText('Pastoral Visits');
  await expect(page.getByTestId('item-count')).toHaveText('1 item');
  await page.getByTestId('tab-all').click();
  await expect(page.getByTestId('item-count')).toHaveText('5 items');
  await assertSmooth(page, 'category tabs');
});

test('sorting orders the list', async ({ app: page }) => {
  const titles = () => page.getByTestId('lesson-title').allTextContents();
  await expect(page.getByTestId('lesson-row')).toHaveCount(5);
  const newest = await titles();
  expect(newest[newest.length - 1]).toContain('Halimbawa ng Tungkulin');
  await page.getByTestId('sort-select').selectOption('oldest');
  expect((await titles())[0]).toContain('Halimbawa ng Tungkulin');
  await page.getByTestId('sort-select').selectOption('title');
  const az = await titles();
  expect([...az].sort((a, b) => a.localeCompare(b))).toEqual(az);
  await page.getByTestId('sort-select').selectOption('newest');
  expect(await titles()).toEqual(newest);
});

test('selecting a lesson highlights it and loads it in the viewer', async ({ app: page }) => {
  const r = row(page, 'Sampleday');
  await r.getByTestId('lesson-open').click();
  await expect(r).toHaveAttribute('data-selected', 'true');
  const id = await r.getAttribute('data-lesson-id');
  await expect(page.getByTestId('pdf-viewer')).toHaveAttribute('data-lesson', id!);
});

test('year folders filter, show a chip, expand, and clear', async ({ app: page }) => {
  // The Lesson Library's years sit under it, and open its lessons of that year.
  await page.getByTestId('year-2026').click();
  await expect(page.getByTestId('list-title')).toHaveText('Lesson Library');
  await expect(page.getByTestId('year-2026')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('chip-year')).toContainText('Year: 2026');
  await expect(page.getByTestId('item-count')).toHaveText('2 items');
  await page.getByTestId('year-2026').click();
  await expect(page.getByTestId('chip-year'), 'a second click opens the whole library again').toHaveCount(0);
  await page.getByTestId('year-2026').click();
  await page.getByTestId('chip-year-clear').click();
  await expect(page.getByTestId('chip-year')).toHaveCount(0);

  await page.getByTestId('year-expand-2024').click();
  const child = page.getByTestId('tree-lesson');
  await expect(child).toHaveCount(1);
  await child.click();
  await expect(page.locator('[data-testid="lesson-row"][data-selected="true"]')).toContainText('Sampleday');
  await page.getByTestId('year-expand-2024').click();
  await expect(page.getByTestId('tree-lesson')).toHaveCount(0);
});

test('All Archives, the Lesson Library and Pastoral Visits each list their own lessons', async ({ app: page }) => {
  const lessons: any[] = await (await page.request.get('/api/lessons')).json();
  const visits = lessons.filter((l) => l.category === 'pastoral').length;
  expect(visits).toBeGreaterThan(0);
  await expect(page.getByTestId('side-all-count')).toHaveText(String(lessons.length));
  await expect(page.getByTestId('side-lessons-count')).toHaveText(String(lessons.length - visits));
  await expect(page.getByTestId('side-pv-count')).toHaveText(String(visits));

  // The Lesson Library has no pastoral visits, and no tab for them.
  await page.getByTestId('side-lessons').click();
  await expect(page.getByTestId('list-title')).toHaveText('Lesson Library');
  await expect(page.getByTestId('item-count')).toHaveText(`${lessons.length - visits} items`);
  await expect(page.getByTestId('tab-pastoral')).toHaveCount(0);
  await expect(page.getByTestId('pv-drop')).toHaveCount(0);
  await expect(page.getByTestId('lesson-upload')).toBeVisible();
  await page.getByTestId('tab-weekend').click();
  await expect(page.getByTestId('list-title')).toHaveText('Weekend');

  // Pastoral Visits lists only them, with its own place to drop them.
  await page.getByTestId('side-pv').click();
  await expect(page.getByTestId('list-title')).toHaveText('Pastoral Visits');
  await expect(page.getByTestId('item-count')).toHaveText(`${visits} ${visits === 1 ? 'item' : 'items'}`);
  await expect(page.getByTestId('category-tabs')).toHaveCount(0);
  await expect(page.getByTestId('pv-drop')).toContainText('Drop pastoral visit PDF or DOCX files here');
  await expect(page.getByTestId('lesson-upload'), 'lesson PDFs are uploaded in the Lesson Library').toHaveCount(0);

  // All Archives brings them together again.
  await page.getByTestId('side-all').click();
  await expect(page.getByTestId('list-title')).toHaveText('All Archives');
  await expect(page.getByTestId('item-count')).toHaveText(`${lessons.length} items`);
  await expect(page.getByTestId('tab-pastoral')).toBeVisible();
  await expect(page.getByTestId('lesson-upload')).toHaveCount(0);

  // The Lesson Library has the upload for lesson PDFs.
  await page.getByTestId('side-lessons').click();
  await page.getByTestId('lesson-upload').click();
  await expect(page.getByTestId('upload-dialog')).toHaveAccessibleName('Ingest & Archive Lesson');
  await page.getByTestId('upload-done').click();
});

test('Pastoral Visits has year folders of its own visits', async ({ app: page }) => {
  const lessons: any[] = await (await page.request.get('/api/lessons')).json();
  const visit = lessons.find((l) => l.category === 'pastoral' && l.year);
  expect(visit, 'a dated pastoral visit').toBeTruthy();
  const sameYear = lessons.filter((l) => l.category === 'pastoral' && l.year === visit.year).length;
  // Only the libraries' own year folders: no folder for pastoral visits, and none made by hand.
  for (const gone of ['side-pastoral', 'folder-add', 'custom-folder', 'folders-toggle', 'verses-toggle', 'side-verse']) await expect(page.getByTestId(gone)).toHaveCount(0);
  const worshipYears = new Set(lessons.filter((l) => l.category !== 'pastoral' && l.year).map((l) => l.year));
  await expect(page.getByTestId('folders').getByRole('button', { name: /^\d{4}/ })).toHaveCount(worshipYears.size);

  await page.getByTestId(`pv-year-${visit.year}`).click();
  await expect(page.getByTestId('list-title')).toHaveText('Pastoral Visits');
  await expect(page.getByTestId('chip-year')).toContainText(`Year: ${visit.year}`);
  await expect(page.getByTestId('item-count')).toHaveText(`${sameYear} ${sameYear === 1 ? 'item' : 'items'}`);
  await page.getByTestId(`pv-year-expand-${visit.year}`).click();
  await expect(page.getByTestId('tree-lesson')).toHaveCount(sameYear);
  await page.getByTestId('tree-lesson').first().click();
  await expect(page.locator('[data-testid="lesson-row"][data-selected="true"]')).toHaveCount(1);
  await page.getByTestId(`pv-year-expand-${visit.year}`).click();
  await expect(page.getByTestId('tree-lesson')).toHaveCount(0);

  // The Pastoral Visits page has the same year folders as tabs of its own.
  await page.getByTestId('side-pv').click();
  const visits = lessons.filter((l) => l.category === 'pastoral');
  await expect(page.getByTestId('pv-folder-all')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('pv-folder-all')).toContainText(`All years${visits.length}`);
  await page.getByTestId(`pv-folder-${visit.year}`).click();
  await expect(page.getByTestId(`pv-folder-${visit.year}`)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('chip-year')).toContainText(`Year: ${visit.year}`);
  await expect(page.getByTestId('item-count')).toHaveText(`${sameYear} ${sameYear === 1 ? 'item' : 'items'}`);
  const undated = visits.filter((l) => !l.year).length;
  if (undated > 0) {
    await page.getByTestId('pv-folder-none').click();
    await expect(page.getByTestId('chip-year')).toContainText('Year: no date');
    await expect(page.getByTestId('item-count')).toHaveText(`${undated} ${undated === 1 ? 'item' : 'items'}`);
  } else {
    await expect(page.getByTestId('pv-folder-none'), 'no folder for undated visits when every visit has a date').toHaveCount(0);
  }
  await page.getByTestId('pv-folder-all').click();
  await expect(page.getByTestId('chip-year')).toHaveCount(0);
  await expect(page.getByTestId('pv-folders-hint')).toHaveCount(0);
});

test('a verse found by search filters the lessons by reference across languages', async ({ app: page }) => {
  await page.goto('/search');
  await page.getByTestId('page-search-input').fill(samples.firstRefEn);
  await page.getByTestId('search-verse').filter({ hasText: samples.firstRefEn }).first().click();
  await expect(page.getByTestId('chip-verse')).toBeVisible();
  await expect(page.getByTestId('item-count')).toHaveText('2 items');
  await expect(row(page, samples.tl.short)).toBeVisible();
  await expect(row(page, samples.en.short)).toBeVisible();
  await page.getByTestId('chip-verse-clear').click();
  await expect(page.getByTestId('item-count')).toHaveText('5 items');
});

test('search matches titles instantly, lesson text after, and highlights', async ({ app: page }) => {
  const input = page.getByTestId('search-input');
  await resetPerf(page);
  await input.pressSequentially('sampleday', { delay: 20 });
  await expect(page.getByTestId('search-count')).toHaveText('Found 1 of 5 lessons');
  await expect(page.locator('mark').first()).toHaveText(/sampleday/i);
  await expect(page.getByTestId('chip-query')).toContainText('sampleday');
  await assertSmooth(page, 'typing in search');

  await page.getByTestId('search-clear').click();
  await expect(input).toHaveValue('');
  await expect(page.getByTestId('item-count')).toHaveText('5 items');

  // This word exists only inside a PDF body, proving that full-text search works.
  await input.fill('zephyrword');
  await expect(page.getByTestId('lesson-row')).toHaveCount(1);
  await expect(page.getByTestId('lesson-row')).toContainText('Sampleday');
  // This word exists only on scanned pages, proving that OCR text is searchable.
  await input.fill(samples.searchWord);
  await expect(page.getByTestId('lesson-row')).toHaveCount(2);

  await input.fill('nosuchwordanywhere');
  await expect(page.getByTestId('empty-filter')).toBeVisible();
  await expect(page.getByTestId('search-count')).toHaveText('Found 0 of 5 lessons');
  await page.getByTestId('empty-reset').click();
  await expect(page.getByTestId('item-count')).toHaveText('5 items');

  await input.fill('sampleday');
  await expect(page.getByTestId('chip-query')).toBeVisible();
  await page.getByTestId('chip-query-clear').click();
  await expect(page.getByTestId('chip-query')).toHaveCount(0);

  await input.fill('sampleday');
  await page.getByTestId('reset-filters').click();
  await expect(input).toHaveValue('');
  await expect(page.getByTestId('filter-chips')).toHaveCount(0);
});

test('search stays correct under hostile characters', async ({ app: page }) => {
  for (const s of ['"', "'; DROP TABLE lessons; --", '(((', 'AND OR NOT', '*', '<img src=x onerror=alert(1)>', '[a-z]+']) {
    await page.getByTestId('search-input').fill(s);
    await expect(page.getByTestId('search-count')).toBeVisible();
    await page.waitForTimeout(160);
    await page.getByTestId('search-clear').click();
  }
  await expect(page.getByTestId('item-count')).toHaveText('5 items');
  expect(await page.locator('img[src="x"]').count()).toBe(0);
});

test('the sidebar gives each part one colour, shared by its icon and its label', async ({ app: page }) => {
  await page.getByTestId('side-pv').click();
  for (const id of ['side-all', 'side-lessons', 'side-pv', 'side-lecture', 'side-review', 'side-bibles', 'side-lesson-verses', 'side-import']) {
    const entry = page.getByTestId(id);
    const [label, icon] = await Promise.all([entry.evaluate((el) => getComputedStyle(el).color), entry.locator('svg').first().evaluate((el) => getComputedStyle(el).color)]);
    expect(icon, `${id}: the icon is the colour of its label`).toBe(label);
  }
  const colours = await Promise.all(['side-lessons', 'side-pv', 'side-lecture', 'side-review'].map((id) => page.getByTestId(id).evaluate((el) => getComputedStyle(el).color)));
  expect(new Set(colours).size, 'each part has its own colour').toBe(4);
  await expect(page.getByTestId('side-verified')).toHaveText(/^\d+ of \d+$/);
  await expect(page.getByTestId('edit-folder')).toHaveCount(0);
});

test('editing lesson details saves, and can be cancelled', async ({ app: page }) => {
  const r = row(page, 'Sampleday');
  await r.getByTestId('lesson-edit').click();
  await expect(page.getByTestId('edit-dialog')).toBeVisible();
  await page.getByTestId('edit-title').fill('Should Not Save');
  await page.getByTestId('edit-cancel').click();
  await expect(row(page, 'Should Not Save')).toHaveCount(0);

  await r.getByTestId('lesson-edit').click();
  await expect(page.getByTestId('edit-title')).toHaveValue(/Sampleday/);
  await page.getByTestId('edit-location').fill('Quezon City');
  await page.getByTestId('edit-author').fill('Test Minister');
  await page.getByTestId('edit-category').selectOption('midweek');
  await page.getByTestId('edit-language').selectOption('en');
  await page.getByTestId('edit-date').fill('2024-10-16');
  await page.getByTestId('edit-save').click();
  await expect(page.getByTestId('edit-dialog')).toHaveCount(0);
  await expect(r).toContainText('Quezon City');
  await expect(r).toContainText('Test Minister');
  await expect(page.getByTestId('tab-count-midweek')).toHaveText('2');

  await r.getByTestId('lesson-edit').click();
  await page.getByTestId('edit-dialog-close').click();
  await r.getByTestId('lesson-edit').click();
  await page.getByTestId('edit-category').selectOption('weekend');
  await page.getByTestId('edit-save').click();
  await expect(page.getByTestId('tab-count-weekend')).toHaveText('3');
});

test('download buttons deliver the original PDF', async ({ app: page }) => {
  const r = row(page, 'Sampleday');
  const [dl] = await Promise.all([page.waitForEvent('download'), r.getByTestId('lesson-download').click()]);
  expect(dl.suggestedFilename()).toBe('2024_Wk41b.pdf');
  const chunks: Buffer[] = [];
  for await (const c of await dl.createReadStream()) chunks.push(c as Buffer);
  expect(Buffer.concat(chunks).subarray(0, 5).toString()).toBe('%PDF-');
});

test('delete asks first; cancel keeps, accept removes', async ({ app: page }) => {
  const res = await page.request.post('/api/lessons', {
    multipart: {
      source_kind: 'text',
      pages: JSON.stringify(['Paksa: Temporary Lesson To Delete']),
      file: { name: 'temp.pdf', mimeType: 'application/pdf', buffer: makePdf([['temporary lesson body']]) },
    },
  });
  expect(res.ok()).toBeTruthy();
  await page.reload();
  const r = row(page, 'Temporary Lesson To Delete');
  await r.getByTestId('lesson-delete').click();
  await expect(page.getByTestId('confirm-body')).toContainText('Temporary Lesson To Delete');
  await page.getByTestId('confirm-cancel').click();
  await expect(r).toBeVisible();

  await r.getByTestId('lesson-delete').click();
  await page.getByTestId('confirm-dialog-close').click();
  await expect(r).toBeVisible();

  await r.getByTestId('lesson-delete').click();
  await page.getByTestId('confirm-accept').click();
  await expect(r).toHaveCount(0);
  await expect(page.getByTestId('toast')).toContainText('Lesson deleted');
});

test('panes hide, show, and resize smoothly and remember their width', async ({ app: page }) => {
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.getByTestId('sidebar')).toHaveCount(0);
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.getByTestId('sidebar')).toBeVisible();

  await page.getByTestId('toggle-viewer').click();
  await expect(page.getByTestId('pdf-viewer')).toHaveCount(0);
  const wide = (await page.getByTestId('list-pane').boundingBox())!.width;
  await page.getByTestId('toggle-viewer').click();
  await expect(page.getByTestId('pdf-viewer')).toBeVisible();
  expect((await page.getByTestId('list-pane').boundingBox())!.width).toBeLessThan(wide);

  const handle = page.getByTestId('resize-viewer');
  const before = (await page.getByTestId('pdf-viewer').boundingBox())!.width;
  const box = (await handle.boundingBox())!;
  const frames = await watchFrames(page, async () => {
    await page.mouse.move(box.x + 2, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x - 150, box.y + 300, { steps: 25 });
    await page.mouse.up();
    await page.waitForTimeout(200);
  });
  recordClick('resize-viewer');
  const after = (await page.getByTestId('pdf-viewer').boundingBox())!.width;
  expect(after).toBeGreaterThan(before + 100);
  expect(frames.blankCanvas, 'canvas blank during resize').toBe(0);
  expect(frames.emptyMain).toBe(0);

  const side = (await page.getByTestId('resize-sidebar').boundingBox())!;
  await page.mouse.move(side.x + 2, side.y + 300);
  await page.mouse.down();
  await page.mouse.move(side.x + 60, side.y + 300, { steps: 10 });
  await page.mouse.up();
  recordClick('resize-sidebar');
  await page.waitForTimeout(50);
  const sidebarW = (await page.getByTestId('sidebar').boundingBox())!.width;
  // Widening the sidebar may narrow the viewer, which protects the lesson list's minimum width.
  const viewerW = (await page.getByTestId('pdf-viewer').boundingBox())!.width;
  expect((await page.getByTestId('list-pane').boundingBox())!.width).toBeGreaterThanOrEqual(455);

  await page.reload();
  await expect(page.getByTestId('pdf-viewer')).toBeVisible();
  expect(Math.abs((await page.getByTestId('pdf-viewer').boundingBox())!.width - viewerW)).toBeLessThan(3);
  expect(Math.abs((await page.getByTestId('sidebar').boundingBox())!.width - sidebarW)).toBeLessThan(3);
});

test('brand, All Archives and desktop navigation all route correctly', async ({ app: page }) => {
  await page.getByTestId('side-bibles').click();
  await expect(page.getByTestId('bibles-page')).toBeVisible();
  await page.getByTestId('brand').click();
  await expect(page.getByTestId('vault-page')).toBeVisible();
  await page.getByTestId('side-lecture').click();
  await expect(page.getByTestId('lecture-page')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('vault-page')).toBeVisible();
  await page.getByTestId('year-2026').click();
  await page.getByTestId('side-all').click();
  await expect(page.getByTestId('chip-year')).toHaveCount(0);
});
