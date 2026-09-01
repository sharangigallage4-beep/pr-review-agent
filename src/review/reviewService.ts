import { buildSystemPrompt, buildUserMessage } from './prompt.js';
import { requestReview as defaultRequestReview } from './claudeClient.js';
import { reviewResultSchema } from './types.js';
import type { ReviewInput, ReviewResult } from './types.js';

export interface ReviewServiceDeps {
  /** Injectable for tests - defaults to the real Claude API call in claudeClient.ts. */
  requestReview?: (params: { systemPrompt: string; userMessage: string }) => Promise<unknown>;
}

/**
 * Claude has been observed, intermittently and despite the tool schema marking it required, to
 * return `issues` as a JSON-encoded string instead of a native array (e.g. `"[]"` or
 * `"[{...}]"`). Coerce that one specific, confirmed shape back into an array before validation;
 * anything else is left untouched so the schema error still reports the real problem.
 */
export function normalizeRawReviewResult(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.issues !== 'string') return raw;

  try {
    const parsedIssues: unknown = JSON.parse(obj.issues);
    if (Array.isArray(parsedIssues)) {
      return { ...obj, issues: parsedIssues };
    }
  } catch {
    // Not JSON - fall through and let schema validation report it.
  }
  return raw;
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

  const attempt = async () => {
    const raw = await requestReview({ systemPrompt, userMessage });
    return reviewResultSchema.safeParse(normalizeRawReviewResult(raw));
  };

  let parsed = await attempt();
  if (!parsed.success) {
    // Confirmed live (2026-09-01 end-to-end test) that Claude occasionally returns a malformed
    // tool call - a required field missing, or "issues" as a string - despite the schema marking
    // both required. A single retry with the identical request has cleared it every time it's
    // been observed; only give up if it happens twice in a row, so a genuinely broken prompt/
    // schema still fails loudly instead of retrying forever.
    parsed = await attempt();
  }

  if (!parsed.success) {
    throw new Error(`Claude's review response did not match the expected schema: ${parsed.error.message}`);
  }

  return parsed.data;
}
