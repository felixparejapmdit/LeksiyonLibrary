import { test, expect, row, assertSmooth, resetPerf } from '../support/fixtures';
import { samples } from '../support/samples';

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the bottom navigation switches every page', async ({ app: page }) => {
    await expect(page.getByTestId('bottom-nav')).toBeVisible();
    await expect(page.getByTestId('sidebar')).toHaveCount(0);
    await resetPerf(page);
    for (const [nav, pageId] of [
      ['nav-bibles', 'bibles-page'],
      ['nav-lecture', 'lecture-page'],
      ['nav-search', 'search-page'],
      ['nav-settings', 'settings-page'],
      ['nav-vault', 'vault-page'],
    ]) {
      await page.getByTestId(nav).click();
      await expect(page.getByTestId(pageId)).toBeVisible();
      await expect(page.getByTestId(nav)).toHaveAttribute('aria-current', 'page');
    }
    await assertSmooth(page, 'phone bottom navigation');
  });

  test('tapping a lesson opens a full-screen viewer, and back returns', async ({ app: page }) => {
    await row(page, samples.en.short).getByTestId('lesson-open').click();
    await expect(page.getByTestId('mobile-viewer')).toBeVisible();
    await expect(page.locator('[data-testid="viewer-canvas"][data-rendered-key]')).toBeVisible();
    await page.getByTestId('viewer-next').click();
    await expect(page.getByTestId('viewer-page')).toHaveText('2 / 6');
    expect((await page.getByTestId('pdf-viewer').boundingBox())!.width).toBeGreaterThan(380);
    await page.getByTestId('viewer-back').click();
    await expect(page.getByTestId('mobile-viewer')).toHaveCount(0);
    await expect(page.getByTestId('list-pane')).toBeVisible();
  });

  test('the folder drawer opens, filters and closes', async ({ app: page }) => {
    await page.getByTestId('open-drawer').click();
    await expect(page.getByTestId('drawer')).toBeVisible();
    await page.getByTestId('year-2026').click();
    await expect(page.getByTestId('drawer')).toHaveCount(0);
    await expect(page.getByTestId('chip-year')).toBeVisible();
    await page.getByTestId('reset-filters').click();
    await page.getByTestId('open-drawer').click();
    await page.getByTestId('drawer-close').click({ position: { x: 20, y: 300 } });
    await expect(page.getByTestId('drawer')).toHaveCount(0);
  });

  test('the search page finds lessons and verses', async ({ app: page }) => {
    await page.getByTestId('nav-search').click();
    await expect(page.getByTestId('search-hint')).toBeVisible();
    const input = page.getByTestId('page-search-input');
    await input.fill(samples.searchWord);
    await expect(page.getByTestId('search-lessons-heading')).toContainText('Lessons (2)');
    await expect(page.getByTestId('search-verse').first()).toContainText(samples.secondRefEn);
    await page.getByTestId('search-verse').first().click();
    await expect(page.getByTestId('vault-page')).toBeVisible();
    await expect(page.getByTestId('chip-verse')).toBeVisible();
    await page.getByTestId('reset-filters').click();

    await page.getByTestId('nav-search').click();
    await input.fill('nomatchhere');
    await expect(page.getByTestId('search-none')).toBeVisible();
    await page.getByTestId('page-search-clear').click();
    await input.fill('Sampleday');
    await page.getByTestId('lesson-open').first().click();
    await expect(page.getByTestId('vault-page')).toBeVisible();
    await page.getByTestId('reset-filters').click();
  });
});

test.describe('installable app', () => {
  test.use({ serviceWorkers: 'allow' });

  test('manifest and icons are valid', async ({ page }) => {
    await page.goto('/');
    const href = await page.locator('link[rel=manifest]').getAttribute('href');
    const m = await (await page.request.get(href!)).json();
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/');
    for (const size of ['192x192', '512x512']) expect(m.icons.some((i: any) => i.sizes === size)).toBe(true);
    expect(m.icons.some((i: any) => i.purpose === 'maskable')).toBe(true);
    for (const i of m.icons) {
      const res = await page.request.get(i.src);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toBe('image/png');
    }
  });

  test('the service worker serves the shell offline and never stores lesson data', async ({ page, context, errors }) => {
    await page.goto('/');
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.waitForTimeout(500);
    const cached: string[] = await page.evaluate(async () => {
      const out: string[] = [];
      for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) out.push(new URL(req.url).pathname);
      return out;
    });
    expect(cached).toContain('/');
    expect(cached.some((u) => u.startsWith('/assets/'))).toBe(true);
    expect(cached.filter((u) => u.startsWith('/api/'))).toEqual([]);

    // A stale offline copy is replaced by the next successful load.
    await page.evaluate(async () => {
      const cache = await caches.open((await caches.keys())[0]);
      await cache.put('/', new Response('STALE', { headers: { 'Content-Type': 'text/html' } }));
    });
    await page.reload();
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await (await caches.match('/'))!.text()).includes('STALE'))).toBe(false);

    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('#root')).toBeAttached();
    expect(await page.title()).toBe('Lesson Vault');
    // Offline shows the current app's message, never an old sign-in page.
    await expect(page.getByTestId('boot-error')).toBeVisible();
    await expect(page.getByRole('heading', { name: /sign in/i })).toHaveCount(0);
    await context.setOffline(false);
    // Offline API failures are the expected condition for this test.
    errors.length = 0;
  });
});
