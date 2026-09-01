export interface WorkflowLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Reads only `.status` and `.message` off any thrown value - never `.headers`, `.request`, or
 * `.response`, which is where an SDK error could carry an Authorization header or API key. This
 * is the ONLY way the orchestrator is allowed to turn a caught error into something logged or
 * returned, whether it came from Octokit, the Anthropic SDK, or anywhere else.
 */
export function toSafeLogFields(err: unknown): { message: string; status?: number } {
  if (err && typeof err === 'object') {
    const status = 'status' in err && typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : undefined;
    const message =
      'message' in err && typeof (err as { message?: unknown }).message === 'string'
        ? (err as { message: string }).message
        : 'Unknown error.';
    return { message, status };
  }
  return { message: typeof err === 'string' ? err : 'Unknown error.' };
}

function write(level: 'INFO' | 'WARN' | 'ERROR', message: string, meta?: Record<string, unknown>): void {
  // Always stderr, never stdout - this workflow may run inside the MCP stdio server process
  // (stdout reserved for JSON-RPC) or standalone (e.g. a GitHub Actions step); stderr is safe in
  // both. `meta` is expected to already be safe (built via toSafeLogFields or plain literals) -
  // this function does not itself sanitize it.
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  console.error(`[pr-review-agent] ${level} ${message}${suffix}`);
}

export const consoleLogger: WorkflowLogger = {
  info: (message, meta) => write('INFO', message, meta),
  warn: (message, meta) => write('WARN', message, meta),
  error: (message, meta) => write('ERROR', message, meta),
};
