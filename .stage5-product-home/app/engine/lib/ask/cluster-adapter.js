"use strict";

const DEFAULT_CLUSTER_HOST = process.env.COSMO_CLUSTER_HOST || "localhost";
const DEFAULT_CLUSTER_PORT = Number.parseInt(process.env.COSMO_CLUSTER_PORT || "3360", 10);
const DEFAULT_PROTOCOL = (process.env.COSMO_CLUSTER_PROTOCOL || "http").toLowerCase();
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.COSMO_CLUSTER_TIMEOUT || "4000", 10);

/**
 * Lightweight HTTP client for the Hive Mind dashboard API.
 * Keeps .ask decoupled from dashboard internals while providing
 * typed helpers for the key aggregation endpoints.
 */
class ClusterAdapter {
  constructor(options = {}) {
    const { host, port, protocol, timeoutMs, fetchImpl } = options;

    this.host = host || DEFAULT_CLUSTER_HOST;
    this.port = Number.parseInt(port ?? DEFAULT_CLUSTER_PORT, 10);
    this.protocol = (protocol || DEFAULT_PROTOCOL).toLowerCase() === "https" ? "https" : "http";
    this.timeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = fetchImpl || globalThis.fetch;

    if (typeof this.fetchImpl !== "function") {
      throw new Error("ClusterAdapter requires a global fetch implementation (Node 18+).");
    }
  }

  buildUrl(pathname) {
    const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
    return `${this.protocol}://${this.host}:${this.port}${path}`;
  }

  async fetchJson(pathname, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.buildUrl(pathname), {
        method: "GET",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(options.headers || {})
        }
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Cluster API ${pathname} failed (${response.status}): ${text}`);
      }

      const body = await response.json();
      return body;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Cluster API ${pathname} timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchOverview() {
    return this.fetchJson("/api/cluster/overview");
  }

  async fetchMemory() {
    return this.fetchJson("/api/cluster/memory");
  }

  async fetchGoals() {
    return this.fetchJson("/api/cluster/goals");
  }

  async fetchThoughts(limit = 400) {
    return this.fetchJson(`/api/cluster/thoughts?limit=${encodeURIComponent(limit)}`);
  }

  async fetchAgents() {
    return this.fetchJson("/api/cluster/agents");
  }

  async fetchStats() {
    return this.fetchJson("/api/cluster/stats");
  }

  /**
   * Convenience helper to gather the primary hive snapshot in one pass.
   */
  async getSnapshot(options = {}) {
    const { thoughtLimit = 400, includeAgents = false } = options;

    const tasks = [
      this.fetchOverview(),
      this.fetchMemory(),
      this.fetchGoals(),
      this.fetchThoughts(thoughtLimit),
      this.fetchStats()
    ];

    if (includeAgents) {
      tasks.push(this.fetchAgents());
    }

    const [
      overview,
      memory,
      goals,
      thoughts,
      stats,
      agents
    ] = await Promise.all(tasks);

    return {
      overview,
      memory,
      goals,
      thoughts,
      stats,
      agents: includeAgents ? agents : null
    };
  }
}

function createClusterAdapter(options) {
  return new ClusterAdapter(options);
}

module.exports = {
  ClusterAdapter,
  createClusterAdapter
};
