/**
 * WorkspaceManager — Git worktree-based workspace isolation for agent sessions.
 *
 * Each workspace is a git worktree on its own branch, giving agents an isolated
 * copy of the repo to work in. Changes are validated in isolation before being
 * merged back to the source branch.
 *
 * Pattern 2 from "The Harness Is Everything": one agent, one worktree.
 */

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class WorkspaceManager {
  constructor() {
    // Active workspaces: id → workspace metadata
    this.workspaces = new Map();
    // Restore any surviving worktrees from disk on init
    this._restoreFromDisk();
  }

  /**
   * Detect if a directory is inside a git repository.
   * Returns the repo root path or null.
   */
  getRepoRoot(folderPath) {
    try {
      const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: folderPath,
        encoding: 'utf-8',
        timeout: 5000
      }).trim();
      return root;
    } catch {
      return null;
    }
  }

  /**
   * Get the current branch name for a repo.
   */
  getCurrentBranch(repoRoot) {
    try {
      return execFileSync('git', ['branch', '--show-current'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 5000
      }).trim();
    } catch {
      return 'HEAD';
    }
  }

  /**
   * Check if a folder has uncommitted changes.
   */
  hasUncommittedChanges(repoRoot) {
    try {
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 5000
      }).trim();
      return status.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Create a new isolated workspace (git worktree).
   *
   * @param {string} sourceFolder - The folder the user is working in
   * @param {object} options
   * @param {string} options.description - What this workspace is for
   * @param {string} options.baseBranch - Branch to base the worktree on (default: current)
   * @returns {{ id, path, branch, repoRoot, sourceBranch, description, createdAt }}
   */
  create(sourceFolder, options = {}) {
    const repoRoot = this.getRepoRoot(sourceFolder);
    if (!repoRoot) {
      throw new Error(`Not a git repository: ${sourceFolder}. Workspace isolation requires git.`);
    }

    const sourceBranch = options.baseBranch || this.getCurrentBranch(repoRoot);
    const id = crypto.randomBytes(6).toString('hex');
    const branchName = `evobrew/workspace-${id}`;
    const worktreeDir = path.join(repoRoot, '.evobrew-workspaces', id);

    // Create the worktree directory parent
    fs.mkdirSync(path.join(repoRoot, '.evobrew-workspaces'), { recursive: true });

    // Ensure .evobrew-workspaces is gitignored so it doesn't pollute the repo
    this._ensureGitignore(repoRoot);

    // Create worktree with a new branch based on current HEAD
    try {
      execFileSync('git', ['worktree', 'add', '-b', branchName, worktreeDir, sourceBranch], {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 30000
      });
    } catch (err) {
      throw new Error(`Failed to create worktree: ${err.message}`);
    }

    const workspace = {
      id,
      path: worktreeDir,
      branch: branchName,
      repoRoot,
      sourceBranch,
      description: options.description || '',
      createdAt: new Date().toISOString(),
      status: 'active'
    };

    this.workspaces.set(id, workspace);
    this._saveToDisk(repoRoot);

    console.log(`[WORKSPACE] Created workspace ${id} at ${worktreeDir} (branch: ${branchName})`);
    return workspace;
  }

  /**
   * Get workspace by ID.
   */
  get(id) {
    return this.workspaces.get(id) || null;
  }

  /**
   * List all active workspaces, optionally filtered by repo root.
   */
  list(repoRoot = null) {
    const all = Array.from(this.workspaces.values()).filter(w => w.status === 'active');
    if (repoRoot) {
      return all.filter(w => w.repoRoot === repoRoot);
    }
    return all;
  }

  /**
   * Get the diff between a workspace and its source branch.
   * Returns a structured diff with file-level detail.
   */
  diff(id) {
    const workspace = this.workspaces.get(id);
    if (!workspace) throw new Error(`Workspace ${id} not found`);

    try {
      // Diff the worktree branch against its source branch
      const rawDiff = execFileSync('git', [
        'diff', `${workspace.sourceBranch}...${workspace.branch}`, '--stat'
      ], {
        cwd: workspace.repoRoot,
        encoding: 'utf-8',
        timeout: 10000
      }).trim();

      const fullDiff = execFileSync('git', [
        'diff', `${workspace.sourceBranch}...${workspace.branch}`
      ], {
        cwd: workspace.repoRoot,
        encoding: 'utf-8',
        timeout: 30000
      }).trim();

      // Get list of changed files
      const changedFiles = execFileSync('git', [
        'diff', `${workspace.sourceBranch}...${workspace.branch}`, '--name-status'
      ], {
        cwd: workspace.repoRoot,
        encoding: 'utf-8',
        timeout: 10000
      }).trim();

      const files = changedFiles.split('\n').filter(Boolean).map(line => {
        const [status, ...fileParts] = line.split('\t');
        return { status: status.trim(), file: fileParts.join('\t') };
      });

      // Check for uncommitted changes in the worktree itself
      const uncommitted = execFileSync('git', ['status', '--porcelain'], {
        cwd: workspace.path,
        encoding: 'utf-8',
        timeout: 5000
      }).trim();

      return {
        id: workspace.id,
        branch: workspace.branch,
        sourceBranch: workspace.sourceBranch,
        summary: rawDiff,
        diff: fullDiff,
        files,
        hasUncommittedChanges: uncommitted.length > 0,
        uncommittedDetails: uncommitted || null
      };
    } catch (err) {
      throw new Error(`Failed to get diff for workspace ${id}: ${err.message}`);
    }
  }

  /**
   * Commit all changes in a workspace (so they can be merged).
   */
  commit(id, message) {
    const workspace = this.workspaces.get(id);
    if (!workspace) throw new Error(`Workspace ${id} not found`);

    try {
      // Stage all changes
      execFileSync('git', ['add', '-A'], {
        cwd: workspace.path,
        encoding: 'utf-8',
        timeout: 10000
      });

      // Check if there's anything to commit
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: workspace.path,
        encoding: 'utf-8',
        timeout: 5000
      }).trim();

      if (!status) {
        return { committed: false, message: 'Nothing to commit' };
      }

      // Commit
      const commitMsg = message || `evobrew workspace ${id}: ${workspace.description || 'agent changes'}`;
      execFileSync('git', ['commit', '-m', commitMsg], {
        cwd: workspace.path,
        encoding: 'utf-8',
        timeout: 10000
      });

      return { committed: true, message: commitMsg };
    } catch (err) {
      throw new Error(`Failed to commit in workspace ${id}: ${err.message}`);
    }
  }

  /**
   * Merge a workspace's changes back to the source branch.
   * Commits any uncommitted changes first.
   *
   * @param {string} id - Workspace ID
   * @param {object} options
   * @param {string} options.commitMessage - Message for the merge commit
   * @param {boolean} options.cleanup - Remove workspace after merge (default: true)
   * @returns {{ merged, conflicts, commitHash }}
   */
  merge(id, options = {}) {
    const workspace = this.workspaces.get(id);
    if (!workspace) throw new Error(`Workspace ${id} not found`);

    // Auto-commit any uncommitted changes in the worktree
    const uncommitted = execFileSync('git', ['status', '--porcelain'], {
      cwd: workspace.path,
      encoding: 'utf-8',
      timeout: 5000
    }).trim();

    if (uncommitted) {
      this.commit(id, options.commitMessage || null);
    }

    // Check if the workspace branch has any commits beyond the source
    const aheadBehind = execFileSync('git', [
      'rev-list', '--left-right', '--count',
      `${workspace.sourceBranch}...${workspace.branch}`
    ], {
      cwd: workspace.repoRoot,
      encoding: 'utf-8',
      timeout: 5000
    }).trim();

    const [behind, ahead] = aheadBehind.split('\t').map(Number);
    if (ahead === 0) {
      return { merged: false, message: 'No changes to merge', conflicts: false };
    }

    try {
      // Merge the workspace branch into the source branch
      const mergeMsg = options.commitMessage ||
        `Merge workspace ${id}: ${workspace.description || 'agent changes'}`;

      execFileSync('git', ['merge', workspace.branch, '-m', mergeMsg], {
        cwd: workspace.repoRoot,
        encoding: 'utf-8',
        timeout: 30000
      });

      const commitHash = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: workspace.repoRoot,
        encoding: 'utf-8',
        timeout: 5000
      }).trim();

      console.log(`[WORKSPACE] Merged workspace ${id} into ${workspace.sourceBranch} (${commitHash.slice(0, 7)})`);

      if (options.cleanup !== false) {
        this.remove(id);
      }

      return { merged: true, conflicts: false, commitHash, ahead, behind };
    } catch (err) {
      // Check if it's a merge conflict
      const mergeStatus = execFileSync('git', ['status', '--porcelain'], {
        cwd: workspace.repoRoot,
        encoding: 'utf-8',
        timeout: 5000
      }).trim();

      const hasConflicts = mergeStatus.split('\n').some(l => l.startsWith('UU') || l.startsWith('AA'));

      if (hasConflicts) {
        // Abort the merge — don't leave the source repo in a conflicted state
        try {
          execFileSync('git', ['merge', '--abort'], {
            cwd: workspace.repoRoot,
            encoding: 'utf-8',
            timeout: 5000
          });
        } catch {
          // merge --abort can fail if no merge in progress
        }

        return {
          merged: false,
          conflicts: true,
          message: `Merge conflicts detected. The source branch (${workspace.sourceBranch}) has diverged. Resolve manually or use cherry-pick.`,
          conflictFiles: mergeStatus.split('\n').filter(l => l.startsWith('UU') || l.startsWith('AA'))
        };
      }

      throw new Error(`Merge failed for workspace ${id}: ${err.message}`);
    }
  }

  /**
   * Remove a workspace — deletes the worktree and branch.
   */
  remove(id) {
    const workspace = this.workspaces.get(id);
    if (!workspace) return { removed: false, message: `Workspace ${id} not found` };

    try {
      // Remove the worktree
      execFileSync('git', ['worktree', 'remove', workspace.path, '--force'], {
        cwd: workspace.repoRoot,
        encoding: 'utf-8',
        timeout: 10000
      });
    } catch (err) {
      // If worktree is already gone, that's fine
      console.warn(`[WORKSPACE] Worktree removal warning for ${id}: ${err.message}`);
      // Try manual cleanup if the directory still exists
      if (fs.existsSync(workspace.path)) {
        try {
          fs.rmSync(workspace.path, { recursive: true, force: true });
        } catch {
          // Best effort
        }
      }
    }

    // Delete the branch
    try {
      execFileSync('git', ['branch', '-D', workspace.branch], {
        cwd: workspace.repoRoot,
        encoding: 'utf-8',
        timeout: 5000
      });
    } catch {
      // Branch may already be gone
    }

    workspace.status = 'removed';
    this.workspaces.delete(id);
    this._saveToDisk(workspace.repoRoot);

    console.log(`[WORKSPACE] Removed workspace ${id}`);
    return { removed: true };
  }

  /**
   * Clean up all workspaces for a given repo, or all workspaces if no repo specified.
   * Called on server shutdown.
   */
  cleanupAll(repoRoot = null) {
    const targets = repoRoot
      ? this.list(repoRoot)
      : Array.from(this.workspaces.values()).filter(w => w.status === 'active');

    let cleaned = 0;
    for (const workspace of targets) {
      try {
        this.remove(workspace.id);
        cleaned++;
      } catch (err) {
        console.warn(`[WORKSPACE] Failed to clean up workspace ${workspace.id}: ${err.message}`);
      }
    }
    return { cleaned, total: targets.length };
  }

  /**
   * Prune stale worktrees that git knows about but we don't track
   * (e.g., from a crashed server session).
   */
  pruneStale(repoRoot) {
    try {
      execFileSync('git', ['worktree', 'prune'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 10000
      });
    } catch {
      // Not critical
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  /**
   * Ensure .evobrew-workspaces/ is in .gitignore so worktrees don't pollute the repo.
   */
  _ensureGitignore(repoRoot) {
    const gitignorePath = path.join(repoRoot, '.gitignore');
    const entry = '.evobrew-workspaces/';

    try {
      const content = fs.existsSync(gitignorePath)
        ? fs.readFileSync(gitignorePath, 'utf-8')
        : '';
      if (!content.includes(entry)) {
        const newContent = content.trimEnd() + '\n' + entry + '\n';
        fs.writeFileSync(gitignorePath, newContent, 'utf-8');
      }
    } catch {
      // Best effort — not critical
    }
  }

  /**
   * Persist workspace metadata to disk so we can recover after restart.
   */
  _saveToDisk(repoRoot) {
    const metaDir = path.join(repoRoot, '.evobrew-workspaces');
    if (!fs.existsSync(metaDir)) return;

    const metaPath = path.join(metaDir, 'workspaces.json');
    const activeForRepo = this.list(repoRoot);
    try {
      fs.writeFileSync(metaPath, JSON.stringify(activeForRepo, null, 2), 'utf-8');
    } catch {
      // Non-critical
    }
  }

  /**
   * On startup, scan known workspace directories and restore metadata.
   */
  _restoreFromDisk() {
    // We can't scan all repos — but we can restore when a repo is first accessed.
    // This is called from getRepoRoot or create.
  }

  /**
   * Restore workspaces for a specific repo root (called lazily).
   */
  restoreForRepo(repoRoot) {
    const metaPath = path.join(repoRoot, '.evobrew-workspaces', 'workspaces.json');
    if (!fs.existsSync(metaPath)) return;

    try {
      const data = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (!Array.isArray(data)) return;

      for (const ws of data) {
        if (ws.id && ws.path && ws.status === 'active' && !this.workspaces.has(ws.id)) {
          // Verify the worktree still exists on disk
          if (fs.existsSync(ws.path)) {
            this.workspaces.set(ws.id, ws);
            console.log(`[WORKSPACE] Restored workspace ${ws.id} from disk`);
          } else {
            console.log(`[WORKSPACE] Skipped stale workspace ${ws.id} — directory missing`);
          }
        }
      }
    } catch {
      // Corrupted metadata — ignore
    }
  }
}

// Singleton instance
let instance = null;

function getWorkspaceManager() {
  if (!instance) {
    instance = new WorkspaceManager();
  }
  return instance;
}

module.exports = { WorkspaceManager, getWorkspaceManager };
