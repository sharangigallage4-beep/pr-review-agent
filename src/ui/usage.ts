import type { Job } from './jobs.js';

/**
 * What the Claude API was asked for, counted from the usage numbers each response reports. The price is
 * only an estimate: prices change and differ by model, so they are never built in - set them in .env
 * (CLAUDE_PRICE_INPUT_PER_MTOK and CLAUDE_PRICE_OUTPUT_PER_MTOK, US dollars per million tokens) from
 * the pricing page. Without them only tokens are shown.
 *
 * A monthly cap keeps a shared key from running away: CLAUDE_MONTHLY_TOKEN_LIMIT (tokens) and/or
 * CLAUDE_MONTHLY_BUDGET_USD (needs the prices above). Once a cap is reached, new Claude reviews are
 * refused with a message until the next month; Ollama reviews are not affected.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** How many requests to the model were made. */
  requests: number;
}

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface UsageSummary {
  available: true;
  /** The calendar month (UTC) the totals cover, like "2026-10". */
  month: string;
  reviews: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Estimated cost in US dollars; absent when no prices are configured. */
  costUsd?: number;
  priced: boolean;
  limits: { tokens?: number; usd?: number };
  /** How much of the tightest cap is used, 0-100+, or absent when there is no cap. */
  percentUsed?: number;
  exceeded: boolean;
  /** The newest Claude reviews with their own numbers. */
  recent: Array<{ id: string; label: string; createdAt: string; inputTokens: number; outputTokens: number; costUsd?: number }>;
}

const positive = (value: string | undefined): number | undefined => {
  const n = Number((value ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export function pricingFrom(env: NodeJS.ProcessEnv): Pricing | undefined {
  const inputPerMTok = positive(env.CLAUDE_PRICE_INPUT_PER_MTOK);
  const outputPerMTok = positive(env.CLAUDE_PRICE_OUTPUT_PER_MTOK);
  return inputPerMTok !== undefined && outputPerMTok !== undefined ? { inputPerMTok, outputPerMTok } : undefined;
}

export function costOf(usage: Pick<Usage, 'inputTokens' | 'outputTokens'>, pricing: Pricing | undefined): number | undefined {
  if (!pricing) return undefined;
  return (usage.inputTokens * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok) / 1_000_000;
}

export function addUsage(total: Usage | undefined, more: { inputTokens: number; outputTokens: number }): Usage {
  return {
    inputTokens: (total?.inputTokens ?? 0) + more.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + more.outputTokens,
    requests: (total?.requests ?? 0) + 1,
  };
}

const monthOf = (date: Date): string => date.toISOString().slice(0, 7);

export function summarizeUsage(jobs: readonly Job[], env: NodeJS.ProcessEnv, now: Date = new Date()): UsageSummary {
  const month = monthOf(now);
  const pricing = pricingFrom(env);
  const claudeJobs = jobs.filter((j) => j.provider === 'claude' && j.usage);
  const thisMonth = claudeJobs.filter((j) => j.createdAt.slice(0, 7) === month);

  const inputTokens = thisMonth.reduce((sum, j) => sum + (j.usage?.inputTokens ?? 0), 0);
  const outputTokens = thisMonth.reduce((sum, j) => sum + (j.usage?.outputTokens ?? 0), 0);
  const totalTokens = inputTokens + outputTokens;
  const costUsd = costOf({ inputTokens, outputTokens }, pricing);

  const tokenLimit = positive(env.CLAUDE_MONTHLY_TOKEN_LIMIT);
  // A dollar cap can only be checked when prices are known; without them it is ignored (and says so in the docs).
  const usdLimit = pricing ? positive(env.CLAUDE_MONTHLY_BUDGET_USD) : undefined;
  const shares = [
    tokenLimit !== undefined ? (totalTokens / tokenLimit) * 100 : undefined,
    usdLimit !== undefined && costUsd !== undefined ? (costUsd / usdLimit) * 100 : undefined,
  ].filter((s): s is number => s !== undefined);
  const percentUsed = shares.length ? Math.round(Math.max(...shares)) : undefined;

  return {
    available: true,
    month,
    reviews: thisMonth.length,
    inputTokens,
    outputTokens,
    totalTokens,
    ...(costUsd !== undefined ? { costUsd } : {}),
    priced: pricing !== undefined,
    limits: { ...(tokenLimit !== undefined ? { tokens: tokenLimit } : {}), ...(usdLimit !== undefined ? { usd: usdLimit } : {}) },
    ...(percentUsed !== undefined ? { percentUsed } : {}),
    exceeded: percentUsed !== undefined && percentUsed >= 100,
    recent: claudeJobs.slice(0, 10).map((j) => {
      const cost = costOf(j.usage as Usage, pricing);
      return {
        id: j.id,
        label: j.kind === 'local' ? (j.label ?? 'Local review') : `${j.owner}/${j.repo} #${j.pr}`,
        createdAt: j.createdAt,
        inputTokens: j.usage?.inputTokens ?? 0,
        outputTokens: j.usage?.outputTokens ?? 0,
        ...(cost !== undefined ? { costUsd: cost } : {}),
      };
    }),
  };
}

/** A message for the user when this month's cap is used up, otherwise undefined. */
export function budgetProblem(jobs: readonly Job[], env: NodeJS.ProcessEnv, now: Date = new Date()): string | undefined {
  const summary = summarizeUsage(jobs, env, now);
  if (!summary.exceeded) return undefined;
  const used = summary.limits.tokens !== undefined && summary.totalTokens >= summary.limits.tokens
    ? `${summary.totalTokens.toLocaleString('en-US')} of ${summary.limits.tokens.toLocaleString('en-US')} tokens`
    : `about $${(summary.costUsd ?? 0).toFixed(2)} of $${(summary.limits.usd ?? 0).toFixed(2)}`;
  return `The monthly Claude limit has been reached (${used} used in ${summary.month}). Use Ollama instead, or raise CLAUDE_MONTHLY_TOKEN_LIMIT / CLAUDE_MONTHLY_BUDGET_USD in the .env file and restart the server.`;
}
