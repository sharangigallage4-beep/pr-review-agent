import { requestReview, type RequestReviewParams } from './claudeClient.js';
import { reviewPullRequest as reviewWithService } from './reviewService.js';

/**
 * The two places a review can be asked of: a model running on this computer through Ollama, or the Claude API.
 * Each has its own settings, so both can sit in one .env file and the UI can switch between them:
 *
 *   Claude  - CLAUDE_API_KEY, CLAUDE_MODEL
 *   Ollama  - OLLAMA_BASE_URL (default http://localhost:11434), OLLAMA_MODEL
 *   AI_PROVIDER - which one is used until the UI's choice says otherwise (ollama or claude)
 *
 * An older .env keeps working: with ANTHROPIC_BASE_URL set, ANTHROPIC_BASE_URL/ANTHROPIC_MODEL describe the
 * Ollama side; without it, ANTHROPIC_API_KEY/ANTHROPIC_MODEL describe the Claude side (as on a host or in
 * GitHub Actions, where only a Claude key exists).
 */
export type ProviderId = 'ollama' | 'claude';
export const PROVIDER_IDS: readonly ProviderId[] = ['ollama', 'claude'];

/** A problem with the chosen provider, written for the person using the page. */
export class ProviderError extends Error {}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  model: string;
  available: boolean;
  /** Why it cannot be used, when available is false. */
  reason?: string;
}

/** Everything needed to make requests: handed to the Anthropic SDK, which talks to either kind of server. */
export interface ResolvedProvider {
  id: ProviderId;
  apiKey: string;
  baseURL: string;
  model: string;
}

const CLAUDE_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'qwen2.5-coder:7b';

const clean = (value: string | undefined): string => (value ?? '').trim();
const onHostingService = (env: NodeJS.ProcessEnv): boolean => Boolean(env.RENDER || env.RAILWAY_ENVIRONMENT || env.FLY_APP_NAME);

export function isProviderId(value: unknown): value is ProviderId {
  return value === 'ollama' || value === 'claude';
}

function claudeKey(env: NodeJS.ProcessEnv): string {
  const explicit = clean(env.CLAUDE_API_KEY);
  if (explicit) return explicit;
  // Legacy: with no Ollama address configured, ANTHROPIC_API_KEY is the Claude key (unless it is the
  // "ollama" placeholder some setups use).
  const legacy = clean(env.ANTHROPIC_API_KEY);
  return !clean(env.ANTHROPIC_BASE_URL) && legacy && legacy !== 'ollama' ? legacy : '';
}

function claudeModel(env: NodeJS.ProcessEnv): string {
  return clean(env.CLAUDE_MODEL) || (!clean(env.ANTHROPIC_BASE_URL) ? clean(env.ANTHROPIC_MODEL) : '') || DEFAULT_CLAUDE_MODEL;
}

function ollamaUrl(env: NodeJS.ProcessEnv): string {
  return (clean(env.OLLAMA_BASE_URL) || clean(env.ANTHROPIC_BASE_URL) || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
}

function ollamaModel(env: NodeJS.ProcessEnv): string {
  return clean(env.OLLAMA_MODEL) || (clean(env.ANTHROPIC_BASE_URL) ? clean(env.ANTHROPIC_MODEL) : '') || DEFAULT_OLLAMA_MODEL;
}

/** Both providers with whether each can be used right now (no network call is made). */
export function listProviders(env: NodeJS.ProcessEnv): ProviderInfo[] {
  const ollamaConfigured = Boolean(clean(env.OLLAMA_BASE_URL) || clean(env.ANTHROPIC_BASE_URL));
  const ollamaUsable = ollamaConfigured || !onHostingService(env);
  return [
    {
      id: 'ollama',
      label: 'Ollama (this computer)',
      model: ollamaModel(env),
      available: ollamaUsable,
      reason: ollamaUsable ? undefined : 'Ollama runs on your own computer, which a hosting service cannot reach. Set OLLAMA_BASE_URL to a server it can reach.',
    },
    {
      id: 'claude',
      label: 'Claude (API)',
      model: claudeModel(env),
      available: Boolean(claudeKey(env)),
      reason: claudeKey(env) ? undefined : 'There is no Claude API key. Add CLAUDE_API_KEY=... to the .env file and restart the server.',
    },
  ];
}

/** The provider used when nothing has been chosen in the UI: AI_PROVIDER, else the one the .env implies. */
export function defaultProviderId(env: NodeJS.ProcessEnv): ProviderId {
  const providers = listProviders(env);
  const usable = (id: ProviderId) => providers.find((p) => p.id === id)?.available === true;
  const wanted = clean(env.AI_PROVIDER).toLowerCase();
  if (isProviderId(wanted) && usable(wanted)) return wanted;
  if (clean(env.ANTHROPIC_BASE_URL)) return 'ollama';
  if (usable('claude')) return 'claude';
  return 'ollama';
}

/** The settings to call a provider with; throws a ProviderError that says what is missing. */
export function resolveProvider(id: ProviderId, env: NodeJS.ProcessEnv): ResolvedProvider {
  const info = listProviders(env).find((p) => p.id === id);
  if (!info) throw new ProviderError(`Unknown AI provider "${String(id)}".`);
  if (!info.available) throw new ProviderError(info.reason ?? `${info.label} is not available.`);
  return id === 'claude'
    ? // Always the real Claude address, even when ANTHROPIC_BASE_URL points somewhere else for Ollama.
      { id, apiKey: claudeKey(env), baseURL: CLAUDE_BASE_URL, model: info.model }
    : { id, apiKey: 'ollama', baseURL: ollamaUrl(env), model: info.model };
}

/** The base address of the Ollama server, for the UI's "is it running?" check. */
export function ollamaBaseUrl(env: NodeJS.ProcessEnv): string {
  return ollamaUrl(env);
}

/**
 * A review function that asks the given provider - what the workflow calls in place of its default.
 * `send` is how the request is made; tests replace it so nothing goes over the network.
 */
export function reviewerFor(
  provider: ResolvedProvider,
  send: typeof requestReview = requestReview,
  onUsage?: RequestReviewParams['onUsage']
): typeof reviewWithService {
  return (input, deps = {}) =>
    reviewWithService(input, { ...deps, requestReview: (params) => send({ ...params, provider, ...(onUsage ? { onUsage } : {}) }) });
}
