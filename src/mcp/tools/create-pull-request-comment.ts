import type { ToolRegistrar } from '../toolRegistrar.js';
import { createPullRequestComment } from '../../github/prService.js';
import { toToolError } from '../../github/errors.js';
import { createPullRequestCommentInput } from '../../schemas.js';

export function registerCreatePullRequestComment(server: ToolRegistrar): void {
  server.registerTool(
    'create_pull_request_comment',
    {
      title: 'Add a single review comment to a specific line',
      description:
        'Post one inline review comment on a specific file/line of a pull request. For posting ' +
        'several findings at once, prefer create_pull_request_review with its `comments` array - ' +
        'it batches them into a single GitHub review instead of one notification per comment.',
      inputSchema: createPullRequestCommentInput,
    },
    async ({ owner, repo, pull_number, path, line, side, body, commit_id }) => {
      try {
        const result = await createPullRequestComment({
          owner,
          repo,
          pullNumber: pull_number,
          path,
          line,
          side,
          body,
          commitId: commit_id,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toToolError(err, 'create_pull_request_comment');
      }
    }
  );
}
