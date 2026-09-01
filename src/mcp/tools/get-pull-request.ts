import type { ToolRegistrar } from '../toolRegistrar.js';
import { getPullRequest } from '../../github/prService.js';
import { toToolError } from '../../github/errors.js';
import { getPullRequestInput } from '../../schemas.js';

export function registerGetPullRequest(server: ToolRegistrar): void {
  server.registerTool(
    'get_pull_request',
    {
      title: 'Get pull request metadata',
      description:
        'Fetch metadata for a single GitHub pull request: repository, PR number, title, ' +
        'description, author, state, and base/head branches. Use this first to orient on which ' +
        'PR is being reviewed before pulling its diff or file contents.',
      inputSchema: getPullRequestInput,
    },
    async ({ owner, repo, pull_number }) => {
      try {
        const result = await getPullRequest({ owner, repo, pullNumber: pull_number });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toToolError(err, 'get_pull_request');
      }
    }
  );
}
