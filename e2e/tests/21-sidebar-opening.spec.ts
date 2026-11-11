import type { Page } from '@playwright/test';
import { test, expect, withEmptyVault } from '../support/fixtures';
import { makePdf } from '../support/pdf';

type Library = 'pastoral' | 'lessons';
const sidebarPrefix = (library: Library) => library === 'pastoral' ? 'pv-' : '';

// Each year deliberately has a more recent PDF than the target, so selecting a
// folder's first result cannot accidentally satisfy the viewer assertions.
async function seed(page: Page, library: Library) {
  const label = library === 'pastoral' ? 'Pastoral' : 'Lesson';
  const definitions = [
    { title: `${label} Earlier Target`, date: 'January 10/11, 2021', name: `${label}-earlier.pdf` },
    { title: `${label} Later Neighbor`, date: 'December 25/26, 2021', name: `${label}-neighbor.pdf` },
    { title: `${label} Recent Selection`, date: 'April 4/5, 2026', name: `${label}-recent.pdf` },
  ];
  const saved = [];
  for (const definition of definitions) {
    const pages = [[`Saturday/Sunday: ${definition.date}`, `Paksa: ${definition.title}`, 'PASIMULA:', 'Talata: Juan 3:5 NIRV']];
    const response = await page.request.post('/api/lessons', {
      multipart: {
        source_kind: 'text',
        pages: JSON.stringify(pages.map((lines) => lines.join('\n'))),
        ...(library === 'pastoral' ? { category: 'pastoral' } : {}),
        file: { name: definition.name, mimeType: 'application/pdf', buffer: makePdf(pages) },
      },
    });
    expect(response.ok()).toBe(true);
    saved.push((await response.json()).lesson);
  }
  return saved[0];
}

async function expectTargetPdf(page: Page, target: { id: string; title: string }) {
  const viewer = page.getByTestId('pdf-viewer');
  await expect(viewer).toBeVisible();
  await expect(viewer).toHaveAttribute('data-lesson', target.id);
  await expect(viewer.getByTestId('viewer-open')).toHaveAttribute('href', `/api/lessons/${target.id}/file`);
  const canvas = viewer.getByTestId('viewer-canvas');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('aria-label', `Page 1 of ${target.title}`);
  await expect(canvas).toHaveAttribute('data-rendered-key', new RegExp(`${target.id}/file\\|1\\|`));
}

test.describe('year-folder PDF opening on desktop', () => {
  for (const library of ['pastoral', 'lessons'] as const) {
    for (const entry of ['all archives', 'its library', 'Verse Library'] as const) {
      test(`${library} child reopens a hidden viewer from ${entry}`, async ({ page }) => {
        await withEmptyVault(page, async () => {
          const target = await seed(page, library);
          await page.addInitScript(() => localStorage.setItem('lv.viewer', '0'));
          await page.goto('/');
          if (entry === 'its library') await page.getByTestId(library === 'pastoral' ? 'side-pv' : 'side-lessons').click();
          if (entry === 'Verse Library') {
            await page.getByTestId('side-bibles').click();
            await expect(page.getByTestId('bibles-page')).toBeVisible();
          }
          await expect(page.getByTestId('pdf-viewer')).toHaveCount(0);
          await page.getByTestId(`${sidebarPrefix(library)}year-expand-2021`).click();
          await page.getByTestId('tree-lesson').filter({ hasText: target.title }).click();
          await expect(page.getByTestId('list-title')).toHaveText(library === 'pastoral' ? 'Pastoral Visits' : 'Lesson Library');
          await expectTargetPdf(page, target);
          await expect(page.getByTestId('lesson-row').filter({ hasText: target.title })).toHaveAttribute('data-selected', 'true');
          if (entry === 'its library') {
            await page.getByTestId('toggle-viewer').click();
            await expect(page.getByTestId('pdf-viewer')).toHaveCount(0);
            await page.getByTestId('tree-lesson').filter({ hasText: target.title }).click();
            await expectTargetPdf(page, target);
          }
        });
      });
    }
  }
});

test.describe('year-folder PDF opening on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  for (const library of ['pastoral', 'lessons'] as const) {
    test(`${library} drawer child opens the selected PDF full screen`, async ({ page }) => {
      await withEmptyVault(page, async () => {
        const target = await seed(page, library);
        await page.addInitScript(() => localStorage.setItem('lv.viewer', '0'));
        await page.goto('/');
        await page.getByTestId('open-drawer').click();
        await page.getByTestId(`${sidebarPrefix(library)}year-expand-2021`).click();
        await page.getByTestId('tree-lesson').filter({ hasText: target.title }).click();
        await expect(page.getByTestId('drawer')).toHaveCount(0);
        await expect(page.getByTestId('mobile-viewer')).toBeVisible();
        await expectTargetPdf(page, target);
        await page.getByTestId('viewer-back').click();
        await expect(page.getByTestId('mobile-viewer')).toHaveCount(0);
        await expect(page.getByTestId('lesson-row').filter({ hasText: target.title })).toHaveAttribute('data-selected', 'true');
        // Opening the same selected PDF again must be an action of its own.
        await page.getByTestId('open-drawer').click();
        await page.getByTestId(`${sidebarPrefix(library)}year-expand-2021`).click();
        await page.getByTestId('tree-lesson').filter({ hasText: target.title }).click();
        await expect(page.getByTestId('mobile-viewer')).toBeVisible();
        await expectTargetPdf(page, target);
      });
    });
  }
});
