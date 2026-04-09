/**
 * COSMO Home 2.3 — ACP Bridge
 *
 * Connects to coding agents (Claude Code, Codex) via CLI spawning.
 * Session IDs are always strings. No spawnedBy on ACP sessions (v1 bug fix).
 */

import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { ACPConfig } from '../types.js';

// ─── Types ───────────────────────────────────────────────────

export interface ACPSession {
  id: string;
  agent: string;
  status: 'running' | 'completed' | 'error';
  startedAt: string;
  result?: string;
  label?: string;
}

interface ActiveSession extends ACPSession {
  process: ChildProcess;
  stdout: string;
  stderr: string;
}

// ─── Agent CLI Definitions ───────────────────────────────────

const AGENT_COMMANDS: Record<string, { bin: string; args: (prompt: string) => string[] }> = {
  'claude-code': {
    bin: 'claude',
    args: (prompt) => ['--print', prompt],
  },
  codex: {
    bin: 'codex',
    args: (prompt) => ['--print', prompt],
  },
};

// ─── ACP Bridge ──────────────────────────────────────────────

export class ACPBridge {
  private config: ACPConfig;
  private activeSessions: Map<string, ActiveSession> = new Map();

  constructor(config: ACPConfig) {
    this.config = config;
  }

  /**
   * Spawn a new coding agent session.
   * Session ID is always a string ("acp-{uuid}"), never has spawnedBy.
   */
  async spawnSession(
    agent: string,
    prompt: string,
    options?: { label?: string; timeout?: number }
  ): Promise<ACPSession> {
    // Validate agent is allowed
    if (!this.config.allowedAgents.includes(agent)) {
      throw new Error(
        `Agent "${agent}" is not in allowedAgents: [${this.config.allowedAgents.join(', ')}]`
      );
    }

    const agentDef = AGENT_COMMANDS[agent];
    if (!agentDef) {
      throw new Error(
        `No CLI definition for agent "${agent}". Known agents: ${Object.keys(AGENT_COMMANDS).join(', ')}`
      );
    }

    const id = `acp-${randomUUID()}`;
    const startedAt = new Date().toISOString();

    const child = spawn(agentDef.bin, agentDef.args(prompt), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const session: ActiveSession = {
      id,
      agent,
      status: 'running',
      startedAt,
      label: options?.label,
      process: child,
      stdout: '',
      stderr: '',
    };

    this.activeSessions.set(id, session);

    // Collect stdout
    child.stdout?.on('data', (chunk: Buffer) => {
      session.stdout += chunk.toString();
    });

    // Collect stderr
    child.stderr?.on('data', (chunk: Buffer) => {
      session.stderr += chunk.toString();
    });

    // Handle completion
    child.on('close', (code) => {
      if (code === 0) {
        session.status = 'completed';
        session.result = session.stdout.trim();
      } else {
        session.status = 'error';
        session.result = session.stderr.trim() || `Process exited with code ${code}`;
      }
    });

    child.on('error', (err) => {
      session.status = 'error';
      session.result = `Spawn error: ${err.message}`;
    });

    // Optional timeout
    if (options?.timeout && options.timeout > 0) {
      setTimeout(() => {
        if (session.status === 'running') {
          child.kill('SIGTERM');
          session.status = 'error';
          session.result = `Timed out after ${options.timeout}ms`;
        }
      }, options.timeout);
    }

    // Return the public session object (no process handle)
    return this.toPublicSession(session);
  }

  /**
   * Get all active/completed sessions.
   */
  getActiveSessions(): ACPSession[] {
    return Array.from(this.activeSessions.values()).map(s => this.toPublicSession(s));
  }

  /**
   * Get a session by ID.
   */
  getSession(id: string): ACPSession | undefined {
    const session = this.activeSessions.get(id);
    return session ? this.toPublicSession(session) : undefined;
  }

  /**
   * Kill a running session.
   */
  async killSession(id: string): Promise<void> {
    const session = this.activeSessions.get(id);
    if (!session) return;

    if (session.status === 'running') {
      session.process.kill('SIGTERM');
      session.status = 'error';
      session.result = 'Killed by user';
    }
  }

  /**
   * Strip internal fields from session for public API.
   */
  private toPublicSession(session: ActiveSession): ACPSession {
    const pub: ACPSession = {
      id: session.id,
      agent: session.agent,
      status: session.status,
      startedAt: session.startedAt,
    };
    if (session.result !== undefined) pub.result = session.result;
    if (session.label !== undefined) pub.label = session.label;
    return pub;
  }
}
