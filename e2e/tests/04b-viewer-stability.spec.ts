import { test, expect, withEmptyVault } from '../support/fixtures';
import { makePdf } from '../support/pdf';

// Headless Chromium hides scrollbars by default, which would hide this bug class.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

const SAMPLE_FRAMES = 30;

/** Counts how many times the page's on-screen size changes while nothing is being touched. */
async function sizeChangesWhileIdle(page: import('@playwright/test').Page) {
  return page.evaluate(
    (frames) =>
      new Promise<{ changes: number; widths: number[] }>((resolve) => {
        const canvas = document.querySelector('[data-testid="viewer-canvas"]') as HTMLElement;
        const widths = new Set<number>();
        let last = canvas.getBoundingClientRect().width;
        widths.add(last);
        let changes = 0;
        let n = 0;
        const tick = () => {
          const w = canvas.getBoundingClientRect().width;
          if (w !== last) {
            changes++;
            last = w;
            widths.add(w);
          }
          if (++n >= frames) resolve({ changes, widths: [...widths] });
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    SAMPLE_FRAMES,
  );
}

test('the page never shakes at any window size when scrollbars are visible', async ({ page }) => {
  test.setTimeout(170_000);
  await withEmptyVault(page, async () => {
    const res = await page.request.post('/api/lessons', {
      multipart: {
        source_kind: 'text',
        pages: JSON.stringify(['Paksa: Stability Lesson']),
        file: { name: 'stability.pdf', mimeType: 'application/pdf', buffer: makePdf([['Stability lesson body']]) },
      },
    });
    expect(res.ok()).toBeTruthy();
    await page.goto('/');
    await expect(page.locator('[data-testid="viewer-canvas"][data-rendered-key]')).toBeVisible();

    const shaking: string[] = [];
    // The loop only exists when page height nearly equals pane height, so sweep finely across that band.
    for (const width of [1100, 1440, 1920]) {
      for (let height = 700; height <= 1000; height += 6) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(120); // Let resize settle: only sustained movement counts.
        const { changes, widths } = await sizeChangesWhileIdle(page);
        if (changes > 0) shaking.push(`${width}x${height}: ${changes} size changes between ${widths.join(' and ')} px`);
      }
    }
    expect(shaking, 'window sizes where the idle page keeps changing size').toEqual([]);
  });
});

test('the viewer does not trigger a horizontal scrollbar in fit mode', async ({ page }) => {
  await withEmptyVault(page, async () => {
    await page.request.post('/api/lessons', {
      multipart: {
        source_kind: 'text',
        pages: JSON.stringify(['Paksa: Fit Lesson']),
        file: { name: 'fit.pdf', mimeType: 'application/pdf', buffer: makePdf([['Fit lesson body']]) },
      },
    });
    await page.goto('/');
    await expect(page.locator('[data-testid="viewer-canvas"][data-rendered-key]')).toBeVisible();
    const scroller = page.getByTestId('viewer-scroll');
    for (const width of [1100, 1300, 1440, 1601, 1920, 2558]) {
      await page.setViewportSize({ width, height: 850 });
      await page.waitForTimeout(120);
      const overflow = await scroller.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow, `sideways overflow at ${width}`).toBeLessThanOrEqual(0);
    }
  });
});
