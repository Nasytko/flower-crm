import { expect, type Page } from '@playwright/test';

export const SEED = {
  login: process.env.E2E_LOGIN ?? 'director',
  password: process.env.E2E_PASSWORD ?? 'Director123!',
};

export async function loginAsDirector(page: Page): Promise<void> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  const loginInput = page.locator('#login');
  await expect(loginInput).toBeVisible({ timeout: 90_000 });
  await loginInput.fill(SEED.login);
  await page.locator('#password').fill(SEED.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 60_000 });
  await expect(page.getByText('Загрузка...')).toHaveCount(0, { timeout: 60_000 });
}

/** Assert no unintentional page-level horizontal overflow. */
export async function assertNoPageOverflow(page: Page, tolerance = 2): Promise<void> {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
    };
  });
  expect(
    metrics.scrollWidth,
    `horizontal overflow: scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth}`,
  ).toBeLessThanOrEqual(metrics.clientWidth + tolerance);
}

export async function openNav(page: Page, label: string): Promise<void> {
  const viewport = page.viewportSize();
  const isNarrow = (viewport?.width ?? 1440) < 1024;
  if (isNarrow) {
    const menu = page.getByRole('button', { name: 'Открыть меню' });
    await expect(menu).toBeVisible({ timeout: 30_000 });
    await menu.click();
    await expect(page.getByRole('dialog')).toBeVisible();
  }
  const nav = page.getByRole('navigation', { name: 'Основная навигация' });
  await expect(nav).toBeVisible();
  await nav.getByRole('link', { name: label, exact: true }).click();
}
