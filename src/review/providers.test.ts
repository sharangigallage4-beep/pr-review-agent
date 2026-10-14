import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, defaultProviderId, listProviders, ollamaBaseUrl, resolveProvider, reviewerFor } from './providers.js';
import type { ReviewInput } from './types.js';

const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;
const byId = (e: NodeJS.ProcessEnv, id: 'ollama' | 'claude') => listProviders(e).find((p) => p.id === id)!;

describe('listProviders', () => {
  test('with a Claude key and an Ollama address both are usable, each with its own model', () => {
    const e = env({ CLAUDE_API_KEY: 'sk-ant-x', CLAUDE_MODEL: 'claude-sonnet-5-5', OLLAMA_BASE_URL: 'http://localhost:11434', OLLAMA_MODEL: 'qwen2.5-coder-16k' });
    assert.deepEqual([byId(e, 'claude').available, byId(e, 'claude').model], [true, 'claude-sonnet-5-5']);
    assert.deepEqual([byId(e, 'ollama').available, byId(e, 'ollama').model], [true, 'qwen2.5-coder-16k']);
  });

  test('Claude without a key is unavailable and says how to fix it', () => {
    const claude = byId(env({}), 'claude');
    assert.equal(claude.available, false);
    assert.match(claude.reason ?? '', /CLAUDE_API_KEY.*\.env/);
  });

  test('a blank key counts as no key', () => {
    assert.equal(byId(env({ CLAUDE_API_KEY: '   ' }), 'claude').available, false);
  });

  test('the "ollama" placeholder in ANTHROPIC_API_KEY is never taken for a Claude key', () => {
    assert.equal(byId(env({ ANTHROPIC_API_KEY: 'ollama' }), 'claude').available, false);
    assert.equal(byId(env({ ANTHROPIC_BASE_URL: 'http://localhost:11434', ANTHROPIC_API_KEY: 'sk-ant-real' }), 'claude').available, false, 'with an Ollama address set, ANTHROPIC_API_KEY belongs to that side');
  });

  test('an older .env keeps meaning what it meant: base URL = Ollama, otherwise ANTHROPIC_* = Claude', () => {
    const ollamaSetup = env({ ANTHROPIC_BASE_URL: 'http://localhost:11434', ANTHROPIC_API_KEY: 'ollama', ANTHROPIC_MODEL: 'qwen2.5-coder-16k' });
    assert.equal(byId(ollamaSetup, 'ollama').model, 'qwen2.5-coder-16k');
    const claudeSetup = env({ ANTHROPIC_API_KEY: 'sk-ant-legacy', ANTHROPIC_MODEL: 'claude-sonnet-5-5' });
    assert.deepEqual([byId(claudeSetup, 'claude').available, byId(claudeSetup, 'claude').model], [true, 'claude-sonnet-5-5']);
  });

  test('a hosting service cannot reach Ollama on your computer, unless an address is given', () => {
    assert.equal(byId(env({ RENDER: 'true' }), 'ollama').available, false);
    assert.equal(byId(env({ RENDER: 'true', OLLAMA_BASE_URL: 'https://ollama.example.com' }), 'ollama').available, true);
    assert.equal(byId(env({}), 'ollama').available, true);
  });
});

describe('defaultProviderId', () => {
  test('AI_PROVIDER wins when that provider is usable, and is ignored when it is not', () => {
    assert.equal(defaultProviderId(env({ AI_PROVIDER: 'claude', CLAUDE_API_KEY: 'k', OLLAMA_BASE_URL: 'http://x' })), 'claude');
    assert.equal(defaultProviderId(env({ AI_PROVIDER: 'ollama', CLAUDE_API_KEY: 'k' })), 'ollama');
    assert.equal(defaultProviderId(env({ AI_PROVIDER: 'claude' })), 'ollama', 'no key, so it cannot be Claude');
  });

  test('without AI_PROVIDER: an Ollama address means Ollama, otherwise Claude when a key exists', () => {
    assert.equal(defaultProviderId(env({ ANTHROPIC_BASE_URL: 'http://localhost:11434', CLAUDE_API_KEY: 'k' })), 'ollama');
    assert.equal(defaultProviderId(env({ CLAUDE_API_KEY: 'k' })), 'claude');
    assert.equal(defaultProviderId(env({})), 'ollama');
  });
});

describe('resolveProvider', () => {
  test('Claude always uses the real Claude address, even when ANTHROPIC_BASE_URL points at Ollama', () => {
    const resolved = resolveProvider('claude', env({ CLAUDE_API_KEY: 'sk-ant-x', ANTHROPIC_BASE_URL: 'http://localhost:11434', CLAUDE_MODEL: 'claude-sonnet-5-5' }));
    assert.deepEqual(resolved, { id: 'claude', apiKey: 'sk-ant-x', baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' });
  });

  test('Ollama uses its own address and a placeholder key', () => {
    const resolved = resolveProvider('ollama', env({ OLLAMA_BASE_URL: 'http://localhost:11434/', OLLAMA_MODEL: 'm' }));
    assert.deepEqual(resolved, { id: 'ollama', apiKey: 'ollama', baseURL: 'http://localhost:11434', model: 'm' });
    assert.equal(ollamaBaseUrl(env({ ANTHROPIC_BASE_URL: 'http://h:1/' })), 'http://h:1');
  });

  test('an unusable provider throws a ProviderError with the reason, never a vague failure', () => {
    assert.throws(() => resolveProvider('claude', env({})), (err: unknown) => err instanceof ProviderError && /CLAUDE_API_KEY/.test(err.message));
    assert.throws(() => resolveProvider('nope' as never, env({})), /Unknown AI provider/);
  });
});

describe('reviewerFor', () => {
  const input: ReviewInput = {
    pullRequest: { repository: 'a/b', number: 1, title: 't', description: '', author: null, baseRef: 'main', headRef: 'x' },
    diff: '',
    changedFiles: [],
  };

  test('returns a review function that carries the chosen provider to the model call', async () => {
    const provider = { id: 'claude' as const, apiKey: 'k', baseURL: 'https://api.anthropic.com', model: 'm' };
    const calls: Array<{ provider?: unknown; hasPrompt: boolean }> = [];
    const review = reviewerFor(provider, async (params) => {
      calls.push({ provider: params.provider, hasPrompt: params.systemPrompt.length > 0 && params.userMessage.length > 0 });
      return { summary: 'ok', issues: [] };
    });
    const result = await review(input, { conventions: '' });
    assert.deepEqual(result, { summary: 'ok', issues: [] });
    assert.deepEqual(calls, [{ provider, hasPrompt: true }]);
  });

  test('two providers never share a call: each reviewer sends its own', async () => {
    const seen: string[] = [];
    const send = async (params: { provider?: { id: string } }) => {
      seen.push(params.provider?.id ?? 'none');
      return { summary: 's', issues: [] };
    };
    const ollama = reviewerFor({ id: 'ollama', apiKey: 'ollama', baseURL: 'http://localhost:11434', model: 'q' }, send as never);
    const claude = reviewerFor({ id: 'claude', apiKey: 'k', baseURL: 'https://api.anthropic.com', model: 'c' }, send as never);
    await ollama(input, { conventions: '' });
    await claude(input, { conventions: '' });
    assert.deepEqual(seen, ['ollama', 'claude']);
  });
});
