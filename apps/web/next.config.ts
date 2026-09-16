import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const configDir = dirname(fileURLToPath(import.meta.url));

function loadRootPublicEnv(): void {
  const envPath = resolve(configDir, '../../.env');

  try {
    const text = readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const separator = trimmed.indexOf('=');
      if (separator === -1) {
        continue;
      }

      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (key.startsWith('NEXT_PUBLIC_') && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // CI and production inject NEXT_PUBLIC_* without a local .env file.
  }
}

loadRootPublicEnv();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: false,
  transpilePackages: ['@erp/shared'],
  agentRules: false,
  // Production Docker image uses the standalone server output.
  output: 'standalone',
};

export default nextConfig;
