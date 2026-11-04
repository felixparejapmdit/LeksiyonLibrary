import type { Page } from '@playwright/test';
import { test, expect, row, assertSmooth, resetPerf, watchFrames, withEmptyVault } from '../support/fixtures';
import { samples } from '../support/samples';
import { makePdf } from '../support/pdf';

const rendered = (page: Page) => page.locator('[data-testid="viewer-canvas"][data-rendered-key]');

test('page navigation works, with buttons disabled at the ends', async ({ app: page }) => {
  await row(page, samples.en.row).getByTestId('lesson-open').click();
  await expect(page.getByTestId('viewer-page')).toHaveText('1 / 6');
  await expect(rendered(page)).toBeVisible();
  await expect(page.getByTestId('viewer-prev')).toBeDisabled();
  await page.getByTestId('viewer-next').click();
  await expect(page.getByTestId('viewer-page')).toHaveText('2 / 6');
  await page.getByTestId('viewer-prev').click();
  await expect(page.getByTestId('viewer-page')).toHaveText('1 / 6');
  for (let i = 0; i < 5; i++) await page.getByTestId('viewer-next').click();
  await expect(page.getByTestId('viewer-page')).toHaveText('6 / 6');
  await expect(page.getByTestId('viewer-next')).toBeDisabled();
});

test('a scanned page really renders non-blank content', async ({ app: page }) => {
  await row(page, samples.en.row).getByTestId('lesson-open').click();
  await expect(rendered(page)).toBeVisible();
  const stats = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="viewer-canvas"]') as HTMLCanvasElement;
    const p = document.createElement('canvas');
    p.width = 100;
    p.height = 150;
    const x = p.getContext('2d')!;
    x.drawImage(c, 0, 0, 100, 150);
    const d = x.getImageData(0, 0, 100, 150).data;
    let dark = 0;
    let light = 0;
    for (let i = 0; i < d.length; i += 4) d[i] < 200 ? dark++ : light++;
    return { dark, light };
  });
  expect(stats.dark, 'text pixels').toBeGreaterThan(100);
  expect(stats.light, 'paper pixels').toBeGreaterThan(5000);
});

test('zoom, fit and rotate respond immediately and never blank the page', async ({ app: page }) => {
  await row(page, samples.en.row).getByTestId('lesson-open').click();
  await expect(rendered(page)).toBeVisible();
  const zoom = page.getByTestId('viewer-zoom');
  const fit = await zoom.textContent();
  await resetPerf(page);
  const frames = await watchFrames(page, async () => {
    for (let i = 0; i < 4; i++) await page.getByTestId('viewer-zoom-in').click();
    await page.waitForTimeout(250);
    for (let i = 0; i < 4; i++) await page.getByTestId('viewer-zoom-out').click();
    await page.waitForTimeout(250);
    await page.getByTestId('viewer-rotate').click();
    await page.waitForTimeout(250);
    await page.getByTestId('viewer-rotate').click();
    await page.getByTestId('viewer-rotate').click();
    await page.getByTestId('viewer-rotate').click();
    await page.getByTestId('viewer-fit').click();
    await page.waitForTimeout(250);
  });
  await expect(zoom).toHaveText(fit!);
  expect(frames.frames, 'frames observed').toBeGreaterThan(30);
  expect(frames.blankCanvas, 'frames with a blank PDF').toBe(0);
  await assertSmooth(page, 'viewer zoom and rotate');
});

test('zoom has limits, and on-screen size updates in the same step', async ({ app: page }) => {
  await row(page, samples.en.row).getByTestId('lesson-open').click();
  await expect(rendered(page)).toBeVisible();
  const canvas = page.getByTestId('viewer-canvas');
  const w0 = (await canvas.boundingBox())!.width;
  await page.getByTestId('viewer-zoom-in').click();
  expect((await canvas.boundingBox())!.width).toBeGreaterThan(w0);
  for (let i = 0; i < 30 && (await page.getByTestId('viewer-zoom-in').isEnabled()); i++) await page.getByTestId('viewer-zoom-in').click();
  await expect(page.getByTestId('viewer-zoom')).toHaveText('300%');
  await expect(page.getByTestId('viewer-zoom-in')).toBeDisabled();
  for (let i = 0; i < 30 && (await page.getByTestId('viewer-zoom-out').isEnabled()); i++) await page.getByTestId('viewer-zoom-out').click();
  await expect(page.getByTestId('viewer-zoom')).toHaveText('50%');
  await expect(page.getByTestId('viewer-zoom-out')).toBeDisabled();
  await page.getByTestId('viewer-fit').click();
});

test('flipping pages and switching lessons never shows a blank canvas', async ({ app: page }) => {
  await row(page, samples.en.row).getByTestId('lesson-open').click();
  await expect(rendered(page)).toBeVisible();
  await resetPerf(page);
  const frames = await watchFrames(page, async () => {
    for (let i = 0; i < 5; i++) {
      await page.getByTestId('viewer-next').click();
      await page.waitForTimeout(60);
    }
    for (let i = 0; i < 5; i++) {
      await page.getByTestId('viewer-prev').click();
      await page.waitForTimeout(60);
    }
    for (const t of [samples.tl.short, 'Sampleday', samples.en.short, 'Halimbawa ng Pagbabantay']) {
      await row(page, t).getByTestId('lesson-open').click();
      await page.waitForTimeout(150);
    }
  });
  expect(frames.blankCanvas).toBe(0);
  expect(frames.emptyMain).toBe(0);
  expect(frames.headerLost).toBe(0);
  await assertSmooth(page, 'page flips and lesson switching');
});

test('the Tagalog/English button jumps to the paired lesson', async ({ app: page }) => {
  await row(page, samples.en.row).getByTestId('lesson-open').click();
  const pair = page.getByTestId('viewer-counterpart');
  await expect(pair).toContainText('Tagalog');
  await pair.click();
  await expect(page.locator('[data-testid="lesson-row"][data-selected="true"]')).toContainText(samples.tl.short);
  await expect(pair).toContainText('English');
  await pair.click();
  await expect(page.locator('[data-testid="lesson-row"][data-selected="true"]')).toContainText(samples.en.short);
});

test('switching lessons shows the new lesson, even when its PDF is slow to load', async ({ page }) => {
  await withEmptyVault(page, async () => {
    const upload = async (name: string, text: string) => {
      const res = await page.request.post('/api/lessons', {
        multipart: { source_kind: 'text', pages: JSON.stringify([`Paksa: ${text}`]), file: { name, mimeType: 'application/pdf', buffer: makePdf([[text]]) } },
      });
      expect(res.ok()).toBeTruthy();
      return (await res.json()).lesson;
    };
    const first = await upload('first.pdf', 'First lesson with its own words');
    const second = await upload('second.pdf', 'Second lesson that looks different on the page');
    const showing = (id: string) => page.locator(`[data-testid="viewer-canvas"][data-rendered-key*="${id}"]`);
    const pixels = () => page.getByTestId('viewer-canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL());

    await page.goto('/');
    await page.locator(`[data-lesson-id="${first.id}"]`).getByTestId('lesson-open').click();
    await expect(showing(first.id)).toBeVisible();
    const firstPixels = await pixels();

    // Slower than the viewer's render delay, as a real scanned PDF is.
    await page.route(`**/api/lessons/${second.id}/file`, async (route) => {
      await new Promise((r) => setTimeout(r, 500));
      await route.continue();
    });
    await page.locator(`[data-lesson-id="${second.id}"]`).getByTestId('lesson-open').click();
    await expect(page.getByTestId('pdf-viewer')).toHaveAttribute('data-lesson', second.id);
    await expect(showing(second.id)).toBeVisible();
    await page.waitForTimeout(800);
    const secondPixels = await pixels();
    expect(secondPixels, 'the viewer must not keep showing the previous lesson').not.toBe(firstPixels);

    // Going back and forth must keep each lesson's own pages.
    await page.locator(`[data-lesson-id="${first.id}"]`).getByTestId('lesson-open').click();
    await expect(showing(first.id)).toBeVisible();
    await page.waitForTimeout(150);
    expect(await pixels()).toBe(firstPixels);
    await page.locator(`[data-lesson-id="${second.id}"]`).getByTestId('lesson-open').click();
    await expect(showing(second.id)).toBeVisible();
    await page.waitForTimeout(150);
    expect(await pixels()).toBe(secondPixels);
  });
});

test('open in new tab serves the actual PDF', async ({ app: page }) => {
  await row(page, 'Sampleday').getByTestId('lesson-open').click();
  const link = page.getByTestId('viewer-open');
  const res = await page.request.get((await link.getAttribute('href'))!);
  expect(res.headers()['content-type']).toBe('application/pdf');
  expect((await res.body()).subarray(0, 5).toString()).toBe('%PDF-');
  const [popup] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
  await popup.close();
});
