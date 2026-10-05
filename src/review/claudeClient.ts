import Anthropic from '@anthropic-ai/sdk';
import { loadReviewConfig } from './config.js';
import { SEVERITY_LEVELS } from './types.js';

const REVIEW_TOOL_NAME = 'submit_review';

// Forcing a tool call (rather than asking for JSON in plain text) means the SDK/API guarantees a
// single structured `tool_use` block back - no markdown-fence stripping, no "here's your JSON:"
// preamble to work around. reviewService.ts still runs the result through the zod schema in
// types.ts before trusting it, since tool-call schema conformance isn't a hard guarantee.
function buildReviewTool(): Anthropic.Tool {
  return {
    name: REVIEW_TOOL_NAME,
    description: 'Submit the completed code review as structured findings.',
    input_schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description:
            'REQUIRED - always include this field, even when issues is empty. Short overall ' +
            'summary of the PR and the review (1-3 sentences).',
        },
        issues: {
          type: 'array',
          description: 'REQUIRED - always an array, even when there are no findings (use []). Never a string.',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: [...SEVERITY_LEVELS] },
              file: { type: 'string', description: 'Path to the file the issue is in.' },
              line: { type: 'integer', description: 'Line number in the new (post-change) version of the file.' },
              title: { type: 'string', description: 'Short issue title.' },
              explanation: {
                type: 'string',
                description: 'What the problem is and why it matters - the concrete failure scenario, not just a label.',
              },
              suggestedFix: {
                type: 'string',
                description: 'A concise, actionable recommended fix.',
              },
            },
            required: ['severity', 'file', 'line', 'title', 'explanation', 'suggestedFix'],
          },
        },
      },
      required: ['summary', 'issues'],
    },
  };
}

let sharedClient: Anthropic | undefined;

function getAnthropicClient(): Anthropic {
  if (!sharedClient) {
    const { anthropicApiKey } = loadReviewConfig();
    sharedClient = new Anthropic({ apiKey: anthropicApiKey });
  }
  return sharedClient;
}

export interface RequestReviewParams {
  systemPrompt: string;
  userMessage: string;
  /** Overrides ANTHROPIC_MODEL/the default model. Mainly for tests - avoids needing config at all. */
  model?: string;
  maxTokens?: number;
}

/**
 * Calls the Claude Messages API with a forced `submit_review` tool call and returns its raw
 * (unvalidated) input. `client` is injectable so tests can supply a fake with no network access
 * and no ANTHROPIC_API_KEY set - `model` on its own is also enough to skip loadReviewConfig()
 * entirely when a client is supplied.
 */
export async function requestReview(
  { systemPrompt, userMessage, model, maxTokens }: RequestReviewParams,
  client: Anthropic = getAnthropicClient()
): Promise<unknown> {
  const resolvedModel = model ?? loadReviewConfig().model;

  const response = await client.messages.create({
    model: resolvedModel,
    // 8000 was too low for real-world PRs: a large diff (many files, many genuine findings, each
    // needing an explanation and a suggested fix) can need more room than that to complete the
    // submit_review tool call, and a response cut off mid-call by the max_tokens cap produces
    // truncated/invalid JSON - which then fails schema validation with a confusing "missing
    // required field" error that looks unrelated to its real cause. Confirmed live: a 20-file,
    // ~77KB diff hit exactly this on 2026-09-03. 16000 is the documented safe default for a
    // non-streaming request (stays comfortably under SDK HTTP timeouts).
    max_tokens: maxTokens ?? 16000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    tools: [buildReviewTool()],
    tool_choice: { type: 'tool', name: REVIEW_TOOL_NAME },
  });

  // Fail fast with a clear, specific diagnosis rather than letting a truncated tool call fall
  // through to a generic "missing required field" schema error downstream - stop_reason tells us
  // definitively that this was a token-budget cutoff, not a genuine model mistake.
  if (response.stop_reason === 'max_tokens') {
    throw new Error(
      `Claude's response was cut off by the max_tokens limit (${maxTokens ?? 16000}) before finishing the ${REVIEW_TOOL_NAME} tool call - the diff or the number of findings was too large for the configured budget.`
    );
  }

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === REVIEW_TOOL_NAME
  );

  if (!toolUse) {
    // Small local models (e.g. via Ollama) often emit the tool call as plain JSON text instead of a
    // real tool_use block. Accept that shape so they remain usable.
    const fallback = parseTextToolCall(response.content);
    if (fallback !== undefined) return fallback;
    throw new Error(`Claude did not return a ${REVIEW_TOOL_NAME} tool call.`);
  }

  return toolUse.input;
}

/**
 * Extracts the submit_review input from text like `{"name":"submit_review","arguments":{...}}`
 * (optionally wrapped in a ```json fence or surrounding prose). Returns undefined if none found.
 */
export function parseTextToolCall(content: Anthropic.ContentBlock[]): unknown {
  const text = content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const obj = parsed as Record<string, unknown>;
  if (obj.name === REVIEW_TOOL_NAME) {
    const args = obj.arguments ?? obj.input ?? obj.parameters;
    return typeof args === 'string' ? safeParse(args) : args;
  }
  // Model returned the bare arguments object with no wrapper.
  return 'summary' in obj || 'findings' in obj ? obj : undefined;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
