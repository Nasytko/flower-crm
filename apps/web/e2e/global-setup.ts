import { request } from '@playwright/test';

/** Warm Next.js compile + API so first login is not racing "Compiling…". */
async function globalSetup(): Promise<void> {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';
  const apiURL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:3001';
  const ctx = await request.newContext();
  try {
    await ctx.get(`${apiURL}/api/v1/health`, { timeout: 30_000 });
    await ctx.get(`${baseURL}/login`, { timeout: 120_000 });
    await ctx.get(`${baseURL}/app`, { timeout: 120_000 });
  } finally {
    await ctx.dispose();
  }
}

export default globalSetup;
