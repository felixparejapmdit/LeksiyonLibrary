import { test as base, expect, type Page, type Locator } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const coverageFile = join(here, '..', 'coverage-data', 'coverage.json');
export const perfFile = join(here, '..', 'coverage-data', 'perf.json');
export const STUB = 'http://127.0.0.1:47321';

interface Coverage {
  clicked: string[];
  seen: Record<string, string>;
  unnamed: string[];
}

function updateCoverage(fn: (c: Coverage) => void) {
  const c: Coverage = JSON.parse(readFileSync(coverageFile, 'utf8'));
  fn(c);
  writeFileSync(coverageFile, JSON.stringify(c, null, 1));
}

// Runs inside the browser before any app code.
const instrumentation = () => {
  const w = window as any;
  w.__perf = { cls: 0, longTasks: [] as number[], events: [] as { name: string; duration: number }[] };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any[]) if (!e.hadRecentInput) w.__perf.cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__perf.longTasks.push(e.duration);
    }).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any[]) w.__perf.events.push({ name: e.name, duration: e.duration });
    }).observe({ type: 'event', durationThreshold: 16, buffered: true } as any);
  } catch {}

  const INTERACTIVE = 'button, a[href], [role="tab"], [role="separator"]';
  const census = () => {
    if (!w.__recordCensus) return;
    const seen: Record<string, string> = {};
    const unnamed: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(INTERACTIVE))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const id = el.dataset.testid;
      if (!id) {
        unnamed.push(el.outerHTML.slice(0, 120));
        continue;
      }
      const name = (el.getAttribute('aria-label') || el.textContent || '').trim();
      if (!name) unnamed.push(`no accessible name: ${id}`);
      seen[id] = name;
    }
    w.__recordCensus({ seen, unnamed });
  };
  let t: any;
  const schedule = () => {
    clearTimeout(t);
    t = setTimeout(census, 120);
  };
  document.addEventListener(
    'click',
    (e) => {
      const hit = (e.target as HTMLElement)?.closest?.(INTERACTIVE) as HTMLElement | null;
      if (hit?.dataset.testid) w.__recordClick?.(hit.dataset.testid);
      schedule();
    },
    true,
  );
  window.addEventListener('load', () => {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    schedule();
  });
};

export interface PerfSample {
  cls: number;
  maxLongTask: number;
  maxInteraction: number;
}

export async function resetPerf(page: Page) {
  await page.evaluate(() => {
    const p = (window as any).__perf;
    p.cls = 0;
    p.longTasks = [];
    p.events = [];
  });
}

export async function readPerf(page: Page): Promise<PerfSample> {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return page.evaluate(() => {
    const p = (window as any).__perf;
    const kinds = ['click', 'pointerup', 'pointerdown', 'keydown', 'keyup', 'mousedown', 'mouseup'];
    return {
      cls: Number(p.cls.toFixed(4)),
      maxLongTask: Math.round(Math.max(0, ...p.longTasks)),
      maxInteraction: Math.round(Math.max(0, ...p.events.filter((e: any) => kinds.includes(e.name)).map((e: any) => e.duration))),
    };
  });
}

export function recordPerf(label: string, s: PerfSample) {
  const all = JSON.parse(readFileSync(perfFile, 'utf8'));
  all.push({ label, ...s });
  writeFileSync(perfFile, JSON.stringify(all, null, 1));
}

// Web Vitals calls INP under 200 ms "good" and CLS under 0.1 "good". The layout budget here is stricter.
export const BUDGET = { interaction: 200, cls: 0.02, longTask: 200 };

export async function assertSmooth(page: Page, label: string, budget: Partial<typeof BUDGET> = {}) {
  const s = await readPerf(page);
  recordPerf(label, s);
  const b = { ...BUDGET, ...budget };
  expect.soft(s.maxInteraction, `${label}: slowest interaction ms`).toBeLessThanOrEqual(b.interaction);
  expect.soft(s.cls, `${label}: layout shift`).toBeLessThanOrEqual(b.cls);
  expect.soft(s.maxLongTask, `${label}: longest main-thread task ms`).toBeLessThanOrEqual(b.longTask);
  return s;
}

export const test = base.extend<{ errors: string[]; guard: void; app: Page }>({
  errors: async ({}, use) => {
    await use([]);
  },
  // Every test fails on an uncaught error, a console error, a CSP violation or a server failure.
  guard: [
    async ({ page, errors }, use) => {
      await page.exposeBinding('__recordClick', (_s, id: string) => {
        updateCoverage((c) => {
          if (!c.clicked.includes(id)) c.clicked.push(id);
        });
      });
      await page.exposeBinding('__recordCensus', (_s, { seen, unnamed }: { seen: Record<string, string>; unnamed: string[] }) => {
        updateCoverage((c) => {
          // Ids only: labels can contain lesson titles, which must not be written to disk.
          for (const id of Object.keys(seen)) c.seen[id] = '';
          for (const u of unnamed) if (!c.unnamed.includes(u)) c.unnamed.push(u);
        });
      });
      await page.addInitScript(instrumentation);
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`);
      });
      page.on('response', (r) => {
        if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`);
      });
      await use();
      expect(errors, 'browser errors during test').toEqual([]);
    },
    { auto: true },
  ],
  app: async ({ page }, use) => {
    await page.goto('/');
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await use(page);
  },
});

export const TEST_PASSPHRASE = 'a long test passphrase';

/** Runs a test on an empty vault, then puts the shared test library back. */
export async function withEmptyVault(page: Page, body: () => Promise<void>) {
  const saved = await (await page.request.post('/api/backup', { data: { passphrase: TEST_PASSPHRASE } })).body();
  const wipe = () => page.request.post('/api/reset', { data: { confirm: 'RESET' } });
  expect((await wipe()).ok()).toBeTruthy();
  try {
    await body();
  } finally {
    await wipe();
    const restored = await page.request.post('/api/restore', {
      multipart: { passphrase: TEST_PASSPHRASE, file: { name: 'saved.lvbackup', mimeType: 'application/octet-stream', buffer: saved } },
    });
    expect(restored.ok()).toBeTruthy();
  }
}

export function recordClick(id: string) {
  updateCoverage((c) => {
    if (!c.clicked.includes(id)) c.clicked.push(id);
  });
}

export async function setAiMode(mode: 'good' | 'hostile' | 'down' | 'slow') {
  await fetch(`${STUB}/__mode`, { method: 'POST', body: JSON.stringify({ mode }) });
}

export function row(page: Page, title: string | RegExp): Locator {
  return page.getByTestId('lesson-row').filter({ hasText: title });
}

/** Watches every animation frame while `action` runs and reports anything that blinked. */
export async function watchFrames(page: Page, action: () => Promise<unknown>) {
  await page.evaluate(() => {
    const w = window as any;
    const probe = document.createElement('canvas');
    probe.width = probe.height = 8;
    const ctx = probe.getContext('2d', { willReadFrequently: true })!;
    const shell = document.querySelector('[data-testid="app-shell"]');
    const header = document.querySelector('[data-testid="header"]');
    const state = { frames: 0, blankCanvas: 0, emptyMain: 0, shellLost: 0, headerLost: 0, bgChanges: 0, stop: false };
    let lastBg = getComputedStyle(document.body).backgroundColor;
    w.__frames = state;
    const tick = () => {
      if (state.stop) return;
      state.frames++;
      const main = document.querySelector('[data-testid="app-main"]');
      if (!main || main.childElementCount === 0) state.emptyMain++;
      if (document.querySelector('[data-testid="app-shell"]') !== shell) state.shellLost++;
      if (document.querySelector('[data-testid="header"]') !== header) state.headerLost++;
      const bg = getComputedStyle(document.body).backgroundColor;
      if (bg !== lastBg) {
        state.bgChanges++;
        lastBg = bg;
      }
      const c = document.querySelector('[data-testid="viewer-canvas"]') as HTMLCanvasElement | null;
      if (c && c.dataset.renderedKey) {
        ctx.clearRect(0, 0, 8, 8);
        ctx.drawImage(c, 0, 0, 8, 8);
        const d = ctx.getImageData(0, 0, 8, 8).data;
        let sum = 0;
        let alpha = 0;
        for (let i = 0; i < d.length; i += 4) {
          sum += d[i] + d[i + 1] + d[i + 2];
          alpha += d[i + 3];
        }
        if (alpha === 0 || sum === 0) state.blankCanvas++;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await action();
  return page.evaluate(() => {
    const s = (window as any).__frames;
    s.stop = true;
    return { frames: s.frames, blankCanvas: s.blankCanvas, emptyMain: s.emptyMain, shellLost: s.shellLost, headerLost: s.headerLost, bgChanges: s.bgChanges };
  });
}

export { expect };
