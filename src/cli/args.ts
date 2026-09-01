// Pure argument parsing, kept separate from the interactive entrypoint (review.ts) so it's
// testable without touching stdin/stdout or spawning a process.

export interface CliArgs {
  owner: string;
  repo: string;
  pr: number;
}

export type CliArgsResult = { ok: true; args: CliArgs } | { ok: false; error: string };

const USAGE = 'Usage: npm run review -- --owner=<owner> --repo=<repo> --pr=<number>';

/** Parses `--owner=x --repo=y --pr=123` style flags out of an argv array (e.g. process.argv.slice(2)). */
export function parseCliArgs(argv: string[]): CliArgsResult {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-zA-Z0-9_-]+)=(.*)$/.exec(arg);
    if (match) flags.set(match[1], match[2]);
  }

  const owner = flags.get('owner');
  const repo = flags.get('repo');
  const prRaw = flags.get('pr');

  const missing = [!owner && 'owner', !repo && 'repo', !prRaw && 'pr'].filter((v): v is string => Boolean(v));
  if (missing.length > 0) {
    return { ok: false, error: `Missing required argument(s): ${missing.join(', ')}.\n${USAGE}` };
  }

  const pr = Number(prRaw);
  if (!Number.isInteger(pr) || pr <= 0) {
    return { ok: false, error: `--pr must be a positive integer, got "${prRaw}".\n${USAGE}` };
  }

  return { ok: true, args: { owner: owner as string, repo: repo as string, pr } };
}
