import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import type { Page } from '@playwright/test';
import { test, expect, row, watchFrames, TEST_PASSPHRASE } from '../support/fixtures';
import { samples } from '../support/samples';

test.describe.configure({ mode: 'serial' });
let backupPath = '';

test('theme toggles without flashing and survives reload', async ({ app: page }) => {
  await page.goto('/settings');
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await page.getByTestId('settings-light').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByTestId('settings-light')).toHaveAttribute('aria-pressed', 'true');

  // The very first paint after a reload must already be light.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      (window as any).__themeAtDom = document.documentElement.dataset.theme;
      (window as any).__bgAtDom = getComputedStyle(document.documentElement).backgroundColor;
    });
  });
  await page.reload();
  await expect(page.getByTestId('settings-page')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__themeAtDom)).toBe('light');
  expect(await page.evaluate(() => (window as any).__bgAtDom)).toBe('rgb(248, 250, 252)');

  const frames = await watchFrames(page, async () => {
    await page.getByTestId('theme-toggle').click();
    await page.waitForTimeout(150);
    await page.getByTestId('theme-toggle').click();
    await page.waitForTimeout(150);
    await page.getByTestId('settings-dark').click();
    await page.waitForTimeout(100);
  });
  expect(frames.emptyMain).toBe(0);
  expect(frames.shellLost).toBe(0);
  expect(frames.bgChanges).toBe(3);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('settings shows data and AI status', async ({ app: page }) => {
  await page.goto('/settings');
  await expect(page.getByTestId('settings-stats')).toContainText('5 lessons');
  await expect(page.getByTestId('settings-stats')).toContainText('1 verified');
  await expect(page.getByTestId('settings-ai')).toContainText('Connected to local model');
});

async function downloadBackup(page: Page, opener: string) {
  await page.getByTestId(opener).click();
  await page.getByTestId('backup-passphrase').fill(TEST_PASSPHRASE);
  await page.getByTestId('backup-passphrase-again').fill(TEST_PASSPHRASE);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('backup-save').click()]);
  await expect(page.getByTestId('toast').filter({ hasText: 'Encrypted backup downloaded' })).toBeVisible();
  return dl;
}

async function chooseRestore(page: Page, opener: string, file: Parameters<import('@playwright/test').FileChooser['setFiles']>[0]) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId(opener).click()]);
  await chooser.setFiles(file);
}

test('a backup needs a confirmed passphrase of a sensible length', async ({ app: page }) => {
  await page.getByTestId('header-backup').click();
  await expect(page.getByTestId('backup-warning')).toContainText('cannot be opened by anyone');
  await expect(page.getByTestId('backup-save')).toBeDisabled();
  await page.getByTestId('backup-passphrase').fill('too short');
  await expect(page.getByTestId('backup-hint')).toContainText('more characters needed');
  await expect(page.getByTestId('backup-save')).toBeDisabled();
  await page.getByTestId('backup-passphrase').fill(TEST_PASSPHRASE);
  await page.getByTestId('backup-passphrase-again').fill('something else entirely');
  await expect(page.getByTestId('backup-hint')).toContainText('do not match');
  await expect(page.getByTestId('backup-save')).toBeDisabled();
  await page.getByTestId('backup-cancel').click();
  await expect(page.getByTestId('backup-dialog')).toHaveCount(0);
  await page.getByTestId('header-backup').click();
  await page.getByTestId('backup-dialog-close').click();
  await expect(page.getByTestId('backup-dialog')).toHaveCount(0);
  const weak = await page.request.post('/api/backup', { data: { passphrase: 'short' } });
  expect(weak.status()).toBe(400);
});

test('a downloaded backup is encrypted and reveals nothing', async ({ app: page }) => {
  const dl = await downloadBackup(page, 'header-backup');
  expect(dl.suggestedFilename()).toMatch(/^lesson-vault-backup-.*\.lvbackup$/);
  backupPath = join(mkdtempSync(join(tmpdir(), 'lv-')), 'backup.lvbackup');
  copyFileSync(await dl.path(), backupPath);
  const bytes = readFileSync(backupPath);
  expect(bytes.subarray(0, 2).toString()).not.toBe('PK');
  const text = bytes.toString('latin1');
  for (const secret of ['%PDF', 'manifest.json', 'zephyrword', samples.en.short, samples.tl.short]) expect(text, secret).not.toContain(secret);

  await page.goto('/settings');
  await expect(page.getByTestId('settings-encryption')).toContainText('encrypted on this PC');
  const second = await downloadBackup(page, 'settings-backup');
  expect(second.suggestedFilename()).toMatch(/\.lvbackup$/);
});

test('a wrong passphrase or a changed backup is rejected and nothing changes', async ({ app: page }) => {
  await chooseRestore(page, 'header-restore', backupPath);
  await expect(page.getByTestId('confirm-accept')).toBeDisabled();
  await page.getByTestId('confirm-passphrase').fill('the wrong passphrase');
  await page.getByTestId('confirm-accept').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Wrong passphrase' })).toBeVisible();
  await page.getByTestId('confirm-cancel').click();

  const changed = Buffer.from(readFileSync(backupPath));
  changed[changed.length - 1] ^= 1;
  await chooseRestore(page, 'header-restore', { name: 'changed.lvbackup', mimeType: 'application/octet-stream', buffer: changed });
  await page.getByTestId('confirm-passphrase').fill(TEST_PASSPHRASE);
  await page.getByTestId('confirm-accept').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Wrong passphrase' }).last()).toBeVisible();
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('item-count')).toHaveText('5 items');
});

test('an older unencrypted backup with altered scripture is still rejected', async ({ app: page }) => {
  const zip = new AdmZip();
  const verse = { text: 'TAMPERED SCRIPTURE', text_sha256: 'not the real hash' };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ format: 'lesson-vault-backup', version: 1, tables: { lessons: [], verses: [verse] } })));
  await chooseRestore(page, 'header-restore', { name: 'tampered.zip', mimeType: 'application/zip', buffer: zip.toBuffer() });
  await expect(page.getByTestId('confirm-body')).toContainText('tampered.zip');
  await expect(page.getByTestId('confirm-passphrase')).toHaveCount(0);
  await page.getByTestId('confirm-accept').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'checksum mismatch' })).toBeVisible();
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('item-count')).toHaveText('5 items');
  const verses: any[] = await (await page.request.get('/api/verses')).json();
  expect(JSON.stringify(verses)).not.toContain('TAMPERED');
});

test('a junk file is rejected on restore', async ({ app: page }) => {
  await page.goto('/settings');
  await chooseRestore(page, 'settings-restore', { name: 'junk.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip') });
  await page.getByTestId('confirm-accept').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'not a valid backup' })).toBeVisible();
  await page.getByTestId('confirm-cancel').click();
});

test('reset needs the typed word, wipes the vault, and restore brings everything back', async ({ app: page }) => {
  const versesBefore: any[] = await (await page.request.get('/api/verses')).json();
  const contextBefore = await (await page.request.get('/api/verse-context')).json();
  const scriptureBefore = await (await page.request.get('/api/scripture-context')).json();
  expect(Object.keys(scriptureBefore).length, 'book and chapter context exists to protect').toBeGreaterThan(0);
  await page.getByTestId('header-reset').click();
  await expect(page.getByTestId('confirm-accept')).toBeDisabled();
  await page.getByTestId('confirm-text').fill('reset');
  await expect(page.getByTestId('confirm-accept')).toBeDisabled();
  await page.getByTestId('confirm-text').fill('RESET');
  await page.getByTestId('confirm-accept').click();
  await expect(page.getByTestId('empty-vault')).toBeVisible();
  await expect(page.getByTestId('side-all-count')).toHaveText('0');
  await expect(page.getByTestId('viewer-empty')).toBeVisible();
  expect(await (await page.request.get('/api/verses')).json()).toEqual([]);
  expect(await (await page.request.get('/api/verse-context')).json()).toEqual({});
  expect(await (await page.request.get('/api/scripture-context')).json()).toEqual({});

  await page.goto('/bibles');
  await expect(page.getByTestId('bibles-empty')).toContainText('No verses yet');
  await page.goto('/lecture');
  await page.getByTestId('lecture-issue').fill('election');
  await page.getByTestId('lecture-suggest').click();
  await expect(page.getByTestId('suggestions-empty')).toBeVisible();
  await page.goto('/');

  await chooseRestore(page, 'header-restore', backupPath);
  await page.getByTestId('confirm-passphrase').fill(TEST_PASSPHRASE);
  await page.getByTestId('confirm-accept').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Backup restored: 5 lessons' })).toBeVisible();
  await expect(page.getByTestId('item-count')).toHaveText('5 items');
  await expect(row(page, 'Sampleday')).toBeVisible();
  await expect(page.locator('[data-testid="viewer-canvas"][data-rendered-key]')).toBeVisible();

  const versesAfter: any[] = await (await page.request.get('/api/verses')).json();
  const pick = (vs: any[]) => vs.map((v) => [v.id, v.text, v.status, v.ocr_raw]).sort();
  expect(pick(versesAfter)).toEqual(pick(versesBefore));
  expect(await (await page.request.get('/api/verse-context')).json()).toEqual(contextBefore);
  expect(await (await page.request.get('/api/scripture-context')).json()).toEqual(scriptureBefore);
  const locked = versesAfter.find((v) => v.status === 'verified');
  expect((await page.request.patch(`/api/verses/${locked.id}`, { data: { text: 'x' } })).status()).toBe(409);
});

test('the reset path in settings also opens and can be cancelled', async ({ app: page }) => {
  await page.goto('/settings');
  await page.getByTestId('settings-reset').click();
  await expect(page.getByTestId('confirm-text')).toBeVisible();
  await page.getByTestId('confirm-dialog-close').click();
  await expect(page.getByTestId('settings-stats')).toContainText('5 lessons');
});
