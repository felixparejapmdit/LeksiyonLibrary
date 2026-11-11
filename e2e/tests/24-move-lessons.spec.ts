import type { Page } from '@playwright/test';
import { test, expect, withEmptyVault } from '../support/fixtures';
import { makePdf } from '../support/pdf';
import { xlsx } from '../support/xlsx';

// Invented document text only; these fixtures do not use the real vault or private PDFs.
const wording = 'Ang mga bantay ay handa sa pintuan ng bayan at sila ay tapat sa kanilang tungkulin.';
const allLessons = async (page: Page): Promise<any[]> => (await page.request.get('/api/lessons')).json();
const allVerses = async (page: Page): Promise<any[]> => (await page.request.get('/api/verses')).json();

async function visit(page: Page, title: string, filename: string) {
  const lines = [
    'Saturday/Sunday: November 7/8, 2026',
    `Paksa: ${title}`,
    'PASIMULA:',
    '1. Ang mga bantay ..........Genesis 6:8 T4T',
    wording,
    'SAMPLE LOCAL, SAMPLE DISTRICT',
  ];
  const response = await page.request.post('/api/lessons', { multipart: {
    category: 'pastoral', source_kind: 'text', pages: JSON.stringify([lines.join('\n')]),
    file: { name: filename, mimeType: 'application/pdf', buffer: makePdf([lines]) },
  } });
  expect(response.ok()).toBe(true);
  return (await response.json()).lesson;
}

test('a misplaced PDF moves in both directions without losing its file, wording, or saved lecture', async ({ page }) => {
  await withEmptyVault(page, async () => {
    const lesson = await visit(page, 'Sample Misplaced Lesson', '20261108_misplaced.pdf');
    const metadata = { issue: 'Prepare the watchmen for service', objectives: ['Teach careful preparation'], local_congregation: 'Sample Local', district: 'Sample District' };
    expect((await page.request.patch(`/api/lessons/${lesson.id}`, { data: metadata })).ok()).toBe(true);
    const before = (await allLessons(page))[0];
    const [verse] = await allVerses(page);
    expect((await page.request.post(`/api/verses/${verse.id}/verify`)).ok()).toBe(true);
    const saved = await page.request.post('/api/lectures', { data: { title: 'Saved sample outline', issue: '', objective: '', verse_ids: [verse.id], verse_objectives: [''] } });
    expect(saved.ok()).toBe(true);
    const pdfBefore = await (await page.request.get(`/api/lessons/${lesson.id}/file`)).body();

    await page.goto('/');
    await page.getByTestId('side-pv').click();
    const row = page.locator(`[data-testid="lesson-row"][data-lesson-id="${lesson.id}"]`);
    await row.getByTestId('lesson-move').click();
    await expect(page.getByTestId('move-lesson-dialog')).toBeVisible();
    await page.getByTestId('move-lesson-category').selectOption('midweek');
    await page.getByTestId('move-lesson-confirm').click();
    await expect(page.getByTestId('move-lesson-dialog')).toHaveCount(0);
    await expect(page.getByTestId('list-title')).toHaveText('Lesson Library');
    await expect(page.getByTestId('side-lessons-count')).toHaveText('1');
    await expect(page.getByTestId('side-pv-count')).toHaveText('0');
    await expect(page.getByTestId('side-lesson-verses-count')).toHaveText('1');
    await expect(page.getByTestId('viewer-canvas')).toBeVisible();
    await page.reload();
    const moved = (await allLessons(page))[0];
    expect(moved).toMatchObject({ ...metadata, id: before.id, title: before.title, language: before.language, category: 'midweek', lesson_date: before.lesson_date, year: before.year, file_name: before.file_name, byte_size: before.byte_size, needs_check: true });
    expect(await (await page.request.get(`/api/lessons/${lesson.id}/file`)).body()).toEqual(pdfBefore);
    const [after] = await allVerses(page);
    expect(after).toMatchObject({ id: verse.id, text: verse.text, ocr_raw: verse.ocr_raw, status: 'verified', sources: [{ lesson_id: lesson.id, pastoral: false }] });
    expect((await (await page.request.get('/api/lectures')).json())[0].verse_ids).toEqual([verse.id]);

    await page.getByTestId('side-lessons').click();
    await row.getByTestId('lesson-move').click();
    await expect(page.getByTestId('move-lesson-category')).toHaveCount(0);
    await page.getByTestId('move-lesson-confirm').click();
    await expect(page.getByTestId('list-title')).toHaveText('Pastoral Visits');
    await expect(page.getByTestId('side-pv-count')).toHaveText('1');
    await expect(page.getByTestId('side-lessons-count')).toHaveText('0');
    await expect(page.getByTestId('side-bibles-count')).toHaveText('1');
    await page.reload();
    expect((await allLessons(page))[0]).toMatchObject({ id: lesson.id, category: 'pastoral', ...metadata });
    expect((await allVerses(page))[0]).toMatchObject({ id: verse.id, text: verse.text, status: 'verified', sources: [{ lesson_id: lesson.id, pastoral: true }] });
    expect((await (await page.request.get('/api/lectures')).json())[0].verse_ids).toEqual([verse.id]);
    expect(await (await page.request.get(`/api/lessons/${lesson.id}/file`)).body()).toEqual(pdfBefore);
  });
});

test('moving an existing imported verse usage gives the lesson its own record and keeps other visits and lectures intact', async ({ page }) => {
  await withEmptyVault(page, async () => {
    expect((await page.request.post('/api/verses/import', { multipart: {
      commit: '1', file: { name: 'move-source.xlsx', mimeType: 'application/octet-stream', buffer: xlsx([
        ['Translation', 'Book', 'Chapter', 'Verse', 'Content'], ['T4T', 'Genesis', '6', '8', wording],
      ]) },
    } })).ok()).toBe(true);
    const [original] = await allVerses(page);
    expect((await page.request.post(`/api/verses/${original.id}/verify`)).ok()).toBe(true);
    const first = await visit(page, 'Sample Visit To Move', '20261108_move-this.pdf');
    const second = await visit(page, 'Sample Visit To Keep', '20261108_keep-this.pdf');
    for (const document of [first, second]) {
      const [comparison] = await (await page.request.get(`/api/lessons/${document.id}/verse-comparisons`)).json();
      expect(comparison.candidates.some((candidate: any) => candidate.id === original.id)).toBe(true);
      expect((await page.request.post(`/api/lessons/${document.id}/verse-comparisons/${comparison.id}`, { data: { decision: 'existing', verse_id: original.id } })).ok()).toBe(true);
    }
    expect((await page.request.post('/api/lectures', { data: { title: 'An imported verse outline', issue: '', objective: '', verse_ids: [original.id], verse_objectives: [''] } })).ok()).toBe(true);
    const moved = await page.request.post(`/api/lessons/${first.id}/move`, { data: { category: 'weekend' } });
    expect(moved.ok()).toBe(true);
    const records = await allVerses(page);
    expect(records).toHaveLength(2);
    const preserved = records.find((v) => v.id === original.id);
    const copied = records.find((v) => v.id !== original.id);
    expect(preserved).toMatchObject({ text: wording, ocr_raw: original.ocr_raw, status: 'verified', import_source: original.import_source, sources: [{ lesson_id: second.id, pastoral: true }] });
    expect(copied).toMatchObject({ text: wording, ocr_raw: original.ocr_raw, status: 'verified', import_source: '', sources: [{ lesson_id: first.id, pastoral: false }] });
    expect((await (await page.request.get('/api/lectures')).json())[0].verse_ids).toEqual([original.id]);
    expect((await page.request.patch(`/api/verses/${copied.id}`, { data: { text: 'Changed wording' } })).status()).toBe(409);
    await page.goto('/');
    await expect(page.getByTestId('side-lessons-count')).toHaveText('1');
    await expect(page.getByTestId('side-pv-count')).toHaveText('1');
    await expect(page.getByTestId('side-lesson-verses-count')).toHaveText('1');
    await expect(page.getByTestId('side-bibles-count')).toHaveText('1');
    await page.getByTestId('side-lesson-verses').click();
    await expect(page.getByTestId('verse-card')).toHaveAttribute('data-verse-id', copied.id);
    await page.getByTestId('side-bibles').click();
    await expect(page.getByTestId('verse-card')).toHaveAttribute('data-verse-id', original.id);
    expect((await page.request.post(`/api/lessons/${first.id}/move`, { data: { category: 'invalid' } })).status()).toBe(400);
    expect((await page.request.post('/api/lessons/missing/move', { data: { category: 'pastoral' } })).status()).toBe(404);
  });
});
