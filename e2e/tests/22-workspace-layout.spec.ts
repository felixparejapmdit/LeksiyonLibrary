import type { Page } from '@playwright/test';
import { test, expect, setAiMode, withEmptyVault } from '../support/fixtures';
import { makePdf } from '../support/pdf';
import { xlsx } from '../support/xlsx';

// This suite uses invented lessons and wording, never private PDFs or the live vault.
async function seedWorkspace(page: Page) {
  const saved = [];
  for (const pastoral of [false, true]) {
    const lines = [
      'Saturday/Sunday: November 7/8, 2026',
      `Paksa: Zephyrspacing ${pastoral ? 'Visit' : 'Lesson'}`,
      'PASIMULA:',
      `1. Ang mga bantay ..........Genesis 6:${pastoral ? '20' : '9'} T4T`,
      `${pastoral ? '20' : '9'}Ang mga bantay ay handa sa pintuan ng bayan, zephyrspacing.`,
      ...(pastoral ? ['SAMPLE LOCAL, SAMPLE DISTRICT'] : []),
    ];
    const result = await page.request.post('/api/lessons', { multipart: {
      source_kind: 'text',
      ...(pastoral ? { category: 'pastoral' } : {}),
      pages: JSON.stringify([lines.join('\n')]),
      file: { name: pastoral ? '20261108_layout-visit.pdf' : 'layout-lesson.pdf', mimeType: 'application/pdf', buffer: makePdf([lines]) },
    } });
    expect(result.ok()).toBe(true);
    saved.push((await result.json()).lesson);
  }
  const imported = await page.request.post('/api/verses/import', { multipart: {
    commit: '1',
    file: { name: 'layout-verses.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsx([
      ['Translation', 'Book', 'Chapter', 'Verse', 'Content'],
      ['T4T', 'Genesis', '6', '8', '8Ang mga bantay ay nananatiling handa, zephyrspacing.'],
    ]) },
  } });
  expect(imported.ok()).toBe(true);
  return saved;
}

async function expectContained(page: Page, label: string) {
  const problems = await page.evaluate(() => {
    const issues: string[] = [];
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) issues.push('The page scrolls sideways.');
    const localScrollers = '[data-testid="category-tabs"], [data-testid="lesson-year-tabs"], [data-testid="pv-year-tabs"], [data-testid="objective-tabs"], [data-testid="viewer-scroll"], [data-testid="bibles-table"]';
    for (const element of document.querySelectorAll<HTMLElement>('main h1, main button, main select, main input:not([type="file"]):not([type="hidden"]), main textarea')) {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height || element.closest(localScrollers)) continue;
      if (rect.left < -1 || rect.right > innerWidth + 1) issues.push(`${element.dataset.testid || element.tagName} extends beyond the screen.`);
    }
    return issues;
  });
  expect(problems, label).toEqual([]);
}

async function openScope(page: Page, scope: 'all' | 'lessons' | 'pv', width: number) {
  if (width < 1024) await page.getByTestId('open-drawer').click();
  await page.getByTestId(`side-${scope}`).click();
}

const widths = [360, 768, 1024, 1440];
const routes = [
  ['/', 'vault-page'],
  ['/bibles', 'bibles-page'],
  ['/lesson-verses', 'bibles-page'],
  ['/lecture', 'lecture-page'],
  ['/settings', 'settings-page'],
  ['/search', 'search-page'],
  ['/import', 'import-page'],
  ['/review', 'review-page'],
] as const;

for (const theme of ['dark', 'light'] as const) {
  test(`${theme} workspace surfaces and page controls fit desktop, tablet, and phone`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript((value) => {
      localStorage.setItem('lv.theme', value);
      localStorage.setItem('lv.viewer', '1');
    }, theme);
    await withEmptyVault(page, async () => {
      await seedWorkspace(page);
      for (const width of widths) {
        await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
        for (const [route, id] of routes) {
          await page.goto(route);
          await expect(page.getByTestId(id)).toBeVisible();
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          await expectContained(page, `${theme} ${route} at ${width}px`);
          const background = await page.getByTestId('app-main').evaluate((element) => getComputedStyle(element).backgroundImage);
          expect(background, 'the workspace has the requested static grid and soft glow').toContain('linear-gradient');
          expect(background).toContain('radial-gradient');
          if (route === '/bibles' && width === 360) {
            const title = (await page.getByTestId('bibles-title').boundingBox())!;
            const action = (await page.getByTestId('bibles-import').boundingBox())!;
            expect(Math.abs(title.x - action.x), 'the wrapped header action lines up with its title').toBeLessThanOrEqual(2);
            expect(action.y).toBeGreaterThanOrEqual(title.y + title.height);
          }
        }

        await page.goto('/');
        for (const [scope, title] of [['all', 'All Archives'], ['lessons', 'Lesson Library'], ['pv', 'Pastoral Visits']] as const) {
          await openScope(page, scope, width);
          await expect(page.getByTestId('list-title')).toHaveText(title);
          const clipped = await page.getByTestId('list-title').evaluate((element) => element.scrollWidth > element.clientWidth + 1);
          expect(clipped, `${title} is readable at ${width}px`).toBe(false);
          await expectContained(page, `${theme} ${title} at ${width}px`);
        }
      }
    });
  });

  test(`${theme} dialogs stay inside the screen and lecture paper stays plain`, async ({ page }) => {
    await setAiMode('good');
    await page.addInitScript((value) => localStorage.setItem('lv.theme', value), theme);
    await withEmptyVault(page, async () => {
      const [lesson] = await seedWorkspace(page);
      for (const width of [360, 1024]) {
        const height = 900;
        await page.setViewportSize({ width, height });
        await page.goto('/');
        await page.locator(`[data-testid="lesson-row"][data-lesson-id="${lesson.id}"]`).getByTestId('lesson-edit').click();
        const dialog = page.getByTestId('edit-dialog');
        await expect(dialog).toBeVisible();
        const rect = (await dialog.boundingBox())!;
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(width);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.y + rect.height).toBeLessThanOrEqual(height);
        await expect(page.getByTestId('edit-save')).toBeInViewport();
        await page.getByTestId('edit-cancel').click();
      }

      await page.goto('/lecture');
      await page.getByTestId('lecture-issue').fill('zephyrspacing');
      await page.getByTestId('lecture-suggest').click();
      await expect(page.getByTestId('suggestion-add').first()).toBeVisible();
      await page.getByTestId('suggestion-add').first().click();
      await page.getByTestId('lecture-title').fill('A clear layout preview');
      await page.getByTestId('lecture-preview').click();
      const paper = page.getByTestId('preview-dialog').locator('.lecture-paper');
      await expect(paper).toBeVisible();
      expect(await paper.evaluate((element) => getComputedStyle(element).backgroundImage)).toBe('none');
      expect(await paper.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)');
      await page.emulateMedia({ media: 'print' });
      await expect(page.getByTestId('print-doc')).toBeVisible();
      expect(await page.getByTestId('print-doc').evaluate((element) => getComputedStyle(element).backgroundImage)).toBe('none');
      expect(await page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)');
      await page.emulateMedia({ media: 'screen' });
      await page.getByTestId('preview-close').click();
    });
  });
}
