/**
 * API Client
 * Wrapper for all dashboard API calls
 */
const API = {
  /**
   * State & Core Data
   */
  async getState() {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error(`Failed to fetch state: ${res.statusText}`);
    return res.json();
  },

  async getThoughts(limit = 100) {
    const res = await fetch(`/api/thoughts?limit=${limit}`);
    if (!res.ok) throw new Error(`Failed to fetch thoughts: ${res.statusText}`);
    return res.json();
  },

  async getGoals() {
    const res = await fetch('/api/goals');
    if (!res.ok) throw new Error(`Failed to fetch goals: ${res.statusText}`);
    return res.json();
  },

  async getMemory() {
    const res = await fetch('/api/memory');
    if (!res.ok) throw new Error(`Failed to fetch memory: ${res.statusText}`);
    return res.json();
  },

  async getStats() {
    const res = await fetch('/api/stats');
    if (!res.ok) throw new Error(`Failed to fetch stats: ${res.statusText}`);
    return res.json();
  },

  async getAgents() {
    const res = await fetch('/api/agents');
    if (!res.ok) throw new Error(`Failed to fetch agents: ${res.statusText}`);
    return res.json();
  },

  /**
   * Runs Management
   */
  async getRuns() {
    const res = await fetch('/api/runs');
    if (!res.ok) throw new Error(`Failed to fetch runs: ${res.statusText}`);
    return res.json();
  },

  async getCurrentRun() {
    const res = await fetch('/api/runs/current');
    if (!res.ok) throw new Error(`Failed to fetch current run: ${res.statusText}`);
    return res.json();
  },

  async switchRun(runName) {
    const res = await fetch('/api/runs/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runName })
    });
    if (!res.ok) throw new Error(`Failed to switch run: ${res.statusText}`);
    return res.json();
  },

  async getRunStats(runName) {
    const res = await fetch(`/api/runs/${runName}/stats`);
    if (!res.ok) throw new Error(`Failed to fetch run stats: ${res.statusText}`);
    return res.json();
  },

  async getRunState(runName) {
    const res = await fetch(`/api/runs/${runName}/state`);
    if (!res.ok) throw new Error(`Failed to fetch run state: ${res.statusText}`);
    return res.json();
  },

  async getRunThoughts(runName, limit = 100) {
    const res = await fetch(`/api/runs/${runName}/thoughts?limit=${limit}`);
    if (!res.ok) throw new Error(`Failed to fetch run thoughts: ${res.statusText}`);
    return res.json();
  },

  /**
   * Coordinator Reports
   */
  async getCoordinatorReviews(runName) {
    const res = await fetch(`/api/runs/${runName}/coordinator/reviews`);
    if (!res.ok) throw new Error(`Failed to fetch coordinator reviews: ${res.statusText}`);
    return res.json();
  },

  async getCoordinatorReview(runName, filename) {
    const res = await fetch(`/api/runs/${runName}/coordinator/review/${filename}`);
    if (!res.ok) throw new Error(`Failed to fetch coordinator review: ${res.statusText}`);
    return res.json();
  },

  async getCuratedInsights(runName) {
    const res = await fetch(`/api/runs/${runName}/coordinator/insights`);
    if (!res.ok) throw new Error(`Failed to fetch curated insights: ${res.statusText}`);
    return res.json();
  },

  async getCuratedInsight(runName, filename) {
    const res = await fetch(`/api/runs/${runName}/coordinator/insight/${filename}`);
    if (!res.ok) throw new Error(`Failed to fetch curated insight: ${res.statusText}`);
    return res.json();
  },

  /**
   * Agent Analytics
   */
  async getAgentAnalytics(runName) {
    const res = await fetch(`/api/runs/${runName}/agents/analytics`);
    if (!res.ok) throw new Error(`Failed to fetch agent analytics: ${res.statusText}`);
    return res.json();
  },

  async getAgentDetails(runName, agentId) {
    const res = await fetch(`/api/runs/${runName}/agents/${agentId}`);
    if (!res.ok) throw new Error(`Failed to fetch agent details: ${res.statusText}`);
    return res.json();
  },

  /**
   * Query Interface
   */
  async query(query, runName) {
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, runName })
    });
    if (!res.ok) throw new Error(`Failed to execute query: ${res.statusText}`);
    return res.json();
  },

  async getQuerySuggestions() {
    const res = await fetch('/api/query/suggestions');
    if (!res.ok) throw new Error(`Failed to fetch query suggestions: ${res.statusText}`);
    return res.json();
  },

  /**
   * Helper: Handle errors consistently
   */
  handleError(error) {
    console.error('API Error:', error);
    return {
      error: true,
      message: error.message || 'An unknown error occurred'
    };
  }
};

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
}

