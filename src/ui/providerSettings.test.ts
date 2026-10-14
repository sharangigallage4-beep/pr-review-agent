import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderSettings } from './providerSettings.js';
import { ProviderError } from '../review/providers.js';

const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;
const BOTH = { CLAUDE_API_KEY: 'sk-ant-x', OLLAMA_BASE_URL: 'http://localhost:11434', AI_PROVIDER: 'ollama' };

function withFile(fn: (file: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'provider-'));
  try {
    fn(path.join(dir, 'p.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('ProviderSettings', () => {
  test('starts with the .env default and switches when asked', () => {
    const settings = new ProviderSettings(env(BOTH));
    assert.equal(settings.get(), 'ollama');
    settings.set('claude');
    assert.equal(settings.get(), 'claude');
    settings.set('ollama');
    assert.equal(settings.get(), 'ollama');
  });

  test('refuses an unknown provider and one that cannot be used, with a reason, and keeps the old choice', () => {
    const settings = new ProviderSettings(env({ OLLAMA_BASE_URL: 'http://localhost:11434' }));
    assert.throws(() => settings.set('gemini'), ProviderError);
    assert.throws(() => settings.set(undefined), /Choose "ollama" or "claude"/);
    assert.throws(() => settings.set('claude'), /CLAUDE_API_KEY/);
    assert.equal(settings.get(), 'ollama');
  });

  test('the choice survives a restart', () =>
    withFile((file) => {
      new ProviderSettings(env(BOTH), file).set('claude');
      assert.equal(new ProviderSettings(env(BOTH), file).get(), 'claude');
    }));

  test('a saved choice that is no longer possible (key removed) falls back to the .env default', () =>
    withFile((file) => {
      new ProviderSettings(env(BOTH), file).set('claude');
      const withoutKey = env({ OLLAMA_BASE_URL: 'http://localhost:11434', AI_PROVIDER: 'ollama' });
      assert.equal(new ProviderSettings(withoutKey, file).get(), 'ollama');
    }));

  test('an unreadable or hand-edited file is ignored, and no key is ever stored in it', () =>
    withFile((file) => {
      writeFileSync(file, '{broken');
      assert.equal(new ProviderSettings(env(BOTH), file).get(), 'ollama');
      writeFileSync(file, JSON.stringify({ provider: 'something-else' }));
      assert.equal(new ProviderSettings(env(BOTH), file).get(), 'ollama');

      new ProviderSettings(env(BOTH), file).set('claude');
      const stored = readFileSync(file, 'utf8');
      assert.equal(stored.includes('sk-ant'), false);
    }));
});
