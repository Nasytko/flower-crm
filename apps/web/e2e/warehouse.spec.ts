import { test, expect } from '@playwright/test';
import { assertNoPageOverflow, loginAsDirector, openNav } from './helpers';

test.describe('Warehouse responsive', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsDirector(page);
    await openNav(page, 'Склад');
    await expect(page).toHaveURL(/\/app\/warehouse/);
    await page.waitForLoadState('networkidle');
  });

  test('search and stock fields visible without overflow', async ({ page }) => {
    await assertNoPageOverflow(page);
    const search = page.getByLabel('Поиск').or(page.getByPlaceholder(/Поиск/i));
    await expect(search.first()).toBeVisible();
    await search.first().fill('a');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await assertNoPageOverflow(page);

    // Desktop table headers stay in DOM (hidden); assert a *visible* stock label.
    const stockLabel = page
      .locator('main')
      .getByText(/В наличии|Доступно/i)
      .filter({ visible: true })
      .first();
    await expect(stockLabel).toBeVisible({ timeout: 20_000 });
  });
});
