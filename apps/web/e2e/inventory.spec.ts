import { test, expect } from '@playwright/test';
import { assertNoPageOverflow, loginAsDirector, openNav } from './helpers';

test.describe('Inventory responsive', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsDirector(page);
    await openNav(page, 'Инвентаризация');
    await expect(page).toHaveURL(/\/app\/inventories/);
    await page.waitForLoadState('networkidle');
    await assertNoPageOverflow(page);
  });

  test('list usable; open inventory if present', async ({ page }) => {
    const openCurrent = page.getByRole('button', { name: /Открыть текущую/ });
    const firstLink = page.locator('a[href*="/app/inventories/"]').first();

    if (await openCurrent.isVisible().catch(() => false)) {
      await openCurrent.click();
    } else if (await firstLink.isVisible().catch(() => false)) {
      await firstLink.click();
    } else {
      test.skip(true, 'No inventory to open in this environment');
      return;
    }

    await expect(page).toHaveURL(/\/app\/inventories\//);
    await page.waitForLoadState('networkidle');
    await assertNoPageOverflow(page);

    const counted = page
      .getByLabel(/Посчитано|факт/i)
      .or(page.locator('input[inputmode="numeric"]').first());
    if (
      await counted
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await counted.first().fill('0');
      await assertNoPageOverflow(page);
    }
  });
});
