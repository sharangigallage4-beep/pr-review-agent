import type { ToolRegistrar } from '../toolRegistrar.js';
import { registerGetPullRequest } from './get-pull-request.js';
import { registerGetPullRequestDiff } from './get-pull-request-diff.js';
import { registerGetChangedFiles } from './get-changed-files.js';
import { registerGetFileContent } from './get-file-content.js';
import { registerCreatePullRequestComment } from './create-pull-request-comment.js';
import { registerCreatePullRequestReview } from './create-pull-request-review.js';
import { registerGetExistingReviewComments } from './get-existing-review-comments.js';

export function registerAllTools(server: ToolRegistrar): void {
  registerGetPullRequest(server);
  registerGetPullRequestDiff(server);
  registerGetChangedFiles(server);
  registerGetFileContent(server);
  registerCreatePullRequestComment(server);
  registerCreatePullRequestReview(server);
  registerGetExistingReviewComments(server);
}
