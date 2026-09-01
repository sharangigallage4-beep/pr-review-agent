import { RequestError } from '@octokit/request-error';

/**
 * A safe, transport-agnostic error for anything that goes wrong talking to GitHub - whether
 * that's an actual Octokit/HTTP failure or a semantic problem the service layer detects itself
 * (e.g. "that path is a directory, not a file"). Carries only fields safe to log or return to a
 * caller: never the Authorization header, never `err.request`.
 */
export class GitHubServiceError extends Error {
  readonly status?: number;
  readonly documentationUrl?: string;
  readonly details?: unknown;

  // Deliberately does NOT accept/attach the original caught error as `cause`, even though that's
  // a normal thing to do. `cause` on a native Error (set via the constructor's options object) is
  // an enumerable own property, so it WOULD survive a naive JSON.stringify(err)/console.log(err)
  // - and the original error, for a source other than RequestError, is untrusted: it could be
  // carrying more than expected. Nothing in this codebase currently reads `.cause`, so there is
  // no reason to hold onto the raw original error at all, safe or not.
  constructor(message: string, options?: { status?: number; documentationUrl?: string; details?: unknown }) {
    super(message);
    this.name = 'GitHubServiceError';
    this.status = options?.status;
    this.documentationUrl = options?.documentationUrl;
    this.details = options?.details;
  }
}

/**
 * Normalizes any error thrown by an Octokit call into a GitHubServiceError. This is the one
 * place that reads Octokit's RequestError shape - it deliberately reads only
 * `status`/`response.data.message`/`response.data.documentation_url`/`response.data.errors`,
 * never `err.request` or `err.response.headers`, which is where the
 * `Authorization: token <GITHUB_TOKEN>` header lives. Every github/*Service.ts function funnels
 * its catch blocks through this, so "don't leak the token" only has to be gotten right once.
 */
export function toGitHubServiceError(err: unknown): GitHubServiceError {
  if (err instanceof GitHubServiceError) return err;

  if (err instanceof RequestError) {
    const data = err.response?.data as
      | { message?: string; documentation_url?: string; errors?: unknown }
      | undefined;
    return new GitHubServiceError(data?.message || err.message || 'GitHub API request failed.', {
      status: err.status,
      documentationUrl: data?.documentation_url,
      details: data?.errors,
    });
  }

  if (err instanceof Error) {
    return new GitHubServiceError(err.message);
  }

  return new GitHubServiceError('Unknown error.');
}

export interface ToolErrorResult {
  // Index signature to structurally match the MCP SDK's CallToolResult type, which allows
  // arbitrary extra top-level fields alongside `content`/`isError`.
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError: true;
}

/**
 * MCP-shape adapter used only by tool handlers (src/mcp/tools/*.ts) - turns any error (service
 * or otherwise) into a structured MCP tool error result.
 */
export function toToolError(err: unknown, context: string): ToolErrorResult {
  const safe = toGitHubServiceError(err);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            error: true,
            tool: context,
            status: safe.status,
            message: safe.message,
            documentation_url: safe.documentationUrl,
            details: safe.details,
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}
