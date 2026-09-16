import { test, expect } from '@playwright/test';
import { assertNoPageOverflow, loginAsDirector, openNav } from './helpers';

test.describe('Mobile / tablet orders workflow', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsDirector(page);
    await openNav(page, 'Заказы');
    await expect(page).toHaveURL(/\/app\/orders/);
    await page.waitForLoadState('networkidle');
  });

  test('date navigation and status tabs / kanban', async ({ page }) => {
    await assertNoPageOverflow(page);
    await expect(page.getByRole('button', { name: 'Сегодня' })).toBeVisible();
    await page.getByRole('button', { name: 'Завтра' }).click();
    await expect(page).toHaveURL(/date=/);
    await assertNoPageOverflow(page);

    // Empty day shows a message; otherwise desktop columns / mobile tabs.
    const empty = page.getByText(/заказов пока нет/i);
    const newColumn = page.getByRole('heading', { name: 'Новые' });
    const tabs = page.getByRole('tablist', { name: 'Статус заказов' });
    await expect(empty.or(newColumn).or(tabs).first()).toBeVisible({ timeout: 20_000 });

    const viewport = page.viewportSize();
    if ((viewport?.width ?? 1440) < 1024 && (await tabs.isVisible().catch(() => false))) {
      await page.getByRole('tab', { name: /Готов/ }).click();
      await assertNoPageOverflow(page);
    }
  });

  test('create order form is usable', async ({ page }) => {
    await page.getByRole('button', { name: '+ Новый заказ' }).click();
    await expect(page).toHaveURL(/\/app\/orders\/new/);
    await assertNoPageOverflow(page);

    await page.getByLabel('Имя клиента').fill('E2E Client');
    await page.locator('#ord-phone').fill('+375291112233');
    await page.getByRole('button', { name: 'Самовывоз' }).click();
    await expect(page.getByRole('heading', { name: 'Состав' })).toBeVisible();
    await assertNoPageOverflow(page);
  });
});
