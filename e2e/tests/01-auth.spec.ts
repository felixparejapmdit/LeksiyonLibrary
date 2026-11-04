import { test, expect } from '../support/fixtures';

test('the app opens straight to the dashboard with no sign-in', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByTestId('vault-page')).toBeVisible();
  await expect(page.getByTestId('empty-vault')).toBeVisible();
  await expect(page.getByRole('heading', { name: /sign in|create your account/i })).toHaveCount(0);
});

test('every page opens directly, including after a reload', async ({ page }) => {
  for (const [path, id] of [['/', 'vault-page'], ['/bibles', 'bibles-page'], ['/lecture', 'lecture-page'], ['/settings', 'settings-page']]) {
    await page.goto(path);
    await expect(page.getByTestId(id)).toBeVisible();
    await page.reload();
    await expect(page.getByTestId(id)).toBeVisible();
  }
});

test('settings has no account or sign-out controls', async ({ app: page }) => {
  await page.goto('/settings');
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await expect(page.getByRole('button', { name: /sign out/i })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Account' })).toHaveCount(0);
});

test('the old sign-in routes are gone', async ({ page }) => {
  for (const path of ['/api/auth/login', '/api/auth/register', '/api/auth/logout']) {
    expect((await page.request.post(path, { data: {} })).status(), path).toBe(404);
  }
  expect((await page.request.get('/api/auth/me')).status()).toBe(404);
});

test('if the server cannot be reached the app says so, then recovers', async ({ page, errors }) => {
  await page.route('**/api/lessons', (route) => route.abort());
  await page.goto('/');
  await expect(page.getByTestId('boot-error')).toBeVisible();
  await expect(page.getByTestId('empty-vault')).toHaveCount(0);
  await page.unroute('**/api/lessons');
  await page.getByTestId('boot-retry').click();
  await expect(page.getByTestId('app-shell')).toBeVisible();
  errors.length = 0;
});
