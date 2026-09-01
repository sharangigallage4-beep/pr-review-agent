import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Octokit } from '@octokit/rest';
import { RequestError } from '@octokit/request-error';
import {
  getPullRequest,
  getPullRequestDiff,
  getChangedFiles,
  getFileContent,
  createPullRequestComment,
  createPullRequestReview,
  getExistingReviewComments,
} from './prService.js';
import { GitHubServiceError } from './errors.js';

// Each test injects a minimal fake Octokit - just the `rest.*` methods the function under test
// actually calls - instead of hitting the real GitHub API or a network-mocking library. Every
// call also passes owner/repo explicitly, so none of these tests need GITHUB_TOKEN/OWNER/REPO
// set (resolveRepoRef only falls back to env config when owner or repo is omitted).
function fakeOctokit(overrides: Record<string, unknown>): Octokit {
  return overrides as unknown as Octokit;
}

describe('getPullRequest', () => {
  test('maps a GitHub PR response to PullRequestMetadata', async () => {
    const octokit = fakeOctokit({
      rest: {
        pulls: {
          get: async (params: unknown) => {
            assert.deepEqual(params, { owner: 'acme', repo: 'widgets', pull_number: 42 });
            return {
              data: {
                number: 42,
                title: 'Fix the thing',
                body: 'Fixes #1',
                user: { login: 'alice' },
                state: 'open',
                draft: false,
                base: { ref: 'main', sha: 'base-sha' },
                head: { ref: 'fix-branch', sha: 'head-sha' },
                html_url: 'https://github.com/acme/widgets/pull/42',
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-02T00:00:00Z',
              },
            };
          },
        },
      },
    });

    const result = await getPullRequest({ owner: 'acme', repo: 'widgets', pullNumber: 42 }, octokit);

    assert.equal(result.repository, 'acme/widgets');
    assert.equal(result.title, 'Fix the thing');
    assert.equal(result.author, 'alice');
    assert.deepEqual(result.base, { ref: 'main', sha: 'base-sha' });
    assert.deepEqual(result.head, { ref: 'fix-branch', sha: 'head-sha' });
  });

  test('defaults a missing description to an empty string, not null', async () => {
    const octokit = fakeOctokit({
      rest: {
        pulls: {
          get: async () => ({
            data: {
              number: 1,
              title: 'No description',
              body: null,
              user: null,
              state: 'open',
              base: { ref: 'main', sha: 'a' },
              head: { ref: 'b', sha: 'b' },
              html_url: 'https://github.com/acme/widgets/pull/1',
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
            },
          }),
        },
      },
    });

    const result = await getPullRequest({ owner: 'acme', repo: 'widgets', pullNumber: 1 }, octokit);
    assert.equal(result.description, '');
    assert.equal(result.author, null);
  });

  test('wraps a 404 from Octokit into a GitHubServiceError, without the request/headers', async () => {
    const octokit = fakeOctokit({
      rest: {
        pulls: {
          get: async () => {
            throw new RequestError('Not Found', 404, {
              request: { method: 'GET', url: 'https://api.github.com/repos/acme/widgets/pulls/999', headers: {} },
              response: {
                status: 404,
                url: 'https://api.github.com/repos/acme/widgets/pulls/999',
                headers: {},
                data: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' },
              },
            });
          },
        },
      },
    });

    await assert.rejects(
      () => getPullRequest({ owner: 'acme', repo: 'widgets', pullNumber: 999 }, octokit),
      (err: unknown) => {
        assert.ok(err instanceof GitHubServiceError);
        assert.equal(err.status, 404);
        assert.equal(err.message, 'Not Found');
        assert.equal(err.documentationUrl, 'https://docs.github.com/rest');
        // The whole point of GitHubServiceError: serializing it must never surface a token.
        assert.equal(JSON.stringify(err).includes('Authorization'), false);
        return true;
      }
    );
  });
});

describe('getPullRequestDiff', () => {
  test('returns the raw diff untruncated when under the byte limit', async () => {
    const octokit = fakeOctokit({
      rest: {
        pulls: {
          get: async (params: unknown) => {
            assert.deepEqual(params, {
              owner: 'acme',
              repo: 'widgets',
              pull_number: 7,
              mediaType: { format: 'diff' },
            });
            return { data: 'diff --git a/x b/x\n+hello\n' };
          },
        },
      },
    });

    const result = await getPullRequestDiff({ owner: 'acme', repo: 'widgets', pullNumber: 7 }, octokit);
    assert.equal(result.truncated, false);
    assert.equal(result.diff, 'diff --git a/x b/x\n+hello\n');
    assert.equal(result.total_bytes, result.diff.length);
  });

  test('truncates the diff and reports truncated: true when it exceeds maxBytes', async () => {
    const bigDiff = 'x'.repeat(1000);
    const octokit = fakeOctokit({
      rest: { pulls: { get: async () => ({ data: bigDiff }) } },
    });

    const result = await getPullRequestDiff({ owner: 'acme', repo: 'widgets', pullNumber: 7, maxBytes: 100 }, octokit);
    assert.equal(result.truncated, true);
    assert.equal(result.diff.length, 100);
    assert.equal(result.total_bytes, 1000);
  });
});

describe('getChangedFiles', () => {
  test('maps files and paginates using the given page/perPage', async () => {
    const octokit = fakeOctokit({
      rest: {
        pulls: {
          listFiles: async (params: unknown) => {
            assert.deepEqual(params, { owner: 'acme', repo: 'widgets', pull_number: 5, page: 2, per_page: 10 });
            return {
              data: [
                { filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, changes: 4, patch: '@@ -1 +1 @@' },
                { filename: 'src/b.ts', status: 'added', additions: 10, deletions: 0, changes: 10, patch: undefined },
              ],
            };
          },
          get: async () => ({ data: { changed_files: 12 } }),
        },
      },
    });

    const result = await getChangedFiles({ owner: 'acme', repo: 'widgets', pullNumber: 5, page: 2, perPage: 10 }, octokit);
    assert.equal(result.total_count, 12);
    assert.equal(result.files.length, 2);
    assert.equal(result.files[0].patch, '@@ -1 +1 @@');
    assert.equal(result.files[1].patch, null); // undefined patch normalized to null
  });
});

describe('getFileContent', () => {
  test('decodes base64 text content', async () => {
    const octokit = fakeOctokit({
      rest: {
        repos: {
          getContent: async (params: unknown) => {
            assert.deepEqual(params, { owner: 'acme', repo: 'widgets', path: 'src/index.ts', ref: 'head-sha' });
            return {
              data: {
                type: 'file',
                sha: 'abc123',
                size: 13,
                encoding: 'base64',
                content: Buffer.from('hello world!').toString('base64'),
              },
            };
          },
        },
      },
    });

    const result = await getFileContent({ owner: 'acme', repo: 'widgets', path: 'src/index.ts', ref: 'head-sha' }, octokit);
    assert.equal(result.content, 'hello world!');
    assert.equal(result.binary, undefined);
  });

  test('flags binary files instead of returning garbled text', async () => {
    const binaryBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    const octokit = fakeOctokit({
      rest: {
        repos: {
          getContent: async () => ({
            data: { type: 'file', sha: 'abc', size: binaryBuffer.length, encoding: 'base64', content: binaryBuffer.toString('base64') },
          }),
        },
      },
    });

    const result = await getFileContent({ owner: 'acme', repo: 'widgets', path: 'logo.png', ref: 'head-sha' }, octokit);
    assert.equal(result.binary, true);
    assert.equal(result.content, undefined);
  });

  test('flags oversized files as truncated instead of returning content', async () => {
    const octokit = fakeOctokit({
      rest: {
        repos: {
          getContent: async () => ({ data: { type: 'file', sha: 'abc', size: 10_000_000, encoding: 'base64', content: '' } }),
        },
      },
    });

    const result = await getFileContent({ owner: 'acme', repo: 'widgets', path: 'huge.txt', ref: 'head-sha' }, octokit);
    assert.equal(result.truncated, true);
    assert.equal(result.content, undefined);
  });

  test('throws GitHubServiceError when the path is a directory, not a file', async () => {
    const octokit = fakeOctokit({
      rest: { repos: { getContent: async () => ({ data: [{ type: 'dir', name: 'src' }] }) } },
    });

    await assert.rejects(
      () => getFileContent({ owner: 'acme', repo: 'widgets', path: 'src', ref: 'head-sha' }, octokit),
      (err: unknown) => err instanceof GitHubServiceError && /not a file/.test(err.message)
    );
  });
});

describe('createPullRequestComment', () => {
  test('auto-resolves commit_id from the PR head when not given', async () => {
    let getCalled = false;
    const octokit = fakeOctokit({
      rest: {
        pulls: {
          get: async () => {
            getCalled = true;
            return { data: { head: { sha: 'resolved-head-sha' } } };
          },
          createReviewComment: async (params: { commit_id: string; side: string }) => {
            assert.equal(params.commit_id, 'resolved-head-sha');
            assert.equal(params.side, 'RIGHT');
            return {
              data: {
                id: 111,
                html_url: 'https://github.com/acme/widgets/pull/1#discussion_r111',
                path: 'src/index.ts',
                line: 10,
                side: 'RIGHT',
                body: 'Consider handling the null case here.',
                commit_id: 'resolved-head-sha',
                created_at: '2026-01-01T00:00:00Z',
              },
            };
          },
        },
      },
    });

    const result = await createPullRequestComment(
      { owner: 'acme', repo: 'widgets', pullNumber: 1, path: 'src/index.ts', line: 10, body: 'Consider handling the null case here.' },
      octokit
    );

    assert.equal(getCalled, true);
    assert.equal(result.commit_id, 'resolved-head-sha');
    assert.equal(result.id, 111);
  });

  test('uses the given commit_id and skips resolving the PR head', async () => {
    let getCalled = false;
    const octokit = fakeOctokit({
      rest: {
        pulls: {
          get: async () => {
            getCalled = true;
            return { data: { head: { sha: 'should-not-be-used' } } };
          },
          createReviewComment: async (params: { commit_id: string }) => {
            assert.equal(params.commit_id, 'explicit-sha');
            return {
              data: {
                id: 1,
                html_url: 'url',
                path: 'a.ts',
                line: 1,
                side: 'RIGHT',
                body: 'x',
                commit_id: 'explicit-sha',
                created_at: '2026-01-01T00:00:00Z',
              },
            };
          },
        },
      },
    });

    await createPullRequestComment(
      { owner: 'acme', repo: 'widgets', pullNumber: 1, path: 'a.ts', line: 1, body: 'x', commitId: 'explicit-sha' },
      octokit
    );

    assert.equal(getCalled, false);
  });
});

describe('createPullRequestReview', () => {
  test('submits a review with batched comments and reports comments_count', async () => {
    const octokit = fakeOctokit({
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: 'head-sha' } } }),
          createReview: async (params: { event: string; comments?: unknown[] }) => {
            assert.equal(params.event, 'COMMENT');
            assert.equal(params.comments?.length, 2);
            return { data: { id: 999, html_url: 'https://github.com/acme/widgets/pull/1#pullrequestreview-999', state: 'COMMENTED', submitted_at: '2026-01-01T00:00:00Z' } };
          },
        },
      },
    });

    const result = await createPullRequestReview(
      {
        owner: 'acme',
        repo: 'widgets',
        pullNumber: 1,
        event: 'COMMENT',
        body: 'A few findings',
        comments: [
          { path: 'a.ts', line: 1, body: 'issue one' },
          { path: 'b.ts', line: 2, body: 'issue two' },
        ],
      },
      octokit
    );

    assert.equal(result.state, 'COMMENTED');
    assert.equal(result.comments_count, 2);
  });
});

describe('getExistingReviewComments', () => {
  test('filters to knownBotLogin without calling GET /user', async () => {
    let getAuthenticatedCalled = false;
    const octokit = fakeOctokit({
      rest: {
        users: {
          getAuthenticated: async () => {
            getAuthenticatedCalled = true;
            return { data: { login: 'should-not-be-used' } };
          },
        },
        pulls: {
          listReviewComments: async () => ({
            data: [
              { id: 1, path: 'a.ts', line: 1, side: 'RIGHT', body: 'bot comment', user: { login: 'pr-review-bot' }, created_at: '', updated_at: '', commit_id: 'x' },
              { id: 2, path: 'b.ts', line: 2, side: 'RIGHT', body: 'human comment', user: { login: 'alice' }, created_at: '', updated_at: '', commit_id: 'x' },
            ],
          }),
        },
      },
    });

    const result = await getExistingReviewComments(
      { owner: 'acme', repo: 'widgets', pullNumber: 1, knownBotLogin: 'pr-review-bot' },
      octokit
    );

    assert.equal(getAuthenticatedCalled, false);
    assert.equal(result.count, 1);
    assert.equal(result.comments[0].author, 'pr-review-bot');
    assert.equal(result.filtered_by_author, 'pr-review-bot');
  });

  test('falls back to all authors with a note when GET /user is unavailable', async () => {
    const octokit = fakeOctokit({
      rest: {
        users: {
          getAuthenticated: async () => {
            throw new Error('Resource not accessible by integration');
          },
        },
        pulls: {
          listReviewComments: async () => ({
            data: [
              { id: 1, path: 'a.ts', line: 1, side: 'RIGHT', body: 'x', user: { login: 'alice' }, created_at: '', updated_at: '', commit_id: 'x' },
            ],
          }),
        },
      },
    });

    const result = await getExistingReviewComments({ owner: 'acme', repo: 'widgets', pullNumber: 1 }, octokit);

    assert.equal(result.filtered_by_author, null);
    assert.equal(result.count, 1);
    assert.match(result.note ?? '', /Could not auto-detect/);
  });

  test('include_all_authors skips filtering even when knownBotLogin is set', async () => {
    const octokit = fakeOctokit({
      rest: {
        pulls: {
          listReviewComments: async () => ({
            data: [
              { id: 1, path: 'a.ts', line: 1, side: 'RIGHT', body: 'x', user: { login: 'pr-review-bot' }, created_at: '', updated_at: '', commit_id: 'x' },
              { id: 2, path: 'b.ts', line: 2, side: 'RIGHT', body: 'y', user: { login: 'alice' }, created_at: '', updated_at: '', commit_id: 'x' },
            ],
          }),
        },
      },
    });

    const result = await getExistingReviewComments(
      { owner: 'acme', repo: 'widgets', pullNumber: 1, knownBotLogin: 'pr-review-bot', includeAllAuthors: true },
      octokit
    );

    assert.equal(result.count, 2);
    assert.equal(result.filtered_by_author, null);
  });
});
