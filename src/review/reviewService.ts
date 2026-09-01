import { buildSystemPrompt, buildUserMessage } from './prompt.js';
import { requestReview as defaultRequestReview } from './claudeClient.js';
import { reviewResultSchema } from './types.js';
import type { ReviewInput, ReviewResult } from './types.js';

export interface ReviewServiceDeps {
  /** Injectable for tests - defaults to the real Claude API call in claudeClient.ts. */
  requestReview?: (params: { systemPrompt: string; userMessage: string }) => Promise<unknown>;
}

/**
 * Runs a full Claude code review over the given PR input and returns validated, structured
 * findings. This module has no dependency on src/github or src/mcp - it only knows about the
 * plain data types in types.ts - so it can be constructed and unit tested with literal objects,
 * independent of GitHub API calls or the MCP transport.
 */
export async function reviewPullRequest(input: ReviewInput, deps: ReviewServiceDeps = {}): Promise<ReviewResult> {
  const systemPrompt = buildSystemPrompt();
  const userMessage = buildUserMessage(input);
  const requestReview = deps.requestReview ?? defaultRequestReview;

  const raw = await requestReview({ systemPrompt, userMessage });

  const parsed = reviewResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Claude's review response did not match the expected schema: ${parsed.error.message}`);
  }

  return parsed.data;
}
