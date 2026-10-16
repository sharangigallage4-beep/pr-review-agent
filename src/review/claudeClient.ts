import Anthropic from '@anthropic-ai/sdk';
import { loadReviewConfig } from './config.js';
import type { ResolvedProvider } from './providers.js';
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
const providerClients = new Map<string, Anthropic>();

/** One SDK client per provider (address + key), created on first use. */
function clientFor(provider: ResolvedProvider): Anthropic {
  const key = `${provider.baseURL}
${provider.apiKey}`;
  let client = providerClients.get(key);
  if (!client) {
    // baseURL is always given explicitly: otherwise the SDK would pick up ANTHROPIC_BASE_URL from the
    // environment, which would send a Claude request to the Ollama address.
    client = new Anthropic({ apiKey: provider.apiKey, baseURL: provider.baseURL });
    providerClients.set(key, client);
  }
  return client;
}

/**
 * Models that rejected a forced tool call ("tool_choice: type tool and any are not supported for this
 * model" - newer Claude models that think before answering behave this way). Once a model has said so,
 * requests for it go straight to automatic tool choice instead of failing first every time.
 */
const modelsWithoutForcedToolChoice = new Set<string>();

function isForcedToolChoiceRejected(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { status, message } = err as { status?: unknown; message?: unknown };
  return status === 400 && typeof message === 'string' && /tool_choice/i.test(message);
}

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
  /** Which server and model to ask (Claude or Ollama). When given it replaces `model` and the environment. */
  provider?: ResolvedProvider;
  maxTokens?: number;
  /** Told how many tokens each response used, so the UI can show what a review cost. */
  onUsage?: (usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; model: string }) => void;
}

/**
 * Calls the Claude Messages API with a `submit_review` tool call (forced where the model allows it) and returns its raw
 * (unvalidated) input. `client` is injectable so tests can supply a fake with no network access
 * and no ANTHROPIC_API_KEY set - `model` on its own is also enough to skip loadReviewConfig()
 * entirely when a client is supplied.
 */
/**
 * Whether the fixed part of the request (the instructions and the team rules) is marked for Anthropic's prompt
 * cache. The rules are the same for every pull request, so a review made soon after another one (the cache lasts
 * about five minutes) is charged for those tokens at a fraction of the normal price instead of in full. Only for
 * Claude itself - an Ollama server has no such cache. CLAUDE_PROMPT_CACHE=off turns it off.
 */
export function promptCachingOn(provider: ResolvedProvider | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.CLAUDE_PROMPT_CACHE ?? '').trim().toLowerCase() === 'off') return false;
  if (provider) return provider.id === 'claude';
  return !(env.ANTHROPIC_BASE_URL ?? '').trim();
}

export async function requestReview(
  { systemPrompt, userMessage, model, maxTokens, provider, onUsage }: RequestReviewParams,
  injectedClient?: Anthropic
): Promise<unknown> {
  const client = injectedClient ?? (provider ? clientFor(provider) : getAnthropicClient());
  const resolvedModel = provider?.model ?? model ?? loadReviewConfig().model;

  const createMessage = (toolChoice: Anthropic.ToolChoice) => client.messages.create({
    model: resolvedModel,
    // 8000 was too low for real-world PRs: a large diff (many files, many genuine findings, each
    // needing an explanation and a suggested fix) can need more room than that to complete the
    // submit_review tool call, and a response cut off mid-call by the max_tokens cap produces
    // truncated/invalid JSON - which then fails schema validation with a confusing "missing
    // required field" error that looks unrelated to its real cause. Confirmed live: a 20-file,
    // ~77KB diff hit exactly this on 2026-09-03. 16000 is the documented safe default for a
    // non-streaming request (stays comfortably under SDK HTTP timeouts).
    max_tokens: maxTokens ?? 16000,
    system: promptCachingOn(provider)
      ? [{ type: 'text' as const, text: systemPrompt, cache_control: { type: 'ephemeral' as const } }]
      : systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    tools: [buildReviewTool()],
    tool_choice: toolChoice,
  });

  // Force the submit_review call where the model allows it. Where it does not, fall back to automatic
  // tool choice: the system prompt already requires the call, and a text answer in the same shape is
  // still accepted below.
  let response: Anthropic.Message;
  if (modelsWithoutForcedToolChoice.has(resolvedModel)) {
    response = await createMessage({ type: 'auto' });
  } else {
    try {
      response = await createMessage({ type: 'tool', name: REVIEW_TOOL_NAME });
    } catch (err) {
      if (!isForcedToolChoiceRejected(err)) throw err;
      modelsWithoutForcedToolChoice.add(resolvedModel);
      response = await createMessage({ type: 'auto' });
    }
  }

  // Counted before any check below: a response that is cut off or unusable still used (and cost) tokens.
  const used = response.usage;
  if (used && onUsage) {
    onUsage({
      // Counted apart: tokens read from the cache cost a fraction, tokens written to it a little extra.
      inputTokens: used.input_tokens ?? 0,
      outputTokens: used.output_tokens ?? 0,
      cacheReadTokens: used.cache_read_input_tokens ?? 0,
      cacheWriteTokens: used.cache_creation_input_tokens ?? 0,
      model: resolvedModel,
    });
  }

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
