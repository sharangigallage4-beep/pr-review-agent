import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpBackedGithubDeps } from './githubViaMcp.js';
import type { McpClientHandle } from './client.js';

// Verifies the MAPPING logic - camelCase workflow params -> snake_case MCP tool arguments,
// matching each tool's actual input schema in src/schemas.ts - using a fake McpClientHandle. The
// real end-to-end round trip (spawning the actual MCP server subprocess and getting a real
// response back) was verified live rather than unit tested here: node --import tsx
// src/cli/autoReview.ts against a dummy token shows the real "[mcp] -> get_pull_request" /
// Octokit request / error-propagation sequence, which a fake client can't meaningfully re-prove.

function fakeMcp(callTool: McpClientHandle['callTool']): McpClientHandle {
  return { callTool, close: async () => {} };
}

describe('buildMcpBackedGithubDeps', () => {
  test('getPullRequest calls get_pull_request with snake_case pull_number', async () => {
    let captured: { name: string; args: Record<string, unknown> } | undefined;
    const deps = buildMcpBackedGithubDeps(
      fakeMcp(async (name, args) => {
        captured = { name, args };
        return {} as never;
      })
    );

    await deps.getPullRequest({ owner: 'acme', repo: 'widgets', pullNumber: 7 });

    assert.equal(captured?.name, 'get_pull_request');
    assert.deepEqual(captured?.args, { owner: 'acme', repo: 'widgets', pull_number: 7 });
  });

  test('getChangedFiles maps page/perPage to page/per_page', async () => {
    let captured: Record<string, unknown> | undefined;
    const deps = buildMcpBackedGithubDeps(
      fakeMcp(async (_name, args) => {
        captured = args;
        return {} as never;
      })
    );

    await deps.getChangedFiles({ owner: 'acme', repo: 'widgets', pullNumber: 7, page: 2, perPage: 50 });

    assert.deepEqual(captured, { owner: 'acme', repo: 'widgets', pull_number: 7, page: 2, per_page: 50 });
  });

  test('getPullRequestDiff maps maxBytes to max_bytes', async () => {
    let captured: Record<string, unknown> | undefined;
    const deps = buildMcpBackedGithubDeps(
      fakeMcp(async (_name, args) => {
        captured = args;
        return {} as never;
      })
    );

    await deps.getPullRequestDiff({ owner: 'acme', repo: 'widgets', pullNumber: 7, maxBytes: 1000 });

    assert.deepEqual(captured, { owner: 'acme', repo: 'widgets', pull_number: 7, max_bytes: 1000 });
  });

  test('getExistingReviewComments maps includeAllAuthors/perPage and never forwards knownBotLogin (not a real tool parameter)', async () => {
    let captured: Record<string, unknown> | undefined;
    const deps = buildMcpBackedGithubDeps(
      fakeMcp(async (_name, args) => {
        captured = args;
        return {} as never;
      })
    );

    await deps.getExistingReviewComments({
      owner: 'acme',
      repo: 'widgets',
      pullNumber: 7,
      includeAllAuthors: true,
      perPage: 10,
      knownBotLogin: 'pr-review-bot',
    });

    assert.deepEqual(captured, {
      owner: 'acme',
      repo: 'widgets',
      pull_number: 7,
      author: undefined,
      include_all_authors: true,
      page: undefined,
      per_page: 10,
    });
    assert.equal('knownBotLogin' in (captured ?? {}), false);
    assert.equal('known_bot_login' in (captured ?? {}), false);
  });

  test('createPullRequestReview maps commitId to commit_id and forwards comments/event/body as-is', async () => {
    let captured: Record<string, unknown> | undefined;
    const deps = buildMcpBackedGithubDeps(
      fakeMcp(async (_name, args) => {
        captured = args;
        return {} as never;
      })
    );

    const comments = [{ path: 'a.ts', line: 1, body: 'x' }];
    await deps.createPullRequestReview({
      owner: 'acme',
      repo: 'widgets',
      pullNumber: 7,
      event: 'COMMENT',
      body: 'summary',
      commitId: 'sha123',
      comments,
    });

    assert.deepEqual(captured, {
      owner: 'acme',
      repo: 'widgets',
      pull_number: 7,
      event: 'COMMENT',
      body: 'summary',
      commit_id: 'sha123',
      comments,
    });
  });

  test('propagates whatever the MCP tool call returns/throws unchanged', async () => {
    const deps = buildMcpBackedGithubDeps(
      fakeMcp(async () => {
        const err = new Error('Bad credentials') as Error & { status?: number };
        err.status = 401;
        throw err;
      })
    );

    await assert.rejects(() => deps.getPullRequest({ owner: 'acme', repo: 'widgets', pullNumber: 1 }), /Bad credentials/);
  });
});
