export type HandledAction = 'opened' | 'synchronize' | 'reopened';

export interface ParsedPullRequestEvent {
  owner: string;
  repo: string;
  pullNumber: number;
  /** The PR's head commit SHA at the time of this event - what duplicate-review detection keys on. */
  commitSha: string;
  action: HandledAction;
}

export type ParseEventResult =
  | { handled: true; event: ParsedPullRequestEvent }
  | { handled: false; reason: string };

const HANDLED_ACTIONS: ReadonlySet<string> = new Set<HandledAction>(['opened', 'synchronize', 'reopened']);

/**
 * Extracts {owner, repo, pullNumber, commitSha} from a `pull_request` webhook payload for the
 * three actions this system reviews (opened/synchronize/reopened).
 *
 * Every other event name, action, or malformed payload comes back `handled: false` with a
 * human-readable reason - it never throws. A webhook endpoint routinely receives event types and
 * actions it doesn't care about (GitHub can send dozens to the same URL), and that is a normal,
 * expected input, not an error condition.
 */
export function parsePullRequestEvent(eventName: string | undefined, payload: unknown): ParseEventResult {
  if (eventName !== 'pull_request') {
    return { handled: false, reason: `ignoring event "${eventName ?? '(missing)'}" - only pull_request is handled` };
  }

  if (typeof payload !== 'object' || payload === null) {
    return { handled: false, reason: 'payload is not a JSON object' };
  }

  const body = payload as Record<string, unknown>;
  const action = typeof body.action === 'string' ? body.action : undefined;

  if (!action || !HANDLED_ACTIONS.has(action)) {
    return { handled: false, reason: `ignoring pull_request action "${action ?? '(missing)'}"` };
  }

  const pr = body.pull_request as Record<string, unknown> | undefined;
  const repository = body.repository as Record<string, unknown> | undefined;
  const owner = repository?.owner as Record<string, unknown> | undefined;
  const head = pr?.head as Record<string, unknown> | undefined;

  const ownerLogin = typeof owner?.login === 'string' ? owner.login : undefined;
  const repoName = typeof repository?.name === 'string' ? repository.name : undefined;
  const pullNumber = typeof pr?.number === 'number' ? pr.number : undefined;
  const commitSha = typeof head?.sha === 'string' ? head.sha : undefined;

  if (!ownerLogin || !repoName || !pullNumber || !commitSha) {
    return { handled: false, reason: 'payload is missing repository.owner.login, repository.name, pull_request.number, or pull_request.head.sha' };
  }

  return {
    handled: true,
    event: { owner: ownerLogin, repo: repoName, pullNumber, commitSha, action: action as HandledAction },
  };
}
