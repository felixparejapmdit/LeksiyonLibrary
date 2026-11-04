import { test, expect, row, resetPerf, assertSmooth, withEmptyVault } from '../support/fixtures';
import { makePdf } from '../support/pdf';

const VIEWPORTS = [
  { name: 'small phone', width: 360, height: 740, touch: true },
  { name: 'phone', width: 390, height: 844, touch: true },
  { name: 'tablet portrait', width: 768, height: 1024, touch: true },
  { name: 'tablet landscape', width: 1024, height: 768, touch: false },
  { name: 'laptop', width: 1280, height: 800, touch: false },
  { name: 'desktop', width: 1440, height: 900, touch: false },
  { name: 'recording size', width: 2558, height: 1314, touch: false },
];

const ROUTES = [
  ['/', 'vault-page'],
  ['/bibles', 'bibles-page'],
  ['/lecture', 'lecture-page'],
  ['/settings', 'settings-page'],
  ['/search', 'search-page'],
];

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name} ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('no overflow, nothing clipped, targets large enough, right navigation', async ({ app: page }) => {
      for (const [path, id] of ROUTES) {
        await page.goto(path);
        await expect(page.getByTestId(id)).toBeVisible();
        const problems = await page.evaluate(
          ({ minTarget }) => {
            const out: string[] = [];
            const root = document.documentElement;
            if (root.scrollWidth > root.clientWidth) out.push(`page scrolls sideways: ${root.scrollWidth} > ${root.clientWidth}`);
            for (const el of Array.from(document.querySelectorAll<HTMLElement>('button, a[href], select, input:not([type=file]), textarea'))) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              const name = el.dataset.testid ?? el.outerHTML.slice(0, 60);
              const insideScroller = !!el.closest('[data-testid="category-tabs"], [data-testid="viewer-scroll"]');
              if (!insideScroller && (r.right > window.innerWidth + 1 || r.left < -1)) out.push(`off-screen: ${name}`);
              if (minTarget && (r.height < minTarget || r.width < minTarget)) out.push(`small target ${Math.round(r.width)}x${Math.round(r.height)}: ${name}`);
            }
            return out;
          },
          { minTarget: vp.touch ? 40 : 0 },
        );
        expect(problems, `${path} at ${vp.name}`).toEqual([]);
      }
      const desktop = vp.width >= 1024;
      await page.goto('/');
      await expect(page.getByTestId('list-pane')).toBeVisible();
      if (desktop) await expect(page.getByTestId('bottom-nav')).toBeHidden();
      else await expect(page.getByTestId('bottom-nav')).toBeVisible();
      await expect(page.getByTestId('sidebar')).toHaveCount(desktop ? 1 : 0);
      // Desktop-only header controls must really be gone on smaller screens.
      for (const id of ['toggle-sidebar', 'header-settings']) {
        if (desktop) await expect(page.getByTestId(id)).toBeVisible();
        else await expect(page.getByTestId(id)).toBeHidden();
      }
      if (vp.width >= 1280) await expect(page.getByTestId('header-backup')).toBeVisible();
      else await expect(page.getByTestId('header-backup')).toBeHidden();
      // Lesson titles must stay readable on every screen.
      const title = page.getByTestId('lesson-title').first();
      const width = (await title.boundingBox())!.width;
      expect(width, 'lesson title width').toBeGreaterThan(Math.min(200, vp.width * 0.5));
    });

    test('dialogs fit the screen', async ({ app: page }) => {
      await page.getByTestId('header-upload').click();
      const box = (await page.getByTestId('upload-dialog').boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
      await page.getByTestId('upload-done').click();
      await row(page, 'Sampleday').getByTestId('lesson-edit').click();
      const edit = (await page.getByTestId('edit-dialog').boundingBox())!;
      expect(edit.y + edit.height).toBeLessThanOrEqual(vp.height);
      await expect(page.getByTestId('edit-save')).toBeInViewport();
      await page.getByTestId('edit-cancel').click();
    });
  });
}

test('resizing across the desktop breakpoint swaps layouts cleanly', async ({ app: page }) => {
  for (const width of [1440, 900, 500, 1100, 360, 1440]) {
    await page.setViewportSize({ width, height: 850 });
    await expect(page.getByTestId('list-pane')).toBeVisible();
    await expect(page.getByTestId('sidebar')).toHaveCount(width >= 1024 ? 1 : 0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow, `sideways scroll at ${width}`).toBe(false);
  }
});

test('walking through the whole app stays within performance budgets', async ({ app: page }) => {
  await resetPerf(page);
  for (let round = 0; round < 3; round++) {
    await page.getByTestId('side-bibles').click();
    await expect(page.getByTestId('bibles-page')).toBeVisible();
    await page.getByTestId('side-lecture').click();
    await expect(page.getByTestId('lecture-page')).toBeVisible();
    await page.getByTestId('header-settings').click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await page.getByTestId('brand').click();
    await expect(page.getByTestId('vault-page')).toBeVisible();
    await page.getByTestId('header-upload').click();
    await page.getByTestId('upload-done').click();
  }
  await assertSmooth(page, 'full app walk');
});

test('a large library of 400 lessons stays responsive', async ({ page }) => {
  test.setTimeout(180_000);
  await withEmptyVault(page, async () => {
    for (let i = 0; i < 400; i++) {
      const res = await page.request.post('/api/lessons', {
        multipart: {
          source_kind: 'text',
          pages: JSON.stringify([
            `Saturday/Sunday: July ${(i % 27) + 1}/${(i % 27) + 2}, ${2000 + (i % 26)}\nPaksa: Scale Lesson Number ${i}\nBody text ${i}\nTalata: Juan ${(i % 21) + 1}:${(i % 20) + 1}\nTalata: Mateo ${(i % 28) + 1}:${(i % 20) + 1}`,
          ]),
          file: { name: `scale-${i}.pdf`, mimeType: 'application/pdf', buffer: makePdf([[`Scale lesson ${i}`]]) },
        },
      });
      expect(res.ok()).toBeTruthy();
    }
    await page.goto('/');
    await expect(page.getByTestId('item-count')).toHaveText('400 items');
    await resetPerf(page);
    await page.getByTestId('tab-midweek').click();
    await expect(page.getByTestId('item-count')).toHaveText('0 items');
    await page.getByTestId('tab-all').click();
    await expect(page.getByTestId('item-count')).toHaveText('400 items');
    await page.getByTestId('sort-select').selectOption('title');
    await page.getByTestId('search-input').pressSequentially('number 39', { delay: 15 });
    await expect(page.getByTestId('search-count')).toContainText('of 400');
    await page.getByTestId('search-clear').click();
    await page.getByTestId('lesson-open').nth(5).click();
    await page.getByTestId('list-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await page.getByTestId('side-bibles').click();
    await expect(page.getByTestId('bibles-page')).toBeVisible();
    await page.getByTestId('brand').click();
    await assertSmooth(page, 'large library (400 lessons)');
  });
});
