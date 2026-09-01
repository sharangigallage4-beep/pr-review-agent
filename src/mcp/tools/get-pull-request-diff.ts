import type { ToolRegistrar } from '../toolRegistrar.js';
import { getPullRequestDiff } from '../../github/prService.js';
import { toToolError } from '../../github/errors.js';
import { getPullRequestDiffInput } from '../../schemas.js';

export function registerGetPullRequestDiff(server: ToolRegistrar): void {
  server.registerTool(
    'get_pull_request_diff',
    {
      title: 'Get the complete pull request diff',
      description:
        'Fetch the full unified diff for a pull request, across all changed files. For very ' +
        'large PRs, prefer get_changed_files (which gives per-file patches you can page through) ' +
        'over pulling the entire diff at once.',
      inputSchema: getPullRequestDiffInput,
    },
    async ({ owner, repo, pull_number, max_bytes }) => {
      try {
        const result = await getPullRequestDiff({ owner, repo, pullNumber: pull_number, maxBytes: max_bytes });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toToolError(err, 'get_pull_request_diff');
      }
    }
  );
}
