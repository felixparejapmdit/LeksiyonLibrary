import type { Page } from '@playwright/test';
import { test, expect, setAiMode, assertSmooth, resetPerf, withEmptyVault, fillObjectives } from '../support/fixtures';
import { makePdf } from '../support/pdf';

test.beforeEach(async ({ app: page }) => {
  await setAiMode('good');
  await page.getByTestId('side-lecture').click();
  await expect(page.getByTestId('lecture-page')).toBeVisible();
});

const ask = async (page: Page, issue = 'Members are losing appreciation for their election', objective = 'Teach that God chose his people and we should value this') => {
  await page.getByTestId('lecture-issue').fill(issue);
  await fillObjectives(page, objective);
  await page.getByTestId('lecture-suggest').click();
  await expect(page.getByTestId('suggestions')).toBeVisible();
};

test('the suggest button needs input', async ({ page }) => {
  await expect(page.getByTestId('lecture-suggest')).toBeDisabled();
  await page.getByTestId('lecture-issue').fill('election');
  await expect(page.getByTestId('lecture-suggest')).toBeEnabled();
});

test('suggestions come only from the library, byte for byte', async ({ page }) => {
  await ask(page);
  await expect(page.getByTestId('suggestion').first()).toBeVisible();
  const stored: any[] = await (await page.request.get('/api/verses')).json();
  const byId = new Map(stored.map((v) => [v.id, v]));
  const shown = page.getByTestId('suggested-verse');
  const count = await shown.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const el = shown.nth(i);
    const v = byId.get((await el.getAttribute('data-verse-id'))!);
    expect(v, 'shown verse exists in library').toBeTruthy();
    expect(await el.getByTestId('suggested-text').textContent()).toBe(v.text || 'Reference only.');
  }
});

test('results appear first, and AI notes fill in without moving the layout', async ({ page }) => {
  await setAiMode('slow');
  await resetPerf(page);
  await ask(page);
  await expect(page.getByTestId('suggestion').first()).toBeVisible();
  await expect(page.getByTestId('notes-loading')).toBeVisible();
  const before = (await page.getByTestId('suggestion').first().boundingBox())!.height;
  await expect(page.getByTestId('notes-loading')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('ai-note').first()).toContainText('STUB-NOTE-1');
  await expect(page.getByTestId('ai-note').first()).toContainText('AI note, not scripture');
  await expect(page.getByTestId('ai-status')).toContainText('AI notes by');
  expect((await page.getByTestId('suggestion').first().boundingBox())!.height).toBe(before);
  await assertSmooth(page, 'suggestion results and AI notes');
});

test('a hostile model cannot alter scripture, invent verses or quote text', async ({ page }) => {
  await setAiMode('hostile');
  const before: any[] = await (await page.request.get('/api/verses')).json();
  await ask(page);
  await expect(page.getByTestId('notes-loading')).toHaveCount(0, { timeout: 10_000 });

  const body = await page.getByTestId('suggestions').textContent();
  expect(body).not.toContain('TAMPERED');
  expect(body).not.toContain('God picked you');
  expect(body).not.toContain('John 3:16');

  const after: any[] = await (await page.request.get('/api/verses')).json();
  expect(after).toEqual(before);
});

test('with the AI offline, verse matching still works and says so', async ({ page }) => {
  await setAiMode('down');
  await page.reload();
  await page.getByTestId('side-lecture').click();
  await expect(page.getByTestId('ai-status')).toContainText('offline');
  await ask(page);
  await expect(page.getByTestId('suggestion').first()).toBeVisible();
  await expect(page.getByTestId('notes-offline')).toBeVisible();
  await setAiMode('good');
});

test('a query with no match says so', async ({ page }) => {
  await ask(page, 'xylophone', 'quasar');
  await expect(page.getByTestId('suggestions-empty')).toBeVisible();
});

test('workspace: add, reorder, remove, save, reopen, copy, print, delete', async ({ page }) => {
  await ask(page);
  const add = page.getByTestId('suggestion-add');
  await expect(add.first()).toBeVisible();
  await expect(page.getByTestId('workspace-empty')).toBeVisible();

  await add.nth(0).click();
  await expect(add.nth(0)).toHaveText(/Added/);
  await expect(add.nth(0)).toBeDisabled();
  await add.nth(1).click();
  await add.nth(2).click();
  const list = page.getByTestId('workspace-verse');
  await expect(list).toHaveCount(3);

  const ids = () => list.evaluateAll((els) => els.map((e) => e.getAttribute('data-verse-id')));
  const start = await ids();
  await expect(list.nth(0).getByTestId('workspace-up')).toBeDisabled();
  await expect(list.nth(2).getByTestId('workspace-down')).toBeDisabled();
  await list.nth(0).getByTestId('workspace-down').click();
  expect(await ids()).toEqual([start[1], start[0], start[2]]);
  await list.nth(1).getByTestId('workspace-up').click();
  expect(await ids()).toEqual(start);
  await list.nth(2).getByTestId('workspace-remove').click();
  await expect(list).toHaveCount(2);

  await expect(page.getByTestId('lecture-save')).toBeDisabled();
  await page.getByTestId('lecture-title').fill('Sample Lecture Title');
  await page.getByTestId('lecture-save').click();
  await expect(page.getByTestId('toast')).toContainText('Lecture saved');
  await expect(page.getByTestId('saved-lecture')).toContainText('Sample Lecture Title');
  await expect(page.getByTestId('saved-lecture')).toContainText('2 verses');

  await page.getByTestId('lecture-copy').click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('Sample Lecture Title');
  expect(clip).toContain(await list.nth(0).getByTestId('workspace-text').textContent());

  await page.evaluate(() => {
    (window as any).__printed = 0;
    window.print = () => {
      (window as any).__printed++;
    };
  });
  await page.getByTestId('lecture-print').click();
  expect(await page.evaluate(() => (window as any).__printed)).toBe(1);

  await page.getByTestId('lecture-new').click();
  await expect(page.getByTestId('workspace-empty')).toBeVisible();
  await expect(page.getByTestId('lecture-title')).toHaveValue('');
  await page.getByTestId('saved-open').click();
  await expect(page.getByTestId('lecture-title')).toHaveValue('Sample Lecture Title');
  await expect(list).toHaveCount(2);

  await page.reload();
  await page.getByTestId('side-lecture').click();
  await expect(page.getByTestId('saved-lecture')).toHaveCount(1);
  await page.getByTestId('saved-delete').click();
  await page.getByTestId('confirm-accept').click();
  await expect(page.getByTestId('saved-empty')).toBeVisible();
});

/** Results first: "not loading" is also true before loading has begun. */
async function notesDone(page: Page) {
  await expect(page.getByTestId('suggestions')).toBeVisible();
  await expect(page.getByTestId('notes-loading')).toHaveCount(0, { timeout: 10_000 });
}

const OBJECTIVES = 'Teach that God chose his people\nExplain how to serve God faithfully';

async function verseCounts(page: Page) {
  return page.getByTestId('objective-group').evaluateAll((els) => els.map((e) => e.querySelectorAll('[data-testid="suggestion"]').length));
}

const keysOf = (page: Page, group: number) =>
  page.getByTestId('objective-group').nth(group).getByTestId('suggestion').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')));

test('each objective gets up to five verses, and an objective added later gets its own', async ({ page }) => {
  await expect(page.getByTestId('lecture-coverage'), 'there is no number of verses to choose').toHaveCount(0);
  await page.getByTestId('lecture-issue').fill('Members are losing appreciation for their election');
  await fillObjectives(page, OBJECTIVES);
  await page.getByTestId('lecture-suggest').click();
  await expect(page.getByTestId('objective-title')).toHaveText(['Teach that God chose his people', 'Explain how to serve God faithfully']);
  await expect.poll(async () => (await verseCounts(page)).every((c) => c === 5)).toBe(true);
  await expect(page.getByTestId('objective-shortfall')).toHaveCount(0);
  await notesDone(page);
  const first = await keysOf(page, 0);

  // Each objective has a tab, so the others are one click away rather than further down.
  const tabs = page.getByTestId('objective-tab');
  const groups = page.getByTestId('objective-group');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(0)).toContainText('Teach that God chose his people');
  await expect(tabs.nth(0).getByTestId('objective-tab-count')).toHaveText('5');
  await expect(groups.nth(0)).toBeVisible();
  await expect(groups.nth(1)).toBeHidden();
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(groups.nth(0)).toBeHidden();
  await expect(groups.nth(1)).toBeVisible();
  await expect(groups.nth(1)).toHaveAttribute('aria-labelledby', 'objective-tab-1');
  // A verse added from a tab is counted on it.
  await groups.nth(1).getByTestId('suggestion-add').first().click();
  await expect(tabs.nth(1).getByTestId('objective-tab-count')).toHaveText('1/5');
  await page.getByTestId('workspace-remove').first().click();
  // The arrow keys move between the tabs.
  await tabs.nth(1).press('ArrowLeft');
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(0)).toBeFocused();

  // A third objective gets its own verses; those already found for the others stay.
  await page.getByTestId('lecture-objective-add').click();
  await page.getByTestId('lecture-objective').nth(2).fill('Show that God keeps his promises to his people');
  await page.getByTestId('lecture-suggest').click();
  await expect(page.getByTestId('objective-title')).toHaveCount(3);
  await expect(page.getByTestId('objective-title').nth(2)).toHaveText('Show that God keeps his promises to his people');
  await expect(page.getByTestId('objective-tab').nth(2), 'the new objective opens').toHaveAttribute('aria-selected', 'true');
  expect(await keysOf(page, 0)).toEqual(first);
  await notesDone(page);

  // Four objectives at most.
  await expect(page.getByTestId('lecture-objective-add')).toContainText('3 of 4');
  await page.getByTestId('lecture-objective-add').click();
  await expect(page.getByTestId('lecture-objective')).toHaveCount(4);
  await expect(page.getByTestId('lecture-objective-add')).toBeDisabled();

  // Removing an objective takes its verses away with it.
  await page.getByTestId('lecture-objective-remove').nth(3).click();
  await page.getByTestId('lecture-objective-remove').nth(2).click();
  await expect(page.getByTestId('lecture-objective')).toHaveCount(2);
  await expect(page.getByTestId('objective-title')).toHaveCount(2);
  await expect(page.getByTestId('lecture-objective-add')).toBeEnabled();
});

test('a topic with no objectives still gets a group', async ({ page }) => {
  await page.getByTestId('lecture-issue').fill('election');
  await page.getByTestId('lecture-suggest').click();
  await expect(page.getByTestId('objective-title')).toHaveText('election');
  await expect(page.getByTestId('suggestion').first()).toBeVisible();
});

test('too few matches says so and is not padded with unrelated verses', async ({ page }) => {
  await withEmptyVault(page, async () => {
    const res = await page.request.post('/api/lessons', {
      multipart: {
        source_kind: 'text',
        pages: JSON.stringify(['Paksa: Zephyrword Lesson\nTalata: Juan 3:5']),
        file: { name: 'one-verse.pdf', mimeType: 'application/pdf', buffer: makePdf([['One verse lesson']]) },
      },
    });
    expect(res.ok()).toBeTruthy();
    await page.reload();
    await page.getByTestId('side-lecture').click();
    await ask(page, '', 'xylophone\nZephyrword');
    await expect(page.getByTestId('objective-group')).toHaveCount(2);
    const [none, one] = [page.getByTestId('objective-group').nth(0), page.getByTestId('objective-group').nth(1)];
    await expect(none.getByTestId('objective-shortfall')).toContainText('No verses in your libraries match this objective');
    await expect(none.getByTestId('suggestion')).toHaveCount(0);
    await expect(one.getByTestId('suggestion')).toHaveCount(1);
    await expect(one.getByTestId('objective-shortfall')).toContainText('Only 1 found in your libraries');
    await expect(page.getByTestId('notes-loading')).toHaveCount(0, { timeout: 10_000 });
  });
});

test('every verse shows who is speaking and its context, labelled as AI', async ({ page }) => {
  await fillObjectives(page, OBJECTIVES);
  await page.getByTestId('lecture-suggest').click();
  await notesDone(page);
  const shown = await page.getByTestId('suggestion').count();
  expect(shown).toBe(10);
  await expect(page.getByTestId('verse-context')).toHaveCount(10);
  await expect(page.getByTestId('verse-context').first()).toContainText('AI context, not scripture. Review before use.');
  await expect(page.getByTestId('verse-context-speaker').first()).toContainText('Speaker: STUB-SPEAKER-');
  await expect(page.getByTestId('verse-context-chapter').first()).toContainText(/Chapter context \(.+ \d+\): (STUB-CHAPTER|.+)/);
  await expect(page.getByTestId('verse-context-book').first()).toContainText(/Book context \(.+\):/);
});

test('the context stays apart from the verse and follows it into the workspace and copy', async ({ page }) => {
  await fillObjectives(page, 'Teach that God chose his people');
  await page.getByTestId('lecture-suggest').click();
  await notesDone(page);
  const stored: any[] = await (await page.request.get('/api/verses')).json();
  const verse = page.getByTestId('suggested-verse').first();
  const id = await verse.getAttribute('data-verse-id');
  expect(await verse.getByTestId('suggested-text').textContent()).toBe(stored.find((v) => v.id === id).text);
  await expect(verse.getByTestId('suggested-text')).not.toContainText('STUB');

  await page.getByTestId('suggestion-add').first().click();
  await expect(page.getByTestId('workspace-context-speaker')).toContainText('STUB-SPEAKER-');
  await page.getByTestId('lecture-title').fill('Context copy');
  await page.getByTestId('lecture-copy').click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('Speaker (AI, review before use): STUB-SPEAKER-');
  expect(clip).toContain('Chapter context (AI, review before use): ');
  expect(clip).toContain('Book context (AI, review before use): ');

  // The speaker and context are kept, so a saved lecture still shows them.
  await page.getByTestId('lecture-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Lecture saved' })).toBeVisible();
  await page.reload();
  await page.getByTestId('side-lecture').click();
  await page.getByTestId('saved-open').click();
  await expect(page.getByTestId('workspace-context-speaker')).toContainText('STUB-SPEAKER-');
  await expect(page.getByTestId('workspace-context-chapter')).toContainText('Chapter context');
  await expect(page.getByTestId('workspace-context-book')).toContainText('Book context');
  await page.getByTestId('saved-delete').click();
  await page.getByTestId('confirm-accept').click();
  await expect(page.getByTestId('saved-empty')).toBeVisible();
});

test('a hostile model cannot put quotes, other verses or invented speakers in the context', async ({ page }) => {
  await setAiMode('hostile');
  const before: any[] = await (await page.request.get('/api/verses')).json();
  await fillObjectives(page, OBJECTIVES);
  await page.getByTestId('lecture-suggest').click();
  await notesDone(page);
  const body = await page.getByTestId('suggestions').textContent();
  for (const bad of ['John 3:16', 'God picked you', 'INVENTED', 'TAMPERED']) expect(body).not.toContain(bad);
  expect(await (await page.request.get('/api/verses')).json()).toEqual(before);
});

test('with the AI offline the verses and their lesson source still show', async ({ page }) => {
  await withEmptyVault(page, async () => {
    const res = await page.request.post('/api/lessons', {
      multipart: {
        source_kind: 'text',
        pages: JSON.stringify(['Paksa: Offline Zephyrword Lesson\nTalata: Juan 3:5']),
        file: { name: 'offline.pdf', mimeType: 'application/pdf', buffer: makePdf([['Offline lesson']]) },
      },
    });
    expect(res.ok()).toBeTruthy();
    await setAiMode('down');
    await page.reload();
    await page.getByTestId('side-lecture').click();
    await fillObjectives(page, 'Zephyrword');
    await page.getByTestId('lecture-suggest').click();
    await expect(page.getByTestId('notes-offline')).toBeVisible();
    await expect(page.getByTestId('notes-loading')).toHaveCount(0);
    await expect(page.getByTestId('verse-context')).toHaveCount(0);
    await expect(page.getByTestId('origin-lesson-library').first()).toHaveText(/^Lesson Library · Offline Zephyrword Lesson, p\.\d+$/);
    await setAiMode('good');
  });
});

test('saved context is shown again without waiting for the AI', async ({ page }) => {
  await fillObjectives(page, 'Teach that God chose his people');
  await page.getByTestId('lecture-suggest').click();
  await notesDone(page);
  await setAiMode('down');
  await page.reload();
  await page.getByTestId('side-lecture').click();
  await fillObjectives(page, 'Teach that God chose his people');
  await page.getByTestId('lecture-suggest').click();
  await expect(page.getByTestId('verse-context-speaker').first()).toContainText('STUB-SPEAKER-');
  await setAiMode('good');
});
