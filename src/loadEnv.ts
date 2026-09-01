import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads `.env` from the project root into process.env, if one exists - using Node's built-in
 * process.loadEnvFile() (no dotenv dependency needed). Every config loader in this project
 * (config.ts, review/config.ts, webhook/config.ts) reads process.env directly and has no idea
 * .env files exist at all - this is the one place that bridges the two, so it must run before
 * any of them do.
 *
 * Silently does nothing if no .env file is present, e.g. in CI or a real deployment where env
 * vars are injected directly by the platform rather than read from a file.
 */
export function loadDotEnv(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // This file lives at <root>/src/loadEnv.ts in dev (tsx) and <root>/dist/loadEnv.js once
  // built - both one level below the project root.
  const envPath = path.join(here, '..', '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}
