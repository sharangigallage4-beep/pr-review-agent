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
    max_tokens: maxTokens ?? 8000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    tools: [buildReviewTool()],
    tool_choice: { type: 'tool', name: REVIEW_TOOL_NAME },
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === REVIEW_TOOL_NAME
  );

  if (!toolUse) {
    throw new Error(`Claude did not return a ${REVIEW_TOOL_NAME} tool call.`);
  }

  return toolUse.input;
}
