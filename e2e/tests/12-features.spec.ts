import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import type { Page } from '@playwright/test';
import { test, expect, setAiMode, withEmptyVault, TEST_PASSPHRASE, fillObjectives } from '../support/fixtures';
import { makePdf } from '../support/pdf';

/** A made-up lesson with two printed verses, each on its own citation line. */
async function addLesson(page: Page, name: string, topic: string, verses: [string, string][]) {
  const lines = verses.flatMap(([reference, text]) => [`A. A point ..... ${reference} NIRV`, text, 'B Next point']);
  const res = await page.request.post('/api/lessons', {
    multipart: {
      source_kind: 'text',
      pages: JSON.stringify([`Saturday/Sunday: March 3/4, 2001\nPaksa: ${topic}\n${lines.join('\n')}`]),
      file: { name, mimeType: 'application/pdf', buffer: makePdf([[topic]]) },
    },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).lesson;
}

const VERSES: [string, string][] = [
  ['Juan 3:5', 'The first made up verse speaks about a vocation from above.'],
  ['Juan 3:6', 'The second made up verse speaks about planting in spring.'],
  ['Juan 3:7', 'The third made up verse speaks about walking at night.'],
  ['Juan 3:8', 'The fourth made up verse speaks about waiting by water.'],
];

/** Opens the Lecture Maker, asks for one objective, and waits for the AI to finish. */
async function ask(page: Page, objective: string) {
  await page.goto('/lecture');
  await fillObjectives(page, objective);
  await page.getByTestId('lecture-suggest').click();
  await expect(page.getByTestId('suggestions')).toBeVisible();
  await expect(page.getByTestId('notes-loading')).toHaveCount(0, { timeout: 15_000 });
  // Details stay folded away until asked for.
  const toggles = page.getByTestId('verse-context-toggle');
  for (let i = 0; i < (await toggles.count()); i++) await toggles.nth(i).click();
}

test.describe('review queue', () => {
  test('steps through unverified verses beside their page, then locks them', async ({ page }) => {
    await withEmptyVault(page, async () => {
      const lesson = await addLesson(page, 'review.pdf', 'Review Lesson', VERSES.slice(0, 3));
      await page.goto('/');
      await expect(page.getByTestId('side-review-count')).toHaveText('3');
      await page.getByTestId('side-review').click();

      await expect(page.getByTestId('review-progress')).toHaveText('1 of 3 to review');
      await expect(page.getByTestId('pdf-viewer')).toHaveAttribute('data-lesson', lesson.id);
      await expect(page.locator('[data-testid="viewer-canvas"][data-rendered-key]')).toBeVisible();
      await expect(page.getByTestId('review-prev')).toBeDisabled();

      // Locking is permanent, so it needs a deliberate confirmation for each verse.
      await expect(page.getByTestId('review-verify')).toBeDisabled();
      const first = await page.getByTestId('review-reference').inputValue();
      await page.getByTestId('review-skip').click();
      await expect(page.getByTestId('review-progress')).toHaveText('2 of 3 to review');
      await expect(page.getByTestId('review-reference')).not.toHaveValue(first);
      await page.getByTestId('review-prev').click();
      await expect(page.getByTestId('review-reference')).toHaveValue(first);

      // A correction is saved without locking, and the original scan is kept.
      await page.getByTestId('review-raw-toggle').click();
      const raw = await page.getByTestId('review-raw').innerText();
      await page.getByTestId('review-text').fill('A corrected wording of this verse.');
      await page.getByTestId('review-save').click();
      await expect(page.getByTestId('toast').filter({ hasText: 'Correction saved' })).toBeVisible();
      let verses: any[] = await (await page.request.get('/api/verses')).json();
      const corrected = verses.find((v) => v.text === 'A corrected wording of this verse.');
      expect(corrected.status).toBe('unverified');
      expect(corrected.ocr_raw).toBe(raw);

      // Verify saves unsaved edits first, then locks, and moves on.
      await page.getByTestId('review-text').fill('The final wording of this verse.');
      await page.getByTestId('review-compared').check();
      await page.getByTestId('review-verify').click();
      await expect(page.getByTestId('review-progress')).toHaveText('1 of 2 to review');
      await expect(page.getByTestId('review-compared')).not.toBeChecked();
      verses = await (await page.request.get('/api/verses')).json();
      expect(verses.find((v) => v.text === 'The final wording of this verse.').status).toBe('verified');

      for (let left = 2; left > 0; left--) {
        await page.getByTestId('review-compared').check();
        await page.getByTestId('review-verify').click();
        if (left > 1) await expect(page.getByTestId('review-progress')).toHaveText(`1 of ${left - 1} to review`);
      }
      await expect(page.getByTestId('review-done')).toHaveText('Every verse is verified');
      await page.getByTestId('review-back').click();
      await expect(page.getByTestId('bibles-page')).toBeVisible();
      await page.getByTestId('bibles-review').click();
      await expect(page.getByTestId('review-done')).toBeVisible();
    });
  });

  test('says so when there is nothing to review', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await page.goto('/review');
      await expect(page.getByTestId('review-done')).toHaveText('No verses to review yet');
    });
  });
});

test.describe('reviewing AI context', () => {
  test('a correction is marked reviewed, survives later AI runs, and can be removed', async ({ page }) => {
    await setAiMode('good');
    await withEmptyVault(page, async () => {
      await addLesson(page, 'context.pdf', 'Context Lesson', VERSES.slice(0, 1));
      await ask(page, 'vocation');
      const label = page.getByTestId('verse-context-label');
      await expect(label).toHaveText('AI context, not scripture. Review before use.');
      await expect(page.getByTestId('verse-context-speaker')).toContainText('STUB-SPEAKER');
      await expect(page.getByTestId('verse-context-chapter')).toContainText('Chapter context (John 3): STUB-CHAPTER');
      await expect(page.getByTestId('verse-context-book')).toContainText('Book context (John): STUB-BOOK');

      await page.getByTestId('context-edit').click();
      await expect(page.getByTestId('context-ai-note')).toBeVisible();
      await expect(page.getByTestId('context-speaker')).toHaveValue(/STUB-SPEAKER/);
      await expect(page.getByTestId('context-chapter')).toHaveValue(/STUB-CHAPTER/);
      await expect(page.getByTestId('context-book')).toHaveValue(/STUB-BOOK/);
      await page.getByTestId('context-cancel').click();
      await page.getByTestId('context-edit').click();
      await page.getByTestId('context-dialog-close').click();
      await page.getByTestId('context-edit').click();
      await page.getByTestId('context-speaker').fill('The apostle');
      await page.getByTestId('context-chapter').fill('My chapter background.');
      await page.getByTestId('context-book').fill('My book background.');
      await page.getByTestId('context-note').fill('My note on this verse.');
      await page.getByTestId('context-save').click();
      await expect(label).toHaveText('Reviewed by you.');
      await expect(page.getByTestId('verse-context-speaker')).toContainText('The apostle');
      await expect(page.getByTestId('verse-context-chapter')).toContainText('My chapter background.');
      await expect(page.getByTestId('verse-context-book')).toContainText('My book background.');
      await expect(page.getByTestId('verse-context-note')).toContainText('My note on this verse.');

      // Another AI run must not replace it.
      await page.getByTestId('lecture-suggest').click();
      await expect(page.getByTestId('notes-loading')).toHaveCount(0, { timeout: 15_000 });
      await page.waitForTimeout(300);
      await expect(page.getByTestId('verse-context-speaker')).toContainText('The apostle');
      await expect(page.getByTestId('verse-context-chapter')).toContainText('My chapter background.');
      await page.reload();
      expect(Object.values(await (await page.request.get('/api/verse-context')).json())[0]).toEqual({ speaker: 'The apostle', context: 'My note on this verse.', reviewed: true });
      const scripture: any = await (await page.request.get('/api/scripture-context')).json();
      expect(Object.values(scripture)).toEqual(expect.arrayContaining([{ context: 'My chapter background.', reviewed: true }, { context: 'My book background.', reviewed: true }]));

      // The verse itself is never touched.
      const verses: any[] = await (await page.request.get('/api/verses')).json();
      expect(verses[0].text).toBe(VERSES[0][1]);

      // Everything can be cleared, then added by hand.
      await setAiMode('down');
      await ask(page, 'vocation');
      await page.getByTestId('context-edit').click();
      for (const field of ['context-speaker', 'context-chapter', 'context-book', 'context-history', 'context-note']) await page.getByTestId(field).fill('');
      await page.getByTestId('context-save').click();
      await expect(page.getByTestId('verse-context')).toHaveCount(0);
      await expect(page.getByTestId('context-edit')).toContainText('Add speaker and context');
      await page.getByTestId('context-edit').click();
      await page.getByTestId('context-speaker').fill('Added by hand');
      await page.getByTestId('context-save').click();
      await expect(page.getByTestId('verse-context-label')).toHaveText('Reviewed by you.');
      await setAiMode('good');

      expect((await page.request.post('/api/verse-context', { data: { canonical_key: 'no.such:key', speaker: 'x', context: '' } })).status()).toBe(404);
      for (const scope of ['nonsense', 'book:9999', 'chapter:43', 'chapter:43.x'])
        expect((await page.request.post('/api/scripture-context', { data: { scope, context: 'x' } })).status(), scope).toBe(400);
    });
  });

  test('chapter and book context are written once and shared by their verses', async ({ page }) => {
    await setAiMode('good');
    await withEmptyVault(page, async () => {
      // Same chapter, and another chapter of the same book.
      // Each verse mentions the objective: a lesson's other verses are not pulled in by one shared word.
      await addLesson(page, 'shared.pdf', 'Shared Lesson', [VERSES[0], ['Juan 3:6', 'Another made up verse in the same chapter, about a vocation.'], ['Juan 4:1', 'A made up verse about a different chapter of vocation.']]);
      await ask(page, 'vocation');
      await expect(page.getByTestId('suggestion')).toHaveCount(3);
      const chapters = await page.getByTestId('verse-context-chapter').allInnerTexts();
      const byChapter = (name: string) => chapters.filter((t) => t.includes(`(${name})`));
      expect(byChapter('John 3')).toHaveLength(2);
      expect(byChapter('John 4')).toHaveLength(1);
      expect(byChapter('John 3')[0]).toBe(byChapter('John 3')[1]);
      expect(byChapter('John 4')[0]).not.toBe(byChapter('John 3')[0]);
      const books = await page.getByTestId('verse-context-book').allInnerTexts();
      expect(new Set(books).size, 'the same book, the same context').toBe(1);

      const stored: any = await (await page.request.get('/api/scripture-context')).json();
      expect(Object.keys(stored).sort()).toEqual(['book:43', 'chapter:43.3', 'chapter:43.4', 'history:43']);

      // A correction reaches every verse in that chapter, and no others.
      const john3 = page.getByTestId('suggestion').filter({ hasText: 'John 3:5' });
      await john3.getByTestId('context-edit').click();
      await page.getByTestId('context-chapter').fill('Corrected for the whole chapter.');
      await page.getByTestId('context-save').click();
      await expect(page.getByTestId('verse-context-chapter').filter({ hasText: 'Corrected for the whole chapter.' })).toHaveCount(2);
      const after = await page.getByTestId('verse-context-chapter').allInnerTexts();
      expect(after.filter((t) => t.includes('(John 4)'))[0]).not.toContain('Corrected');

      // It is not asked for again once it exists.
      const before = JSON.stringify(await (await page.request.get('/api/scripture-context')).json());
      await page.getByTestId('lecture-suggest').click();
      await expect(page.getByTestId('suggestions')).toBeVisible();
      await page.waitForTimeout(800);
      expect(JSON.stringify(await (await page.request.get('/api/scripture-context')).json())).toBe(before);
    });
  });

  test('a hostile model cannot put quotes or other verses in chapter or book context', async ({ page }) => {
    await setAiMode('hostile');
    await withEmptyVault(page, async () => {
      await addLesson(page, 'hostile.pdf', 'Hostile Lesson', VERSES.slice(0, 1));
      await ask(page, 'vocation');
      await expect(page.getByTestId('verse-context-chapter')).toHaveCount(0);
      await expect(page.getByTestId('verse-context-book')).toHaveCount(0);
      const body = await page.getByTestId('suggestions').textContent();
      for (const bad of ['John 3:16', 'God picked you']) expect(body).not.toContain(bad);
      await expect(page.getByTestId('verse-context-speaker')).toHaveCount(0);
      expect(await (await page.request.get('/api/scripture-context')).json()).toEqual({});
    });
    await setAiMode('good');
  });
});

test.describe('objective groups', () => {
  test('a saved lecture keeps which verse belongs to which objective, and Word and copy follow it', async ({ page }) => {
    await setAiMode('good');
    await withEmptyVault(page, async () => {
      await addLesson(page, 'groups.pdf', 'Grouped Lesson', VERSES);
      await page.goto('/lecture');
      await page.getByTestId('lecture-issue').fill('A <test> issue & more');
      await fillObjectives(page, 'planting\nwalking');
      await page.getByTestId('lecture-suggest').click();
      await expect(page.getByTestId('objective-title')).toHaveText(['planting', 'walking']);
      await expect(page.getByTestId('notes-loading')).toHaveCount(0, { timeout: 15_000 });
      await page.getByTestId('objective-group').nth(0).getByTestId('suggestion-add').first().click();
      await page.getByTestId('objective-tab').nth(1).click();
      await page.getByTestId('objective-group').nth(1).getByTestId('suggestion-add').first().click();
      await expect(page.getByTestId('workspace-objective')).toHaveText(['planting', 'walking']);

      await expect(page.getByTestId('lecture-export-word')).toBeDisabled();
      await page.getByTestId('lecture-title').fill('Grouped Lecture');
      await page.getByTestId('lecture-save').click();
      await expect(page.getByTestId('toast').filter({ hasText: 'Lecture saved' })).toBeVisible();

      await page.reload();
      await page.getByTestId('side-lecture').click();
      await page.getByTestId('saved-open').click();
      await expect(page.getByTestId('workspace-objective')).toHaveText(['planting', 'walking']);

      // Context can be reviewed from the workspace too.
      await page.getByTestId('workspace-context-toggle').first().click();
      await page.getByTestId('workspace-context-edit').first().click();
      await expect(page.getByTestId('context-chapter')).toHaveValue(/STUB-CHAPTER/);
      await page.getByTestId('context-cancel').click();

      await page.getByTestId('lecture-copy').click();
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      expect(clip.indexOf('planting')).toBeLessThan(clip.indexOf('walking'));
      expect(clip).not.toContain('Objective:');

      const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('lecture-export-word').click()]);
      expect(download.suggestedFilename()).toBe('Grouped Lecture.docx');
      const zip = new AdmZip(readFileSync(await download.path()));
      for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) expect(zip.getEntry(part), part).toBeTruthy();
      const doc = zip.readAsText('word/document.xml');
      expect(doc).toContain('Grouped Lecture');
      expect(doc).toContain('A &lt;test&gt; issue &amp; more');
      expect(doc.indexOf('>planting<')).toBeGreaterThan(-1);
      expect(doc.indexOf('>planting<')).toBeLessThan(doc.indexOf('>walking<'));
      expect(doc).toContain(VERSES[1][1]);
      expect(doc).toContain('AI context, not scripture');
      expect(doc).toContain('Chapter context: STUB-CHAPTER');
      expect(doc).toContain('Book context: STUB-BOOK');

      // Narrowing the window must not lose the lecture being worked on.
      await page.setViewportSize({ width: 800, height: 900 });
      await expect(page.getByTestId('workspace-objective')).toHaveText(['planting', 'walking']);
      await expect(page.getByTestId('lecture-title')).toHaveValue('Grouped Lecture');
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(page.getByTestId('workspace-objective')).toHaveText(['planting', 'walking']);

      // The print view keeps the same order and hides the controls.
      const pdf = await page.pdf({ format: 'A4' });
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      await page.emulateMedia({ media: 'print' });
      await expect(page.getByTestId('workspace-objective').first()).toBeVisible();
      await expect(page.getByTestId('lecture-save')).toBeHidden();
      await expect(page.getByTestId('workspace-context-edit').first()).toBeHidden();
      await page.emulateMedia({ media: 'screen' });
    });
  });

  test('an export can only contain what the vault holds', async ({ page }) => {
    await withEmptyVault(page, async () => {
      const lesson = await addLesson(page, 'export.pdf', 'Export Lesson', VERSES.slice(0, 1));
      expect(lesson.id).toBeTruthy();
      const body = { title: 'T', issue: '', objective: '' };
      expect((await page.request.post('/api/lectures/export', { data: { ...body, verse_ids: ['no-such-verse'] } })).status()).toBe(400);
      expect((await page.request.post('/api/lectures/export', { data: { ...body, title: ' ', verse_ids: [] } })).status()).toBe(400);
    });
  });
});

test.describe('presentation mode', () => {
  test('shows one reference at a time in both languages, by button and keyboard', async ({ page }) => {
    await setAiMode('good');
    await withEmptyVault(page, async () => {
      await addLesson(page, 'present-en.pdf', 'Present Lesson', VERSES.slice(0, 2));
      const tagalog = await page.request.post('/api/lessons', {
        multipart: {
          source_kind: 'text',
          pages: JSON.stringify(['Sabado/Linggo: Marso 3/4, 2001\nPaksa: Halimbawang Aralin\nS. Isang punto ..... Juan 3:5 NIRV\nAng unang halimbawang talata.\nB Susunod']),
          file: { name: 'present-tl.pdf', mimeType: 'application/pdf', buffer: makePdf([['tl']]) },
        },
      });
      expect(tagalog.ok()).toBeTruthy();
      await page.goto('/lecture');
      await expect(page.getByTestId('lecture-present')).toBeDisabled();
      await fillObjectives(page, 'vocation');
      await page.getByTestId('lecture-suggest').click();
      await expect(page.getByTestId('notes-loading')).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByTestId('suggestion').first()).toBeVisible();
      await page.getByTestId('suggestion-add').first().click();
      await fillObjectives(page, 'planting');
      await page.getByTestId('lecture-suggest').click();
      await expect(page.getByTestId('objective-title')).toHaveText('planting');
      await expect(page.getByTestId('notes-loading')).toHaveCount(0, { timeout: 15_000 });
      await page.getByTestId('suggestion').filter({ hasText: 'planting in spring' }).getByTestId('suggestion-add').click();
      await page.getByTestId('lecture-title').fill('Presented');

      await page.getByTestId('lecture-present').click();
      await expect(page.getByTestId('present-count')).toHaveText('1 / 2');
      await expect(page.getByTestId('present-title')).toHaveText('Presented');
      await expect(page.getByTestId('present-objective')).toHaveText('vocation');
      await expect(page.getByTestId('present-edition')).toHaveCount(2);
      await expect(page.locator('[data-testid="present-edition"][data-language="tl"]')).toContainText('Ang unang halimbawang talata');
      await expect(page.locator('[data-testid="present-edition"][data-language="en"]')).toContainText(VERSES[0][1]);
      await expect(page.getByTestId('present-prev')).toBeDisabled();

      await expect(page.getByTestId('present-context-text')).toHaveCount(0);
      await page.getByTestId('present-context').click();
      await expect(page.getByTestId('present-context-text')).toContainText('AI context, not scripture');
      await expect(page.getByTestId('present-context-text')).toContainText('Chapter context (John 3): STUB-CHAPTER');
      await expect(page.getByTestId('present-context-text')).toContainText('Book context (John): STUB-BOOK');
      await page.getByTestId('present-context').click();
      await expect(page.getByTestId('present-context-text')).toHaveCount(0);

      await page.getByTestId('present-next').click();
      await expect(page.getByTestId('present-count')).toHaveText('2 / 2');
      await expect(page.getByTestId('present-text')).toHaveText(VERSES[1][1]);
      await expect(page.getByTestId('present-next')).toBeDisabled();
      await page.getByTestId('present-prev').click();
      await page.keyboard.press('ArrowRight');
      await expect(page.getByTestId('present-count')).toHaveText('2 / 2');
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByTestId('present-count')).toHaveText('1 / 2');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('present')).toHaveCount(0);
      await page.getByTestId('lecture-present').click();
      await page.getByTestId('present-exit').click();
      await expect(page.getByTestId('present')).toHaveCount(0);
      await expect(page.getByTestId('workspace-verse')).toHaveCount(2);
    });
  });
});

test.describe('backup reminder', () => {
  test('asks for a first backup, can be snoozed, and goes away after a backup', async ({ page }) => {
    // Runs after the fixture's snooze, and on every load, so this test controls it.
    await page.addInitScript(() => localStorage.setItem('lv.backupSnooze', sessionStorage.getItem('lv.test.snooze') ?? '0'));
    const lastBackup = (value: string | null) => page.route('**/api/status', (route) => route.fulfill({ json: { last_backup_at: value } }));
    const reminder = page.getByTestId('backup-reminder');
    await withEmptyVault(page, async () => {
      await lastBackup(null);
      await page.goto('/');
      await expect(page.getByTestId('empty-vault')).toBeVisible();
      await expect(reminder, 'nothing to back up yet').toHaveCount(0);

      await addLesson(page, 'reminder.pdf', 'Reminder Lesson', VERSES.slice(0, 1));
      await page.reload();
      await expect(reminder).toContainText('You have not made a backup yet');

      await page.getByTestId('backup-reminder-later').click();
      await expect(reminder).toHaveCount(0);
      const until = Number(await page.evaluate(() => localStorage.getItem('lv.backupSnooze')));
      expect(until).toBeGreaterThan(Date.now() + 2 * 86_400_000);
      await page.evaluate((v) => sessionStorage.setItem('lv.test.snooze', v), String(until));
      await page.reload();
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await expect(reminder, 'stays hidden while snoozed').toHaveCount(0);
      await page.evaluate(() => sessionStorage.removeItem('lv.test.snooze'));

      // A recent backup needs no reminder; an old one does.
      await page.unroute('**/api/status');
      await lastBackup(new Date(Date.now() - 13 * 86_400_000).toISOString());
      await page.reload();
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await expect(reminder).toHaveCount(0);
      await page.unroute('**/api/status');
      await lastBackup(new Date(Date.now() - 20 * 86_400_000).toISOString());
      await page.reload();
      await expect(reminder).toContainText('20 days ago');
      await page.unroute('**/api/status');

      await page.getByTestId('backup-reminder-now').click();
      await page.getByTestId('backup-passphrase').fill(TEST_PASSPHRASE);
      await page.getByTestId('backup-passphrase-again').fill(TEST_PASSPHRASE);
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('backup-save').click()]);
      expect(download.suggestedFilename()).toMatch(/\.lvbackup$/);
      await expect(reminder).toHaveCount(0);

      // The server remembers the backup, so a reload does not bring the reminder back.
      await page.reload();
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await expect(reminder).toHaveCount(0);
      await page.goto('/settings');
      await expect(page.getByTestId('settings-last-backup')).toContainText('Last backup:');
    });
  });
});

test.describe('search by meaning', () => {
  test('finds a verse that shares no words with the question, and falls back when the model is off', async ({ page }) => {
    await setAiMode('good');
    await withEmptyVault(page, async () => {
      await addLesson(page, 'meaning.pdf', 'Meaning Lesson', VERSES);

      // The stand-in model needs a moment to index, as the real one does.
      await expect
        .poll(async () => (await (await page.request.get('/api/search/meaning?q=calling')).json()).keys.length, { timeout: 15_000 })
        .toBeGreaterThan(0);
      expect((await (await page.request.get('/api/search?q=calling')).json()).lesson_ids, 'no words in common').toEqual([]);

      // Lecture Maker
      await ask(page, 'calling');
      await expect(page.getByTestId('match-mode')).toHaveText('Matched by meaning and words');
      await expect(page.getByTestId('suggestion')).toHaveCount(1);
      await expect(page.getByTestId('suggestion-meaning')).toHaveText('Related in meaning');
      await expect(page.getByTestId('suggested-text').first()).toHaveText(VERSES[0][1]);

      // The verses read from lessons
      await page.goto('/lesson-verses');
      await expect(page.getByTestId('bibles-meaning')).toBeDisabled();
      await page.getByTestId('bibles-search').fill('calling');
      await expect(page.getByTestId('bibles-empty')).toBeVisible();
      await page.getByTestId('bibles-meaning').click();
      await expect(page.getByTestId('bibles-meaning-note')).toContainText('calling');
      await expect(page.getByTestId('verse-text')).toHaveText(VERSES[0][1]);
      await page.getByTestId('bibles-meaning-clear').click();
      await expect(page.getByTestId('bibles-empty')).toBeVisible();

      // Search page
      await page.goto('/search');
      await page.getByTestId('page-search-input').fill('calling');
      await page.getByTestId('search-meaning').click();
      await expect(page.getByTestId('search-meaning-verse')).toHaveCount(1);
      await page.getByTestId('search-meaning-verse').click();
      await expect(page.getByTestId('vault-page')).toBeVisible();
      await page.goto('/search');
      await page.getByTestId('page-search-input').fill('nothing related here');
      await page.getByTestId('search-meaning').click();
      await expect(page.getByTestId('search-meaning-none')).toBeVisible();

      // With the model off, it says so and the words still match.
      await setAiMode('down');
      await ask(page, 'vocation');
      await expect(page.getByTestId('match-mode')).toHaveText('Matched by words only');
      await expect(page.getByTestId('suggestion').first()).toBeVisible();
      await expect(page.getByTestId('suggestion-meaning')).toHaveCount(0);
      await page.goto('/lesson-verses');
      await page.getByTestId('bibles-search').fill('calling');
      await page.getByTestId('bibles-meaning').click();
      await expect(page.getByTestId('toast').filter({ hasText: 'needs the local AI model' })).toBeVisible();
      await setAiMode('good');
    });
  });

  test('a corrected verse is indexed again by its new meaning', async ({ page }) => {
    await setAiMode('good');
    await withEmptyVault(page, async () => {
      await addLesson(page, 'reindex.pdf', 'Reindex Lesson', VERSES.slice(1, 2));
      const verses: any[] = await (await page.request.get('/api/verses')).json();
      await expect.poll(async () => (await (await page.request.get('/api/search/meaning?q=planting')).json()).keys.length, { timeout: 15_000 }).toBe(1);
      await page.request.patch(`/api/verses/${verses[0].id}`, { data: { text: 'Now it speaks about a vocation.' } });
      await expect.poll(async () => (await (await page.request.get('/api/search/meaning?q=calling')).json()).keys.length, { timeout: 15_000 }).toBe(1);
      expect((await (await page.request.get('/api/search/meaning?q=planting')).json()).keys).toEqual([]);
    });
  });
});

test.describe('teaching history', () => {
  test('is gone from the app, and an older backup that holds it still restores', async ({ page }) => {
    await withEmptyVault(page, async () => {
      await addLesson(page, 'history.pdf', 'History Lesson', VERSES.slice(0, 1));
      await page.goto('/');
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await expect(page.getByTestId('side-history')).toHaveCount(0);
      await expect(page.getByText('Teaching History')).toHaveCount(0);
      await page.getByTestId('lesson-summary-toggle').first().click();
      await expect(page.getByTestId('lesson-log-teaching')).toHaveCount(0);
      expect((await page.request.get('/api/teachings')).status()).toBe(404);

      const old = new AdmZip();
      old.addFile('manifest.json', Buffer.from(JSON.stringify({
        format: 'lesson-vault-backup',
        version: 1,
        tables: { teachings: [{ id: 't', lesson_id: 'l', taught_on: '2026-03-01', place: 'Sampleville', notes: '', created_at: 'now' }] },
      })));
      const restored = await page.request.post('/api/restore', {
        multipart: { passphrase: TEST_PASSPHRASE, file: { name: 'old.lvbackup', mimeType: 'application/octet-stream', buffer: old.toBuffer() } },
      });
      expect(restored.ok(), await restored.text()).toBeTruthy();
    });
  });
});

test.describe('folder import', () => {
  test('adds every PDF in a folder, skips other files, and flags what needs checking', async ({ page }) => {
    await withEmptyVault(page, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lv-folder-'));
      mkdirSync(join(dir, 'inner'));
      const good = 'Saturday/Sunday: March 3/4, 2001\nPaksa: Folder One\nIssue\nA good issue statement.\nObjectives\n1. A good objective.\nA. A point ..... Juan 3:5 NIRV\nA printed verse in this folder lesson.\nB Next point';
      writeFileSync(join(dir, 'one.pdf'), makePdf([good.split('\n')]));
      writeFileSync(join(dir, 'inner', 'two.pdf'), makePdf([['Paksa: Folder Two with no verses or date, and enough text to read.']]));
      writeFileSync(join(dir, 'broken.pdf'), 'this is not really a pdf');
      writeFileSync(join(dir, 'notes.txt'), 'not a pdf');

      await page.goto('/');
      await page.getByTestId('empty-upload').click();
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('upload-folder').click()]);
      await chooser.setFiles(dir);
      await expect(page.getByTestId('toast').filter({ hasText: 'skipping 1 other file' })).toBeVisible();
      await expect(page.getByTestId('upload-summary')).toHaveText(/2 added, \d to check, 1 could not be added\./, { timeout: 30_000 });
      await expect(page.getByTestId('upload-item')).toHaveCount(3);
      await expect(page.getByTestId('upload-item').filter({ hasText: 'two.pdf' }).getByTestId('upload-attention')).toContainText('no verses');
      await expect(page.getByTestId('upload-item').filter({ hasText: 'broken.pdf' })).toHaveAttribute('data-status', 'error');
      await page.getByTestId('upload-done').click();
      await expect(page.getByTestId('item-count')).toHaveText('2 items');

      // A folder with no PDFs says so.
      const empty = mkdtempSync(join(tmpdir(), 'lv-folder-'));
      writeFileSync(join(empty, 'notes.txt'), 'not a pdf');
      await page.getByTestId('header-upload').click();
      const [again] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('upload-folder').click()]);
      await again.setFiles(empty);
      await expect(page.getByTestId('toast').filter({ hasText: 'has no PDF files' })).toBeVisible();
      await page.getByTestId('upload-done').click();
    });
  });
});
