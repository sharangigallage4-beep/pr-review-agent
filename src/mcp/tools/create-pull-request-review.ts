import type { ToolRegistrar } from '../toolRegistrar.js';
import { createPullRequestReview } from '../../github/prService.js';
import { toToolError } from '../../github/errors.js';
import { createPullRequestReviewInput } from '../../schemas.js';

export function registerCreatePullRequestReview(server: ToolRegistrar): void {
  server.registerTool(
    'create_pull_request_review',
    {
      title: 'Submit an overall pull request review',
      description:
        'Submit a complete GitHub pull request review with an overall verdict (APPROVE, ' +
        'REQUEST_CHANGES, or COMMENT), an optional summary body, and an optional batch of inline ' +
        'line comments submitted together as one review. Prefer this over multiple ' +
        'create_pull_request_comment calls when posting several findings at once.',
      inputSchema: createPullRequestReviewInput,
    },
    async ({ owner, repo, pull_number, event, body, commit_id, comments }) => {
      try {
        const result = await createPullRequestReview({
          owner,
          repo,
          pullNumber: pull_number,
          event,
          body,
          commitId: commit_id,
          comments,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toToolError(err, 'create_pull_request_review');
      }
    }
  );
}
