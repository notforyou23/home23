import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { detectGitRepo } from './worktrees.js';

export interface WorkspaceLease { directory: string; token: string; }
interface Owner { token: string; jobFile: string; harnessPid: number; workspace: string; }
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Atomic reservation shared by all coding bridges using this Home23 root.
 * No time-based expiry: a detached child may outlive its harness. Unknown
 * ownership fails closed; never remove a lease merely because it is old. */
export function acquireWorkspaceLease(projectRoot: string, cwd: string, jobFile: string): WorkspaceLease {
  const workspace = realpathSync(detectGitRepo(cwd)?.repoRoot ?? cwd);
  const leases = path.join(realpathSync(projectRoot), '.home23-worktrees', '.leases');
  mkdirSync(leases, { recursive: true });
  const unlock = lockfile.lockSync(leases, { realpath: true });
  try {
    const directory = path.join(leases, createHash('sha256').update(workspace).digest('hex'));
    const token = randomUUID();
    try { mkdirSync(directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: Owner;
      try {
        owner = JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8'));
        if (!owner || typeof owner.token !== 'string' || typeof owner.jobFile !== 'string'
          || !Number.isSafeInteger(owner.harnessPid) || owner.harnessPid <= 0 || owner.workspace !== workspace) {
          throw new Error('invalid lease owner');
        }
      }
      catch { throw new Error(`Workspace lease has unreadable ownership: ${workspace}; inspect it before retrying`); }
      let canRecover = false;
      if (existsSync(owner.jobFile)) {
        try {
          const job = JSON.parse(readFileSync(owner.jobFile, 'utf8'));
          canRecover = Number.isSafeInteger(job.pgid) && job.pgid > 0 ? !alive(-job.pgid)
            : Number.isSafeInteger(job.pid) && job.pid > 0 ? !alive(job.pid) : false;
          // A crash between spawn and PID persistence leaves uncertain ownership.
          // Never infer that the child is absent merely because its harness died.
        } catch { /* unknown job state is not free workspace */ }
      } else canRecover = !alive(owner.harnessPid);
      if (!canRecover) throw new Error(`Workspace already reserved by a coding job: ${workspace}`);
      // Admission is serialized across bridge processes; never expire a live owner.
      if (JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8')).token !== owner.token) {
        throw new Error(`Workspace ownership changed: ${workspace}; retry admission`);
      }
      rmSync(directory, { recursive: true });
      mkdirSync(directory);
    }
    writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ token, jobFile, harnessPid: process.pid, workspace } satisfies Owner));
    return { directory, token };
  } finally { unlock(); }
}

export function releaseWorkspaceLease(lease: WorkspaceLease | undefined): void {
  if (!lease) return;
  let unlock: (() => void) | undefined;
  try {
    unlock = lockfile.lockSync(path.dirname(lease.directory), { realpath: true });
    const owner = JSON.parse(readFileSync(path.join(lease.directory, 'owner.json'), 'utf8'));
    if (owner.token === lease.token) rmSync(lease.directory, { recursive: true });
  } catch { /* a later admission can recover a dead owner; never remove uncertain ownership */ }
  finally { unlock?.(); }
}
