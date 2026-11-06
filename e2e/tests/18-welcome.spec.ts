import { test, expect } from '../support/fixtures';

/** Other tests start with the welcome turned off; these turn it on. */
async function welcomeOn(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('lv.welcome', 'on'));
  await page.reload();
}

test('the welcome greets, shows what is in the vault, and Skip closes it', async ({ page }) => {
  await welcomeOn(page);
  const welcome = page.getByTestId('welcome');
  await expect(welcome).toBeVisible();
  await expect(welcome).toHaveAccessibleName('Lesson Vault');
  await expect(page.getByTestId('welcome-greeting')).toHaveText(/^Good (morning|afternoon|evening) · Magandang (umaga|hapon|gabi)$/);
  const lessons: any[] = await (await page.request.get('/api/lessons')).json();
  const verses: any[] = await (await page.request.get('/api/verses')).json();
  const visits = lessons.filter((l) => l.category === 'pastoral').length;
  await expect(page.getByTestId('welcome-stat')).toHaveText([String(lessons.length - visits), String(visits), String(verses.length), String(verses.filter((v) => v.status === 'unverified').length)]);
  await expect(page.getByTestId('welcome-enter')).toBeFocused();

  await page.getByTestId('welcome-skip').click();
  await expect(welcome).toHaveCount(0);
  await expect(page.getByTestId('app-shell')).toBeVisible();
});

test('the welcome opens the vault, or goes straight to review, and Escape skips it', async ({ page }) => {
  await welcomeOn(page);
  await page.getByTestId('welcome-enter').click();
  await expect(page.getByTestId('welcome')).toHaveCount(0);
  await expect(page.getByTestId('vault-page')).toBeVisible();

  await page.reload();
  await page.getByTestId('welcome-review').click();
  await expect(page.getByTestId('welcome')).toHaveCount(0);
  await expect(page.getByTestId('review-page')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('welcome')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('welcome')).toHaveCount(0);
});

test('the welcome steps aside by itself unless the pointer rests on it', async ({ page }) => {
  await welcomeOn(page);
  await expect(page.getByTestId('welcome-stats')).toBeVisible();
  // Resting on it holds it open.
  await page.getByTestId('welcome-stats').hover();
  await page.waitForTimeout(10_500);
  await expect(page.getByTestId('welcome')).toBeVisible();
  await page.mouse.move(2, 2);
  await expect(page.getByTestId('welcome')).toHaveCount(0, { timeout: 15_000 });
});

test('the welcome can be turned off there or in Settings, and shown again', async ({ page }) => {
  await welcomeOn(page);
  await page.getByTestId('welcome-remember').uncheck();
  await page.getByTestId('welcome-skip').click();
  await page.reload();
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByTestId('welcome')).toHaveCount(0);

  await page.goto('/settings');
  await expect(page.getByTestId('settings-welcome')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('settings-welcome')).toHaveAccessibleName('Show the welcome screen when the app opens');
  await page.getByTestId('settings-welcome-preview').click();
  await expect(page.getByTestId('welcome')).toBeVisible();
  await page.getByTestId('welcome-skip').click();
  await page.getByTestId('settings-welcome').click();
  await expect(page.getByTestId('settings-welcome')).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await expect(page.getByTestId('welcome')).toBeVisible();
});
