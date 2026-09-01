import type { ToolRegistrar } from '../toolRegistrar.js';
import { getChangedFiles } from '../../github/prService.js';
import { toToolError } from '../../github/errors.js';
import { getChangedFilesInput } from '../../schemas.js';

export function registerGetChangedFiles(server: ToolRegistrar): void {
  server.registerTool(
    'get_changed_files',
    {
      title: 'Get files changed by a pull request',
      description:
        'List the files changed by a pull request, with status (added/modified/removed/renamed), ' +
        'additions, deletions, and the per-file unified diff patch. Paginated - GitHub returns at ' +
        'most 100 files per page, so check `total_count` and page through for large PRs.',
      inputSchema: getChangedFilesInput,
    },
    async ({ owner, repo, pull_number, page, per_page }) => {
      try {
        const result = await getChangedFiles({ owner, repo, pullNumber: pull_number, page, perPage: per_page });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toToolError(err, 'get_changed_files');
      }
    }
  );
}
