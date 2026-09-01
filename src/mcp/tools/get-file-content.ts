import type { ToolRegistrar } from '../toolRegistrar.js';
import { getFileContent } from '../../github/prService.js';
import { toToolError } from '../../github/errors.js';
import { getFileContentInput } from '../../schemas.js';

export function registerGetFileContent(server: ToolRegistrar): void {
  server.registerTool(
    'get_file_content',
    {
      title: 'Get the content of a file at a given ref',
      description:
        'Fetch the current text content of a single file at a specific git ref (commit SHA, ' +
        'branch, or tag) - typically the PR head SHA, to see the file as changed by the PR, or ' +
        'the base SHA to see it beforehand. Use this to pull context beyond a diff hunk (e.g. ' +
        'surrounding function bodies). Refuses to return binary files or files over 500KB.',
      inputSchema: getFileContentInput,
    },
    async ({ owner, repo, path, ref }) => {
      try {
        const result = await getFileContent({ owner, repo, path, ref });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toToolError(err, 'get_file_content');
      }
    }
  );
}
