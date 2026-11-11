import type { Page } from '@playwright/test';
import { test, expect, withEmptyVault } from '../support/fixtures';
import { makePdf } from '../support/pdf';

type Scope = 'lessons' | 'pastoral';
type Language = 'tl' | 'en';
type Target = { id: string; title: string };

// Invented document titles and wording only. Category and language are set
// explicitly so this tests folder behavior rather than parser classification.
async function seed(page: Page) {
  const records = {} as Record<Scope, Record<Language, Target>>;
  for (const scope of ['lessons', 'pastoral'] as const) {
    records[scope] = {} as Record<Language, Target>;
    for (const language of ['tl', 'en'] as const) {
      const title = `${scope === 'lessons' ? 'Lesson' : 'Visit'} ${language === 'tl' ? 'Tagalog' : 'English'} Sample`;
      const lines = [
        'Saturday/Sunday: November 7/8, 2026',
        `Paksa: ${title}`,
        'PASIMULA:',
        '1. The sample point ..........Genesis 6:8 T4T',
        language === 'tl' ? '8Ang mga bantay ay handa sa pintuan ng bayan.' : '8The watchmen are ready at the gate of the town.',
      ];
      const response = await page.request.post('/api/lessons', { multipart: {
        source_kind: 'text',
        ...(scope === 'pastoral' ? { category: 'pastoral' } : {}),
        pages: JSON.stringify([lines.join('\n')]),
        file: { name: scope === 'pastoral' ? `20261108_visit_${language}.pdf` : `2026_Wk45b_${language}.pdf`, mimeType: 'application/pdf', buffer: makePdf([lines]) },
      } });
      expect(response.ok()).toBe(true);
      const lesson = (await response.json()).lesson;
      const updated = await page.request.patch(`/api/lessons/${lesson.id}`, { data: { language, category: scope === 'pastoral' ? 'pastoral' : 'weekend' } });
      expect(updated.ok()).toBe(true);
      records[scope][language] = { id: lesson.id, title };
    }
  }
  return records;
}

async function openSidebar(page: Page, mobile: boolean) {
  if (mobile && !(await page.getByTestId('drawer').isVisible())) await page.getByTestId('open-drawer').click();
}

async function expandYear(page: Page, prefix: string) {
  const toggle = page.getByTestId(`${prefix}year-expand-2026`);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

for (const mobile of [false, true]) {
  test.describe(mobile ? 'year language folders on a phone' : 'year language folders on desktop', () => {
    test.use({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    test('both libraries group, filter, and open the exact PDF by language', async ({ page }) => {
      await withEmptyVault(page, async () => {
        const records = await seed(page);
        for (const scope of ['lessons', 'pastoral'] as const) {
          const prefix = scope === 'pastoral' ? 'pv-' : '';
          await page.goto('/');
          await openSidebar(page, mobile);
          await expandYear(page, prefix);
          for (const language of ['tl', 'en'] as const) {
            const group = page.getByTestId(`${prefix}year-2026-language-${language}`);
            await expect(group).toContainText(language === 'tl' ? 'Tagalog' : 'English');
            await expect(group.locator('.nav-count')).toHaveText('1');
            const children = page.getByTestId(`${prefix}year-2026-${language}-lessons`);
            await expect(children.getByTestId('tree-lesson')).toHaveCount(1);
            await expect(children.getByTestId('tree-lesson')).toHaveText(records[scope][language].title);
          }

          const englishToggle = page.getByTestId(`${prefix}year-2026-language-en-expand`);
          await englishToggle.click();
          await expect(page.getByTestId(`${prefix}year-2026-en-lessons`)).toHaveCount(0);
          await englishToggle.click();

          for (const language of ['tl', 'en'] as const) {
            await openSidebar(page, mobile);
            await expandYear(page, prefix);
            await page.getByTestId(`${prefix}year-2026-language-${language}`).click();
            await expect(page.getByTestId('list-title')).toHaveText(scope === 'pastoral' ? 'Pastoral Visits' : 'Lesson Library');
            await expect(page.getByTestId('lesson-row')).toHaveCount(1);
            await expect(page.getByTestId('lesson-row')).toContainText(records[scope][language].title);
          }

          // Selecting the year again clears only its language restriction.
          await openSidebar(page, mobile);
          await page.getByTestId(`${prefix}year-2026`).click();
          await expect(page.getByTestId('lesson-row')).toHaveCount(2);

          await openSidebar(page, mobile);
          await expandYear(page, prefix);
          await page.getByTestId(`${prefix}year-2026-en-lessons`).getByTestId('tree-lesson').click();
          const viewer = page.getByTestId('pdf-viewer');
          await expect(viewer).toHaveAttribute('data-lesson', records[scope].en.id);
          await expect(viewer.getByTestId('viewer-canvas')).toBeVisible();
          if (mobile) await expect(page.getByTestId('mobile-viewer')).toBeVisible();
        }
      });
    });
  });
}

test('sidebar labels follow both themes and only dark mode has the subtle gradient', async ({ page }) => {
  await page.goto('/');
  for (const theme of ['dark', 'light'] as const) {
    if ((await page.locator('html').getAttribute('data-theme')) !== theme) await page.getByTestId('theme-toggle').click();
    const styles = await page.getByTestId('sidebar').evaluate((sidebar) => {
      const entry = sidebar.querySelector('[data-testid="side-lessons"]')!;
      const icon = entry.querySelector('.nav-tile')!;
      return {
        label: getComputedStyle(entry).color,
        foreground: getComputedStyle(document.body).color,
        icon: getComputedStyle(icon).color,
        background: getComputedStyle(sidebar).backgroundImage,
      };
    });
    expect(styles.label).toBe(styles.foreground);
    expect(styles.icon).not.toBe(styles.label);
    if (theme === 'dark') expect(styles.background).toContain('linear-gradient');
    else expect(styles.background).toBe('none');
  }
});
