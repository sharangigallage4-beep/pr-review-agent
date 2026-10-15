import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { addUsage, budgetProblem, costOf, pricingFrom, summarizeUsage } from './usage.js';
import type { Job } from './jobs.js';

const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;
const NOW = new Date('2026-10-15T09:00:00Z');

const job = (id: string, over: Partial<Job>): Job =>
  ({ id, owner: 'acme', repo: 'w', pr: 1, autoPost: false, status: 'posted', createdAt: '2026-10-10T08:00:00Z', log: [], ...over }) as Job;
const claude = (id: string, inputTokens: number, outputTokens: number, over: Partial<Job> = {}) =>
  job(id, { provider: 'claude', usage: { inputTokens, outputTokens, requests: 1 }, ...over });

describe('pricing and cost', () => {
  test('prices come only from the environment, and both must be set', () => {
    assert.equal(pricingFrom(env({})), undefined);
    assert.equal(pricingFrom(env({ CLAUDE_PRICE_INPUT_PER_MTOK: '3' })), undefined);
    assert.equal(pricingFrom(env({ CLAUDE_PRICE_INPUT_PER_MTOK: 'abc', CLAUDE_PRICE_OUTPUT_PER_MTOK: '15' })), undefined);
    assert.deepEqual(pricingFrom(env({ CLAUDE_PRICE_INPUT_PER_MTOK: '3', CLAUDE_PRICE_OUTPUT_PER_MTOK: '15' })), { inputPerMTok: 3, outputPerMTok: 15 });
  });

  test('cost is tokens times the price per million', () => {
    assert.equal(costOf({ inputTokens: 2_000_000, outputTokens: 1_000_000 }, { inputPerMTok: 3, outputPerMTok: 15 }), 21);
    assert.equal(costOf({ inputTokens: 5, outputTokens: 5 }, undefined), undefined);
  });

  test('addUsage adds up tokens and counts requests', () => {
    const once = addUsage(undefined, { inputTokens: 10, outputTokens: 2 });
    assert.deepEqual(addUsage(once, { inputTokens: 5, outputTokens: 1 }), { inputTokens: 15, outputTokens: 3, requests: 2 });
  });
});

describe('summarizeUsage', () => {
  const prices = { CLAUDE_PRICE_INPUT_PER_MTOK: '3', CLAUDE_PRICE_OUTPUT_PER_MTOK: '15' };

  test('counts only Claude reviews of this month', () => {
    const jobs = [
      claude('a', 1000, 100),
      claude('b', 2000, 200),
      claude('old', 99999, 99999, { createdAt: '2026-09-30T23:00:00Z' }),
      job('ollama', { provider: 'ollama', usage: { inputTokens: 5000, outputTokens: 500, requests: 1 } }),
      job('none', {}),
    ];
    const s = summarizeUsage(jobs, env({}), NOW);
    assert.deepEqual([s.month, s.reviews, s.inputTokens, s.outputTokens, s.totalTokens], ['2026-10', 2, 3000, 300, 3300]);
    assert.equal(s.priced, false);
    assert.equal(s.costUsd, undefined, 'no prices, so no invented cost');
    assert.equal(s.exceeded, false);
  });

  test('with prices it estimates the cost, in total and per review', () => {
    const s = summarizeUsage([claude('a', 1_000_000, 100_000)], env(prices), NOW);
    assert.equal(s.priced, true);
    assert.ok(Math.abs((s.costUsd ?? 0) - 4.5) < 1e-9);
    assert.ok(Math.abs((s.recent[0]?.costUsd ?? 0) - 4.5) < 1e-9);
    assert.equal(s.recent[0]?.label, 'acme/w #1');
  });

  test('the token limit shows how much is used and trips at 100%', () => {
    const half = summarizeUsage([claude('a', 4000, 1000)], env({ CLAUDE_MONTHLY_TOKEN_LIMIT: '10000' }), NOW);
    assert.deepEqual([half.percentUsed, half.exceeded], [50, false]);
    const full = summarizeUsage([claude('a', 9000, 1000)], env({ CLAUDE_MONTHLY_TOKEN_LIMIT: '10000' }), NOW);
    assert.deepEqual([full.percentUsed, full.exceeded], [100, true]);
  });

  test('a dollar budget needs prices; without them it is ignored instead of guessed', () => {
    const jobs = [claude('a', 1_000_000, 100_000)];
    assert.equal(summarizeUsage(jobs, env({ CLAUDE_MONTHLY_BUDGET_USD: '1' }), NOW).exceeded, false);
    const withPrices = summarizeUsage(jobs, env({ ...prices, CLAUDE_MONTHLY_BUDGET_USD: '4' }), NOW);
    assert.deepEqual([withPrices.percentUsed, withPrices.exceeded], [113, true]);
  });

  test('the tightest of the two limits counts', () => {
    const s = summarizeUsage(
      [claude('a', 1_000_000, 100_000)],
      env({ ...prices, CLAUDE_MONTHLY_BUDGET_USD: '100', CLAUDE_MONTHLY_TOKEN_LIMIT: '2000000' }),
      NOW
    );
    assert.equal(s.percentUsed, 55);
  });

  test('a new month starts from zero', () => {
    const jobs = [claude('a', 9000, 1000)];
    const nextMonth = new Date('2026-11-01T00:00:01Z');
    assert.equal(summarizeUsage(jobs, env({ CLAUDE_MONTHLY_TOKEN_LIMIT: '10000' }), nextMonth).exceeded, false);
  });
});

describe('budgetProblem', () => {
  test('is silent under the cap or without one, and explains the way out once it is reached', () => {
    const jobs = [claude('a', 9000, 1000)];
    assert.equal(budgetProblem(jobs, env({}), NOW), undefined);
    assert.equal(budgetProblem(jobs, env({ CLAUDE_MONTHLY_TOKEN_LIMIT: '20000' }), NOW), undefined);
    const message = budgetProblem(jobs, env({ CLAUDE_MONTHLY_TOKEN_LIMIT: '10000' }), NOW) ?? '';
    assert.match(message, /monthly Claude limit has been reached/);
    assert.match(message, /10,000 of 10,000 tokens/);
    assert.match(message, /Ollama/);
  });
});
