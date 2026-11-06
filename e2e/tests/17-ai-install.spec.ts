import { test, expect, setAiMode, STUB } from '../support/fixtures';

// The stand-in for Ollama: which models it has, and how a download goes.
const setModels = (models?: string[], pull: 'ok' | 'fail' | 'hang' = 'ok') => fetch(`${STUB}/__models`, { method: 'POST', body: JSON.stringify({ models, pull }) });

test.describe('the AI model is installed from Settings', () => {
  test.afterEach(async () => {
    await setModels();
    await setAiMode('good');
  });

  test('one button downloads and installs it, with its progress shown', async ({ page }) => {
    await setModels([]);
    await page.goto('/settings');
    await expect(page.getByTestId('settings-ai')).toHaveText('Local AI is running, but model llama3.2:3b is not installed.');
    await expect(page.getByTestId('ai-install-note')).toContainText('llama3.2:3b and bge-m3 are downloaded by Ollama from ollama.com, about 3.2 GB');
    await expect(page.getByTestId('ai-installed')).toHaveCount(0);

    await page.getByTestId('ai-install').click();
    await expect(page.getByTestId('ai-install-progress')).toBeVisible();
    await expect(page.getByTestId('ai-install-status')).toContainText(/^1 of 2: \w+/);
    await expect(page.getByTestId('ai-install'), 'one download at a time').toHaveCount(0);
    await expect(page.getByTestId('ai-installed')).toHaveText('Installed', { timeout: 15_000 });
    await expect(page.getByTestId('toast').filter({ hasText: 'The AI model is installed' })).toBeVisible();
    await expect(page.getByTestId('settings-ai')).toHaveText('Connected to local model llama3.2:3b.');
    await expect(page.getByTestId('settings-meaning')).toHaveText('Search by meaning is on.');

    // Nothing is left to install, and only this app's own models can be asked for.
    const again = await page.request.post('/api/ai/pull');
    expect(again.status()).toBe(400);
    expect((await again.json()).error).toBe('Everything is installed already.');
  });

  test('a failed download says why, and one can be cancelled', async ({ page }) => {
    await setModels(['llama3.2:3b'], 'fail');
    await page.goto('/settings');
    await expect(page.getByTestId('settings-meaning')).toHaveText('Search by meaning needs its model too. It is installed with the same button.');
    await expect(page.getByTestId('ai-install-note')).toContainText('bge-m3 is downloaded by Ollama from ollama.com, about 1.2 GB');
    await page.getByTestId('ai-install').click();
    await expect(page.getByTestId('ai-install-error')).toHaveText('Ollama could not download bge-m3: pull model manifest: file does not exist');

    await setModels(['llama3.2:3b'], 'hang');
    await page.getByTestId('ai-install').click();
    await expect(page.getByTestId('ai-install-status')).toContainText('Downloading bge-m3');
    await page.getByTestId('ai-install-cancel').click();
    await expect(page.getByTestId('ai-install-error')).toContainText('Download cancelled.');
    await expect(page.getByTestId('ai-install')).toBeVisible();
  });

  test('without Ollama, it says where to get it', async ({ page }) => {
    await setAiMode('down');
    await page.goto('/settings');
    await expect(page.getByTestId('settings-ai')).toHaveText('Local AI is offline. Verse matching still works without it.');
    await expect(page.getByTestId('settings-ollama-missing')).toContainText('Install Ollama and start it');
    const link = page.getByTestId('settings-get-ollama');
    await expect(link).toHaveAttribute('href', 'https://ollama.com/download');
    await expect(link).toHaveAttribute('target', '_blank');
    // The test has no internet: the page Ollama is downloaded from is answered here.
    await page.context().route('https://ollama.com/**', (route) => route.fulfill({ body: 'Download Ollama' }));
    const [tab] = await Promise.all([page.waitForEvent('popup'), link.click()]);
    expect(tab.url()).toBe('https://ollama.com/download');
    await tab.close();

    await setAiMode('good');
    await page.getByTestId('settings-ai-recheck').click();
    await expect(page.getByTestId('settings-ai')).toHaveText('Connected to local model llama3.2:3b.');
    await expect(page.getByTestId('ai-installed')).toBeVisible();
  });
});
