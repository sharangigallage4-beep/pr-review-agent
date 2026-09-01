import type { ToolRegistrar } from '../toolRegistrar.js';
import { getExistingReviewComments } from '../../github/prService.js';
import { toToolError } from '../../github/errors.js';
import { loadConfig } from '../../config.js';
import { getExistingReviewCommentsInput } from '../../schemas.js';

export function registerGetExistingReviewComments(server: ToolRegistrar): void {
  server.registerTool(
    'get_existing_review_comments',
    {
      title: 'Get existing pull request review comments',
      description:
        'List existing inline review comments on a pull request, filtered by default to this ' +
        "bot's own prior comments. Call this before posting new findings so the caller can skip " +
        'anything already commented on and avoid duplicate comments across repeated PR updates.',
      inputSchema: getExistingReviewCommentsInput,
    },
    async ({ owner, repo, pull_number, author, include_all_authors, page, per_page }) => {
      try {
        const result = await getExistingReviewComments({
          owner,
          repo,
          pullNumber: pull_number,
          author,
          includeAllAuthors: include_all_authors,
          page,
          perPage: per_page,
          knownBotLogin: loadConfig().botLogin,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toToolError(err, 'get_existing_review_comments');
      }
    }
  );
}
