/**
 * Turn a child-process failure from an `exec` cron job into a message that
 * names the exit code and the script's own output. Node's `exec` error only
 * carries "Command failed: <command line>", so without this the run log and
 * the owner's failure notice say nothing about why a script failed.
 */
const MAX_OUTPUT_CHARS = 1500;

function tail(text: string | Buffer | undefined, limit = MAX_OUTPUT_CHARS): string {
  const value = (typeof text === 'string' ? text : text?.toString('utf8') ?? '').trim();
  if (value.length <= limit) return value;
  return `…${value.slice(-limit)}`;
}

export function describeExecFailure(err: unknown, command: string, timeoutMs?: number): string {
  if (!(err instanceof Error)) return String(err);
  const details = err as Error & { code?: number | string | null; killed?: boolean; signal?: string | null; stdout?: string | Buffer; stderr?: string | Buffer };
  const isExecError = 'stdout' in details || 'stderr' in details || 'killed' in details;
  if (!isExecError) return err.message;

  const output = tail(details.stderr) || tail(details.stdout);
  const parts: string[] = [];
  if (details.killed && details.signal) {
    parts.push(timeoutMs ? `Command timed out after ${Math.round(timeoutMs / 1000)}s (${details.signal})` : `Command killed by ${details.signal}`);
  } else if (typeof details.code === 'number') {
    parts.push(`Command failed (exit ${details.code})`);
  } else if (details.signal) {
    parts.push(`Command terminated by ${details.signal}`);
  } else {
    parts.push('Command failed');
  }
  parts.push(`: ${command.trim().slice(0, 400)}`);
  if (output) parts.push(`\n${output}`);
  return parts.join('');
}
