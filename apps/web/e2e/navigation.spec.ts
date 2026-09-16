import { test, expect } from '@playwright/test';
import { assertNoPageOverflow, loginAsDirector, openNav } from './helpers';

const SECTIONS = [
  { label: 'Заказы', path: /\/app\/orders/ },
  { label: 'Склад', path: /\/app\/warehouse/ },
  { label: 'Поставки', path: /\/app\/supplies/ },
  { label: 'Инвентаризация', path: /\/app\/inventories/ },
  { label: 'Букеты', path: /\/app\/bouquets/ },
] as const;

test.describe('Responsive navigation smoke', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsDirector(page);
  });

  for (const section of SECTIONS) {
    test(`open ${section.label} without page overflow`, async ({ page }) => {
      await openNav(page, section.label);
      await expect(page).toHaveURL(section.path);
      await page.waitForLoadState('networkidle');
      await assertNoPageOverflow(page);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    });
  }
});

test.describe('Login responsive', () => {
  test('login page fits viewport', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#login')).toBeVisible({ timeout: 90_000 });
    await assertNoPageOverflow(page);
    await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();
  });
});
