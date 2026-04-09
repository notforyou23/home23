/**
 * Intelligence Tab — Brain data explorer
 *
 * Renders goals, plans, thoughts, agents, insights, executive, trajectory,
 * and deliverables for any selected brain. All data loaded from REST endpoints.
 */

(function () {
  'use strict';

  let currentBrain = null;
  let activeTab = 'goals';
  let cache = {};

  // ── Helpers ────────────────────────────────────────────────────────────────

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function truncate(str, n) {
    if (!str) return '';
    return str.length <= n ? str : str.slice(0, n - 1) + '\u2026';
  }

  function relTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString();
  }

  function badge(state) {
    const map = {
      DONE: 'done', COMPLETED: 'done', completed: 'done',
      ACTIVE: 'active', IN_PROGRESS: 'active', active: 'active',
      PENDING: 'pending', CLAIMED: 'pending', pending: 'pending',
      FAILED: 'failed', failed: 'failed', timeout: 'failed',
      BLOCKED: 'blocked'
    };
    const cls = map[state] || 'pending';
    return `<span class="intel-badge intel-badge-${cls}">${esc(String(state || 'unknown'))}</span>`;
  }

  function renderMarkdown(md) {
    if (typeof marked !== 'undefined') {
      return `<div class="intel-markdown">${marked.parse(md)}</div>`;
    }
    return `<pre class="intel-card-body">${esc(md)}</pre>`;
  }

  // ── API ────────────────────────────────────────────────────────────────────

  async function fetchIntel(subpath) {
    if (!currentBrain) return null;
    const key = `${currentBrain}:${subpath}`;
    if (cache[key]) return cache[key];
    const res = await fetch(`/api/brain/${encodeURIComponent(currentBrain)}/intelligence/${subpath}`);
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    cache[key] = data;
    return data;
  }

  function clearCache() { cache = {}; }

  // ── Tab renderers ──────────────────────────────────────────────────────────

  async function renderGoals() {
    const data = await fetchIntel('goals');
    if (!data) return '<div class="intel-empty">No goal data available.</div>';

    // Goals can be Map entries [id, goal] or plain objects
    const active = Array.isArray(data.active) ? data.active : [];
    const completed = Array.isArray(data.completed) ? data.completed : [];

    const parseGoal = (entry) => {
      if (Array.isArray(entry) && entry.length >= 2) return entry[1]; // [id, goalObj]
      return entry;
    };

    const activeGoals = active.map(parseGoal).filter(Boolean);
    const completedGoals = completed.map(parseGoal).filter(Boolean);
    const allGoals = [...activeGoals, ...completedGoals];

    const totalActive = activeGoals.length;
    const totalCompleted = completedGoals.length;

    // Count by priority tier
    let highCount = 0, medCount = 0, lowCount = 0;
    allGoals.forEach(g => {
      const p = g.priority != null ? Number(g.priority) : null;
      if (p != null) {
        if (p > 0.7) highCount++;
        else if (p >= 0.4) medCount++;
        else lowCount++;
      }
    });

    // Avg progress of active goals
    let progressSum = 0, progressCount = 0;
    activeGoals.forEach(g => {
      if (g.progress != null) { progressSum += Number(g.progress); progressCount++; }
    });
    const avgProgress = progressCount > 0 ? Math.round((progressSum / progressCount) * 100) : null;

    let html = `<div class="intel-stat-row">
      <div class="intel-stat"><div class="intel-stat-label">Active</div><div class="intel-stat-value">${totalActive}</div></div>
      <div class="intel-stat"><div class="intel-stat-label">Completed</div><div class="intel-stat-value">${totalCompleted}</div></div>
      <div class="intel-stat"><div class="intel-stat-label">High Priority</div><div class="intel-stat-value">${highCount}</div></div>
      <div class="intel-stat"><div class="intel-stat-label">Avg Progress</div><div class="intel-stat-value">${avgProgress != null ? avgProgress + '%' : '\u2013'}</div></div>
    </div>`;

    const renderGoalCard = (g, status) => {
      const desc = g.description || g.goal || 'Untitled goal';
      const progress = g.progress != null ? Math.round(g.progress * 100) : null;
      const priority = g.priority != null ? Number(g.priority).toFixed(2) : null;
      return `<div class="intel-card">
        <div class="intel-card-head">
          <h4 class="intel-card-title">${esc(truncate(desc, 120))}</h4>
          ${badge(status)}
        </div>
        <div class="intel-card-meta">
          ${priority ? `<span>priority: ${priority}</span>` : ''}
          ${progress != null ? `<span>progress: ${progress}%</span>` : ''}
          ${g.source ? `<span>source: ${esc(g.source)}</span>` : ''}
        </div>
        ${progress != null ? `<div class="goal-progress-bar"><div style="width:${progress}%"></div></div>` : ''}
      </div>`;
    };

    // Group active goals by priority tier
    if (activeGoals.length) {
      const high = activeGoals.filter(g => g.priority != null && Number(g.priority) > 0.7);
      const med = activeGoals.filter(g => g.priority != null && Number(g.priority) >= 0.4 && Number(g.priority) <= 0.7);
      const low = activeGoals.filter(g => g.priority != null && Number(g.priority) < 0.4);
      const unset = activeGoals.filter(g => g.priority == null);

      if (high.length) {
        html += `<h3 style="margin:14px 0 8px;font-family:var(--display);font-weight:400;font-size:15px;color:var(--text-secondary)">High Priority</h3>`;
        html += high.map(g => renderGoalCard(g, 'ACTIVE')).join('');
      }
      if (med.length) {
        html += `<h3 style="margin:14px 0 8px;font-family:var(--display);font-weight:400;font-size:15px;color:var(--text-secondary)">Medium Priority</h3>`;
        html += med.map(g => renderGoalCard(g, 'ACTIVE')).join('');
      }
      if (low.length) {
        html += `<h3 style="margin:14px 0 8px;font-family:var(--display);font-weight:400;font-size:15px;color:var(--text-secondary)">Low Priority</h3>`;
        html += low.map(g => renderGoalCard(g, 'ACTIVE')).join('');
      }
      if (unset.length) {
        if (high.length || med.length || low.length) {
          html += `<h3 style="margin:14px 0 8px;font-family:var(--display);font-weight:400;font-size:15px;color:var(--text-secondary)">Unprioritized</h3>`;
        }
        html += unset.map(g => renderGoalCard(g, 'ACTIVE')).join('');
      }
    }
    if (completedGoals.length) {
      html += `<h3 style="margin:14px 0 8px;font-family:var(--display);font-weight:400;font-size:15px;color:var(--text-secondary)">Completed</h3>`;
      html += completedGoals.map(g => renderGoalCard(g, 'DONE')).join('');
    }
    if (!activeGoals.length && !completedGoals.length) {
      html += '<div class="intel-empty">No goals recorded for this brain.</div>';
    }
    return html;
  }

  async function renderPlans() {
    const data = await fetchIntel('plans');
    if (!data?.plan) return '<div class="intel-empty">No execution plan found for this brain.</div>';

    const p = data.plan;
    const ms = data.milestones || [];
    const tasks = data.tasks || [];

    const tasksByState = { DONE: 0, IN_PROGRESS: 0, PENDING: 0, FAILED: 0 };
    tasks.forEach(t => { tasksByState[t.state] = (tasksByState[t.state] || 0) + 1; });

    let html = `<div class="intel-stat-row">
      <div class="intel-stat"><div class="intel-stat-label">Status</div><div class="intel-stat-value">${esc(p.status || 'unknown')}</div></div>
      <div class="intel-stat"><div class="intel-stat-label">Milestones</div><div class="intel-stat-value">${ms.length}</div></div>
      <div class="intel-stat"><div class="intel-stat-label">Tasks</div><div class="intel-stat-value">${tasks.length}</div></div>
      <div class="intel-stat"><div class="intel-stat-label">Done</div><div class="intel-stat-value">${tasksByState.DONE || 0}</div></div>
    </div>`;

    if (p.title) {
      html += `<div class="intel-card"><h4 class="intel-card-title">${esc(p.title)}</h4></div>`;
    }

    // Milestones with tasks
    for (const m of ms) {
      const mTasks = tasks.filter(t => t.milestoneId === m.id);
      const isActive = p.activeMilestone === m.id;
      html += `<div class="intel-card" style="${isActive ? 'border-color: var(--accent);' : ''}">
        <div class="intel-card-head">
          <h4 class="intel-card-title">${esc(m.title || m.id)}</h4>
          ${badge(m.status || (isActive ? 'ACTIVE' : 'PENDING'))}
        </div>
        ${mTasks.length ? mTasks.map(t => `
          <div style="padding:6px 0;border-top:1px solid var(--border);margin-top:6px;">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <span style="font-size:12.5px;">${esc(truncate(t.title || t.id, 80))}</span>
              ${badge(t.state)}
            </div>
            ${t.assignedAgentId ? `<div class="intel-card-meta"><span>agent: ${esc(t.assignedAgentId)}</span></div>` : ''}
          </div>
        `).join('') : ''}
      </div>`;
    }

    // Plan markdown
    if (data.planMarkdown) {
      html += `<details style="margin-top:12px;"><summary style="cursor:pointer;font-weight:600;font-size:13px;color:var(--text-secondary);">Full Plan Document</summary>
        <div style="margin-top:10px;">${renderMarkdown(data.planMarkdown)}</div>
      </details>`;
    }

    // Archived
    if (data.archived?.length) {
      html += `<details style="margin-top:12px;"><summary style="cursor:pointer;font-weight:600;font-size:13px;color:var(--text-secondary);">${data.archived.length} Archived Plan${data.archived.length > 1 ? 's' : ''}</summary>
        <div style="margin-top:8px;display:grid;gap:6px;">
        ${data.archived.map(a => `<div class="intel-card"><h4 class="intel-card-title">${esc(a.title || a.id)}</h4><div class="intel-card-meta"><span>${esc(a.status || '')}</span></div></div>`).join('')}
        </div>
      </details>`;
    }

    return html;
  }

  async function renderThoughts() {
    const data = await fetchIntel('thoughts?limit=200');
    const thoughts = data?.thoughts || [];
    if (!thoughts.length) return '<div class="intel-empty">No thoughts recorded.</div>';

    let html = `<div class="intel-stat-row">
      <div class="intel-stat"><div class="intel-stat-label">Total</div><div class="intel-stat-value">${data.total}</div></div>
      <div class="intel-stat"><div class="intel-stat-label">Showing</div><div class="intel-stat-value">${thoughts.length}</div></div>
    </div>`;

    // Show newest first
    const reversed = [...thoughts].reverse();
    html += reversed.map(t => `<div class="intel-card">
      <div class="intel-card-meta" style="margin-bottom:4px;">
        <span>cycle ${t.cycle || '?'}</span>
        ${t.type ? `<span>${esc(t.type)}</span>` : ''}
        <span>${relTime(t.timestamp)}</span>
      </div>
      <div class="intel-card-body">${esc(truncate(t.content || t.hypothesis || '', 500))}</div>
    </div>`).join('');

    return html;
  }

  async function renderAgents() {
    const data = await fetchIntel('agents');
    if (!data?.timeline?.length) return '<div class="intel-empty">No agent execution data.</div>';

    const s = data.summary;
    html = `<div class="intel-stat-row">
      <div class="intel-stat"><div class="intel-stat-label">Total</div><div class="intel-stat-value">${s.total}</div></div>
      <div class="intel-stat"><div class="intel-stat-label">Completed</div><div class="intel-stat-value">${s.completed}</div></div>
      <div class="intel-stat"><div class="intel-stat-label">Failed</div><div class="intel-stat-value">${s.failed}</div></div>
    </div>`;

    // By type summary
    if (s.byType) {
      html += `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">`;
      for (const [type, info] of Object.entries(s.byType)) {
        html += `<span class="mini-chip">${esc(type)}: ${info.total} (${info.findings} findings)</span>`;
      }
      html += `</div>`;
    }

    // Timeline
    html += data.timeline.slice(0, 50).map(a => `<div class="intel-card">
      <div class="intel-card-head">
        <h4 class="intel-card-title">${esc(a.agentType || 'Unknown')}</h4>
        ${badge(a.status)}
      </div>
      <div class="intel-card-meta">
        <span>${esc(a.agentId)}</span>
        ${a.duration ? `<span>${esc(String(a.duration))}</span>` : ''}
        ${a.findings ? `<span>${a.findings} findings</span>` : ''}
        ${a.insights ? `<span>${a.insights} insights</span>` : ''}
        <span>${relTime(a.startTime)}</span>
      </div>
      ${a.description ? `<div class="intel-card-body" style="margin-top:4px;">${esc(truncate(a.description, 200))}</div>` : ''}
    </div>`).join('');

    return html;
  }

  function qualityBadge(label, value) {
    if (value == null || value === undefined) return `<span class="review-score" data-quality="none">${label}:–</span>`;
    const n = Number(value);
    const q = n >= 7 ? 'high' : n >= 5 ? 'mid' : 'low';
    return `<span class="review-score" data-quality="${q}">${label}:${n}</span>`;
  }

  async function renderReviews() {
    const data = await fetchIntel('insights');
    if (!data) return '<div class="intel-empty">No coordinator data.</div>';

    const reviews = data.reviews || [];
    const insights = data.insights || [];

    if (!reviews.length && !insights.length) {
      return '<div class="intel-empty">No coordinator reviews or insights found.</div>';
    }

    // Compute average quality scores across reviews that have them
    let depthSum = 0, noveltySum = 0, coherenceSum = 0, scoreCount = 0;
    reviews.forEach(r => {
      const q = r.meta?.qualityScores || r.qualityScores;
      if (q) {
        if (q.depth != null) depthSum += Number(q.depth);
        if (q.novelty != null) noveltySum += Number(q.novelty);
        if (q.coherence != null) coherenceSum += Number(q.coherence);
        scoreCount++;
      }
    });

    let html = `<div class="intel-stat-row">
      <div class="intel-stat"><div class="intel-stat-label">Reviews</div><div class="intel-stat-value">${reviews.length}</div></div>`;
    if (scoreCount > 0) {
      html += `<div class="intel-stat"><div class="intel-stat-label">Avg Depth</div><div class="intel-stat-value">${(depthSum / scoreCount).toFixed(1)}</div></div>`;
      html += `<div class="intel-stat"><div class="intel-stat-label">Avg Novelty</div><div class="intel-stat-value">${(noveltySum / scoreCount).toFixed(1)}</div></div>`;
      html += `<div class="intel-stat"><div class="intel-stat-label">Avg Coherence</div><div class="intel-stat-value">${(coherenceSum / scoreCount).toFixed(1)}</div></div>`;
    }
    html += `</div>`;

    // Reviews — newest first
    if (reviews.length) {
      const sorted = [...reviews].reverse();
      html += sorted.map(r => {
        const meta = r.meta || {};
        const sections = r.sections || {};
        const q = meta.qualityScores || r.qualityScores;

        // Title: "Cycles X–Y" or "Cycle N Review"
        let title;
        if (meta.cyclesReviewed && meta.cyclesReviewed.length > 1) {
          title = `Cycles ${meta.cyclesReviewed[0]}\u2013${meta.cyclesReviewed[meta.cyclesReviewed.length - 1]}`;
        } else if (meta.cyclesReviewed && meta.cyclesReviewed.length === 1) {
          title = `Cycle ${meta.cyclesReviewed[0]} Review`;
        } else {
          title = `Cycle ${r.cycle || '?'} Review`;
        }

        // Quality badges
        let badges = '';
        if (q) {
          badges = `<div class="review-quality-scores">
            ${qualityBadge('D', q.depth)}${qualityBadge('N', q.novelty)}${qualityBadge('C', q.coherence)}
          </div>`;
        }

        // Metrics line
        const metrics = [];
        if (meta.thoughtCount != null) metrics.push(`${meta.thoughtCount} thoughts`);
        if (meta.goalCount != null) metrics.push(`${meta.goalCount} goals`);
        if (meta.nodeCount != null) metrics.push(`${meta.nodeCount} nodes`);
        const metricsLine = metrics.length
          ? `<div class="intel-card-meta" style="margin-top:4px;">${metrics.map(m => `<span>${esc(m)}</span>`).join('')}</div>`
          : '';

        // Summary
        const summary = sections.summary || r.preview || '';
        const summaryHtml = summary
          ? `<div class="review-summary-section"><p>${esc(truncate(summary, 300))}</p></div>`
          : '';

        // Key Insights
        const keyInsights = (sections.keyInsights || []).slice(0, 5);
        const keyInsightsHtml = keyInsights.length
          ? `<div class="review-summary-section"><h5>Key Insights</h5><ul>${keyInsights.map(i => `<li>${esc(truncate(i, 200))}</li>`).join('')}</ul></div>`
          : '';

        // Strategic Recommendations
        const recs = (sections.strategicRecommendations || []).slice(0, 3);
        const recsHtml = recs.length
          ? `<div class="review-summary-section"><h5>Strategic Recommendations</h5><ul>${recs.map(i => `<li>${esc(truncate(i, 200))}</li>`).join('')}</ul></div>`
          : '';

        return `<div class="intel-card intel-clickable" data-intel-file="${esc(r.filename)}">
          <div class="intel-card-head">
            <h4 class="intel-card-title">${esc(title)}</h4>
            ${badges}
          </div>
          ${metricsLine}
          ${summaryHtml}
          ${keyInsightsHtml}
          ${recsHtml}
        </div>`;
      }).join('');
    }

    // Curated insights — collapsible
    if (insights.length) {
      html += `<details style="margin-top:14px;" class="section-disclosure">
        <summary>Curated Insights (${insights.length})</summary>
        <div class="disclosure-content" style="display:grid;gap:6px;">
          ${insights.map(i => `<div class="intel-card intel-clickable" data-intel-file="${esc(i.filename)}">
            <div class="intel-card-head">
              <h4 class="intel-card-title">${esc(i.filename)}</h4>
            </div>
            <div class="intel-card-body">${esc(truncate(i.preview, 200))}</div>
          </div>`).join('')}
        </div>
      </details>`;
    }

    return html;
  }

  async function renderInsightDetail(filename) {
    const data = await fetchIntel(`insight/${encodeURIComponent(filename)}`);
    if (!data?.markdown) return `<div class="intel-empty">Could not load ${esc(filename)}</div>`;

    return `<div style="margin-bottom:10px;">
      <button class="ghost-btn" id="intel-back-btn" style="font-size:12px;">Back to list</button>
    </div>
    ${renderMarkdown(data.markdown)}`;
  }

  async function renderExecutive() {
    const data = await fetchIntel('executive');
    if (!data?.available) return '<div class="intel-empty">No executive ring data available for this brain.</div>';

    const s = data.stats;
    const coherence = typeof s.coherenceScore === 'number' ? s.coherenceScore : 1;
    const coherencePct = Math.round(coherence * 100);
    const zone = coherence > 0.7 ? 'healthy' : coherence > 0.5 ? 'warning' : 'critical';

    let html = '<div class="exec-section">';

    // Stats row
    html += `<div class="intel-stat-row">
      <div class="intel-stat"><div class="intel-stat-label">Cycle</div><div class="intel-stat-value">${data.cycleCount}</div></div>
      <div class="intel-stat"><div class="intel-stat-label">Coherence</div><div class="intel-stat-value">${coherencePct}%</div></div>
      <div class="intel-stat"><div class="intel-stat-label">Interventions</div><div class="intel-stat-value">${s.interventionsTotal || 0}</div></div>
      <div class="intel-stat"><div class="intel-stat-label">Committed Goals</div><div class="intel-stat-value">${s.committedGoalsCount || 0}</div></div>
    </div>`;

    // Coherence bar
    html += `<div class="intel-card">
      <h4 class="intel-card-title">System Coherence</h4>
      <div class="intel-card-body">
        <div class="exec-coherence-bar">
          <div class="exec-coherence-fill" data-zone="${zone}" style="width:${coherencePct}%"></div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:4px;font-family:var(--mono);font-size:10px;color:var(--muted)">
          <span>0 — Critical</span><span>0.5 — Threshold</span><span>1.0 — Healthy</span>
        </div>
      </div>
    </div>`;

    // Mission context
    if (s.missionContext) {
      const mc = s.missionContext;
      html += `<div class="intel-card">
        <h4 class="intel-card-title">Mission Context</h4>
        <div class="intel-card-body">
          ${mc.domain ? `<div><strong>Domain:</strong> ${esc(mc.domain)}</div>` : ''}
          ${mc.description ? `<div style="margin-top:4px">${esc(mc.description.substring(0, 200))}</div>` : ''}
          ${mc.executionMode ? `<div style="margin-top:4px"><span class="intel-badge intel-badge-active">${esc(mc.executionMode)}</span></div>` : ''}
        </div>
      </div>`;
    }

    // Recent interventions
    const interventions = s.recentInterventions || [];
    if (interventions.length > 0) {
      html += `<div class="intel-card">
        <h4 class="intel-card-title">Recent Interventions</h4>
        <div class="intel-card-body"><div class="exec-timeline">`;
      interventions.forEach(i => {
        const badgeClass = i.action === 'EMERGENCY_ESCALATE' ? 'intel-badge-failed'
          : i.action === 'BLOCK_AND_INJECT' ? 'intel-badge-failed'
          : i.action === 'SKIP' || i.action === 'SKIP_AND_REDIRECT' ? 'intel-badge-pending'
          : i.action === 'REDIRECT' ? 'intel-badge-active'
          : 'intel-badge-blocked';
        html += `<div class="exec-timeline-item">
          <span class="exec-timeline-cycle">C${i.cycle || '?'}</span>
          <span class="intel-badge ${badgeClass}">${esc(i.action || 'unknown')}</span>
          <span>${esc(i.reason || '')}</span>
          ${typeof i.coherenceScore === 'number' ? `<span style="margin-left:auto;font-family:var(--mono);font-size:10px;color:var(--muted)">${Math.round(i.coherenceScore * 100)}%</span>` : ''}
        </div>`;
      });
      html += '</div></div></div>';
    }

    // Recent actions
    const actions = s.recentActions || [];
    if (actions.length > 0) {
      html += `<div class="intel-card">
        <h4 class="intel-card-title">Recent Agent Actions</h4>
        <div class="intel-card-body">
          <table class="exec-actions-table">
            <thead><tr><th>Agent</th><th>Status</th><th>Artifacts</th></tr></thead>
            <tbody>`;
      actions.forEach(a => {
        const statusBadge = a.accomplished
          ? '<span class="intel-badge intel-badge-done">done</span>'
          : '<span class="intel-badge intel-badge-failed">fail</span>';
        html += `<tr>
          <td>${esc(a.agentType || 'unknown')}</td>
          <td>${statusBadge}</td>
          <td>${a.artifactCount || 0}</td>
        </tr>`;
      });
      html += '</tbody></table></div></div>';
    }

    // Known blockers
    const blockers = s.knownBlockers || [];
    if (blockers.length > 0) {
      html += `<div class="intel-card">
        <h4 class="intel-card-title">Known Blockers</h4>
        <div class="intel-card-body">`;
      blockers.forEach(b => {
        html += `<div style="margin-bottom:6px">
          <span class="intel-badge intel-badge-failed">${esc(b.agentType)}</span>
          <span style="margin-left:6px;font-size:12px;color:var(--text-secondary)">${esc(b.reason || '')} (${b.count}x)</span>
        </div>`;
      });
      html += '</div></div>';
    }

    // Success patterns
    const successes = s.successPatterns || [];
    if (successes.length > 0) {
      html += `<div class="intel-card">
        <h4 class="intel-card-title">Success Patterns</h4>
        <div class="intel-card-body">`;
      successes.forEach(p => {
        html += `<div style="margin-bottom:4px">
          <span class="intel-badge intel-badge-done">${esc(p.agentType)}</span>
          <span style="margin-left:6px;font-size:12px;color:var(--text-secondary)">${p.successCount}x</span>
        </div>`;
      });
      html += '</div></div>';
    }

    // Error stats
    if (s.errorStats && s.errorStats.total > 0) {
      html += `<div class="intel-card">
        <h4 class="intel-card-title">Error Monitor</h4>
        <div class="intel-card-body">
          <div style="margin-bottom:6px;font-size:12px"><strong>${s.errorStats.total}</strong> total errors</div>`;
      if (s.errorStats.byType) {
        Object.entries(s.errorStats.byType).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
          html += `<div style="margin-bottom:3px;font-size:12px">
            <span style="font-family:var(--mono);font-size:11px;color:var(--muted)">${esc(type)}</span>
            <span style="margin-left:6px">${count}</span>
          </div>`;
        });
      }
      html += '</div></div>';
    }

    // Goal suppression
    if ((s.suppressedGoalsCount || 0) > 0 || (s.committedGoalsCount || 0) > 0) {
      html += `<div class="intel-card">
        <h4 class="intel-card-title">Action Selector (Basal Ganglia)</h4>
        <div class="intel-card-body" style="font-size:12px">
          <div><strong>${s.committedGoalsCount || 0}</strong> committed goals (max 3)</div>
          <div><strong>${s.suppressedGoalsCount || 0}</strong> suppressed goals</div>
        </div>
      </div>`;
    }

    html += '</div>';
    return html;
  }

  async function renderTrajectory() {
    const data = await fetchIntel('trajectory');
    if (!data) return '<div class="intel-empty">No trajectory data available.</div>';

    // Compute fork summary stats
    const forks = data.forks || {};
    const active = forks.activeForks || [];
    const completed = forks.completedForks || [];
    const allForks = [...active.map(f => ({ ...f, _status: 'active' })), ...completed.map(f => ({ ...f, _status: 'completed' }))];
    const totalForks = allForks.length;
    const totalForkInsights = allForks.reduce((sum, f) => sum + (Array.isArray(f.insights) ? f.insights.length : 0), 0);
    const totalMemoryNodes = allForks.reduce((sum, f) => sum + (Array.isArray(f.memoryNodes) ? f.memoryNodes.length : 0), 0);

    let html = `<div class="intel-stat-row">
      <div class="intel-stat"><div class="intel-stat-label">Cycles</div><div class="intel-stat-value">${data.cycleCount || 0}</div></div>
      <div class="intel-stat"><div class="intel-stat-label">Total Forks</div><div class="intel-stat-value">${totalForks}</div></div>
      <div class="intel-stat"><div class="intel-stat-label">Fork Insights</div><div class="intel-stat-value">${totalForkInsights}</div></div>
      <div class="intel-stat"><div class="intel-stat-label">Fork Memory Nodes</div><div class="intel-stat-value">${totalMemoryNodes}</div></div>
    </div>`;

    if (allForks.length) {
      html += allForks.map(f => {
        const title = f.reason || f.id || 'Fork';
        const parentThought = f.parentThought ? `<div class="intel-card-body" style="margin-top:4px;font-style:italic;">${esc(truncate(f.parentThought, 150))}</div>` : '';
        const explorationPrompt = f.explorationPrompt ? `<div class="intel-card-body" style="margin-top:4px;">${esc(truncate(f.explorationPrompt, 200))}</div>` : '';

        let insightsHtml = '';
        if (Array.isArray(f.insights) && f.insights.length) {
          insightsHtml = `<div class="review-summary-section" style="margin-top:6px;"><h5>Insights</h5><ul>${f.insights.map(i => `<li>${esc(truncate(typeof i === 'string' ? i : (i.content || i.text || JSON.stringify(i)), 200))}</li>`).join('')}</ul></div>`;
        }

        const memoryCount = Array.isArray(f.memoryNodes) && f.memoryNodes.length ? `<span>${f.memoryNodes.length} memory nodes</span>` : '';

        return `<div class="intel-card">
          <div class="intel-card-head">
            <h4 class="intel-card-title">${esc(truncate(title, 100))}</h4>
            ${badge(f._status)}
          </div>
          <div class="intel-card-meta">
            ${f.spawnCycle ? `<span>spawned: cycle ${f.spawnCycle}</span>` : ''}
            ${f.resolution ? `<span>resolution: ${esc(f.resolution)}</span>` : ''}
            ${memoryCount}
          </div>
          ${parentThought}
          ${explorationPrompt}
          ${insightsHtml}
        </div>`;
      }).join('');
    }

    if (!totalForks && !data.trajectory) {
      html += '<div class="intel-empty">No trajectory or fork data recorded.</div>';
    }

    return html;
  }

  function formatFileSize(bytes) {
    if (bytes == null) return '';
    const n = Number(bytes);
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  async function renderDeliverables() {
    const data = await fetchIntel('deliverables');
    const items = data?.deliverables || [];
    if (!items.length) return '<div class="intel-empty">No agent deliverables found.</div>';

    const totalFiles = items.reduce((sum, d) => sum + (d.fileCount || 0), 0);

    let html = `<div class="intel-stat-row">
      <div class="intel-stat"><div class="intel-stat-label">Total</div><div class="intel-stat-value">${items.length}</div></div>
      <div class="intel-stat"><div class="intel-stat-label">Complete</div><div class="intel-stat-value">${items.filter(d => d.isComplete).length}</div></div>
      <div class="intel-stat"><div class="intel-stat-label">Files</div><div class="intel-stat-value">${totalFiles}</div></div>
    </div>`;

    html += items.map(d => {
      let fileListHtml = '';
      if (d.files && Array.isArray(d.files) && d.files.length) {
        const shown = d.files.slice(0, 10);
        const remaining = d.files.length - shown.length;
        fileListHtml = `<div class="deliverable-file-list">${shown.map(f => {
          const name = typeof f === 'string' ? f : (f.name || f.filename || '');
          const size = (typeof f === 'object' && f.size != null) ? ` (${formatFileSize(f.size)})` : '';
          return esc(name) + esc(size);
        }).join('<br>')}${remaining > 0 ? `<br><span style="color:var(--muted)">+${remaining} more</span>` : ''}</div>`;
      }

      return `<div class="intel-card">
        <div class="intel-card-head">
          <h4 class="intel-card-title" style="font-family:var(--mono);font-size:12px;">${esc(d.agentId)}</h4>
          ${d.isComplete ? badge('DONE') : badge('PENDING')}
        </div>
        <div class="intel-card-meta">
          <span>${d.fileCount} files</span>
          <span>${relTime(d.modifiedAt)}</span>
        </div>
        ${fileListHtml}
      </div>`;
    }).join('');

    return html;
  }

  // ── Tab dispatch ───────────────────────────────────────────────────────────

  const TABS = {
    goals: { title: 'Goals', render: renderGoals },
    plans: { title: 'Plans', render: renderPlans },
    thoughts: { title: 'Thoughts', render: renderThoughts },
    agents: { title: 'Agents', render: renderAgents },
    reviews: { title: 'Reviews', render: renderReviews },
    executive: { title: 'Executive', render: renderExecutive },
    trajectory: { title: 'Trajectory', render: renderTrajectory },
    deliverables: { title: 'Deliverables', render: renderDeliverables }
  };

  async function switchTab(tabName) {
    activeTab = tabName;

    // Update sidebar
    document.querySelectorAll('.intel-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.intelTab === tabName);
    });

    // Update title
    const titleEl = document.getElementById('intel-content-title');
    if (titleEl) titleEl.textContent = TABS[tabName]?.title || tabName;

    // Render content
    const body = document.getElementById('intel-content-body');
    if (!body) return;

    if (!currentBrain) {
      body.innerHTML = '<div class="intel-empty">Select a brain to explore.</div>';
      return;
    }

    body.innerHTML = '<div class="intel-empty" style="padding:30px;">Loading\u2026</div>';

    try {
      const tab = TABS[tabName];
      if (!tab) {
        body.innerHTML = `<div class="intel-empty">Unknown tab: ${esc(tabName)}</div>`;
        return;
      }
      body.innerHTML = await tab.render();
      bindContentEvents(body);
    } catch (err) {
      body.innerHTML = `<div class="intel-empty">Failed to load: ${esc(err.message)}</div>`;
    }
  }

  function bindContentEvents(container) {
    // Clickable insight/review cards
    container.querySelectorAll('[data-intel-file]').forEach(el => {
      el.addEventListener('click', async () => {
        const filename = el.dataset.intelFile;
        const body = document.getElementById('intel-content-body');
        body.innerHTML = '<div class="intel-empty" style="padding:30px;">Loading\u2026</div>';
        try {
          body.innerHTML = await renderInsightDetail(filename);
          const backBtn = document.getElementById('intel-back-btn');
          if (backBtn) backBtn.addEventListener('click', () => switchTab('reviews'));
        } catch (err) {
          body.innerHTML = `<div class="intel-empty">Failed: ${esc(err.message)}</div>`;
        }
      });
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  function init(brainRouteKey) {
    if (brainRouteKey === currentBrain && activeTab) {
      return; // Already loaded
    }
    currentBrain = brainRouteKey;
    clearCache();
    switchTab(activeTab || 'goals');
  }

  function refresh() {
    clearCache();
    if (currentBrain) switchTab(activeTab);
  }

  window.IntelligenceTab = {
    init,
    switchTab,
    refresh,
    setBrain: (key) => { currentBrain = key; clearCache(); },
    getActiveTab: () => activeTab
  };
})();
