/**
 * Mission Tracing Functions for Intelligence Dashboard
 * Provides UI integration for COSMO mission tracing and provenance
 */

// Global storage for traced missions
window.tracedMissions = null;

/**
 * Load and display mission traces for current run
 */
async function loadTraceTab() {
    try {
        const agentType = document.getElementById('trace-agent-type')?.value || '';
        const minSources = parseInt(document.getElementById('trace-min-sources')?.value) || 0;
        
        const params = new URLSearchParams();
        if (agentType) params.append('agentType', agentType);
        if (minSources > 0) params.append('minSources', minSources);
        
        const response = await fetch(`/api/trace/${runName}?${params}`);
        const data = await response.json();
        
        // Check for API errors
        if (!response.ok || data.error) {
            throw new Error(data.error || `API error: ${response.status}`);
        }
        
        // Validate response structure
        if (!data.missions || !Array.isArray(data.missions)) {
            throw new Error('Invalid response: missing missions array');
        }
        
        // Update stats
        document.getElementById('trace-stats').style.display = 'flex';
        document.getElementById('trace-stat-missions').textContent = data.missionsCount;
        
        const researchMissions = data.missions.filter(m => {
            const type = m.agentType?.toLowerCase() || '';
            return (type === 'research' || type === 'researchagent') && m.results?.sourcesFound > 0;
        });
        document.getElementById('trace-stat-research').textContent = researchMissions.length;
        
        const totalSources = researchMissions.reduce((sum, m) => 
            sum + (m.results?.sourcesFound || 0), 0
        );
        document.getElementById('trace-stat-sources').textContent = totalSources;
        
        const avgDuration = data.missions.length > 0
            ? (data.missions.reduce((sum, m) => {
                const seconds = parseFloat(m.duration?.replace('s', '')) || 0;
                return sum + seconds;
              }, 0) / data.missions.length).toFixed(1)
            : 0;
        document.getElementById('trace-stat-duration').textContent = avgDuration + 's';
        
        // Render missions table
        const tbody = document.getElementById('trace-missions-body');
        if (data.missions.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center text-secondary">No missions found matching criteria</td></tr>';
            return;
        }
        
        tbody.innerHTML = data.missions.map((mission, i) => {
            const hasQuery = mission.results?.queriesExecuted !== undefined;
            const hasSources = mission.results?.sourcesFound > 0;
            
            return `
                <tr>
                    <td>${i + 1}</td>
                    <td class="font-mono text-xs">${mission.agentId.substring(6, 22)}</td>
                    <td><span class="badge badge-${getAgentTypeColor(mission.agentType)}">${mission.agentType}</span></td>
                    <td>${mission.duration || 'N/A'}</td>
                    <td class="text-center">${hasQuery ? mission.results.queriesExecuted : '-'}</td>
                    <td class="text-center">${hasSources ? mission.results.sourcesFound : '-'}</td>
                    <td class="text-center">${mission.findingsCount || 0}</td>
                    <td class="text-center">
                        <button onclick="showMissionDetail('${mission.agentId}')" class="btn-xs btn-primary">
                            Details
                        </button>
                        ${hasSources ? `
                        <button onclick="exportMissionBibTeX('${mission.agentId}')" class="btn-xs btn-secondary" title="Export ${mission.results.sourcesFound} sources as BibTeX">
                            BibTeX
                        </button>
                        ` : ''}
                    </td>
                </tr>
            `;
        }).join('');
        
        // Store missions data for detail view
        window.tracedMissions = data.missions;
        
    } catch (error) {
        console.error('Failed to load trace:', error);
        document.getElementById('trace-missions-body').innerHTML = 
            `<tr><td colspan="8" class="text-center text-danger">Error: ${error.message}</td></tr>`;
    }
}

/**
 * Get badge color for agent type
 */
function getAgentTypeColor(type) {
    if (!type) return 'gray';
    const t = type.toLowerCase().replace(/agent$/, '');
    const colors = {
        'research': 'blue',
        'analysis': 'purple',
        'synthesis': 'green',
        'planning': 'orange',
        'consistency': 'gray',
        'documentcreation': 'teal',
        'codecreation': 'indigo',
        'codeexecution': 'pink'
    };
    return colors[t] || 'gray';
}

/**
 * Show detailed mission information in modal
 */
async function showMissionDetail(agentId) {
    const mission = window.tracedMissions?.find(m => m.agentId === agentId);
    if (!mission) {
        console.error('Mission not found:', agentId);
        return;
    }
    
    const modal = document.getElementById('mission-detail-modal');
    const body = document.getElementById('mission-detail-body');
    
    document.getElementById('mission-detail-title').textContent = `${mission.agentType} - ${agentId}`;
    
    // Show loading state
    body.innerHTML = '<div class="text-center p-20">Loading detailed mission data...</div>';
    modal.style.display = 'flex';
    
    // Fetch full mission data with all results
    let fullMission = mission;
    try {
        const fullData = await fetch(`/api/trace/${runName}?full=true`).then(r => r.json());
        fullMission = fullData.missions.find(m => m.agentId === agentId) || mission;
    } catch (error) {
        console.error('Could not fetch full data, using cached:', error);
    }
    
    let html = `
        <div class="mb-20">
            <div class="font-14 font-600 mb-10">Mission</div>
            <div class="p-15 bg-gray-50 border-radius-6" style="line-height: 1.6;">
                ${escapeHtml(fullMission.mission?.description || 'N/A')}
            </div>
        </div>
    `;
    
    // Results section
    if (mission.results) {
        html += `
            <div class="mb-20">
                <div class="font-14 font-600 mb-10">Results</div>
                <div class="d-flex gap-15 flex-wrap">
                    ${mission.results.queriesExecuted !== undefined ? 
                        `<div class="stat-box">
                            <div class="stat-label">Queries Executed</div>
                            <div class="stat-value">${mission.results.queriesExecuted}</div>
                        </div>` : ''}
                    ${mission.results.sourcesFound !== undefined ? 
                        `<div class="stat-box">
                            <div class="stat-label">Sources Found</div>
                            <div class="stat-value">${mission.results.sourcesFound}</div>
                        </div>` : ''}
                    ${mission.results.findingsAdded !== undefined ? 
                        `<div class="stat-box">
                            <div class="stat-label">Findings Added</div>
                            <div class="stat-value">${mission.results.findingsAdded}</div>
                        </div>` : ''}
                    ${mission.results.sourcesConsulted !== undefined ? 
                        `<div class="stat-box">
                            <div class="stat-label">Sources Consulted</div>
                            <div class="stat-value">${mission.results.sourcesConsulted}</div>
                        </div>` : ''}
                    ${mission.results.sectionsGenerated !== undefined ? 
                        `<div class="stat-box">
                            <div class="stat-label">Sections Generated</div>
                            <div class="stat-value">${mission.results.sectionsGenerated}</div>
                        </div>` : ''}
                </div>
            </div>
        `;
    }
    
    // Timeline section
    html += `
        <div class="mb-20">
            <div class="font-14 font-600 mb-10">Timeline</div>
            <div class="p-15 bg-gray-50 border-radius-6">
                <div class="mb-8"><strong>Start:</strong> ${new Date(mission.startTime).toLocaleString()}</div>
                <div class="mb-8"><strong>End:</strong> ${new Date(mission.endTime).toLocaleString()}</div>
                <div class="mb-8"><strong>Duration:</strong> ${mission.duration}</div>
                <div><strong>Status:</strong> <span class="badge badge-success">${mission.status}</span></div>
            </div>
        </div>
    `;
    
    // FINDINGS - Show actual finding content from fullResults
    if (fullMission.fullResults && fullMission.fullResults.length > 0) {
        const findings = fullMission.fullResults.filter(r => r && r.type === 'finding');
        const insights = fullMission.fullResults.filter(r => r && r.type === 'insight');
        const syntheses = fullMission.fullResults.filter(r => r && r.type === 'synthesis');
        const consistencyReviews = fullMission.fullResults.filter(r => r && r.type === 'consistency_review');
                
        if (findings.length > 0) {
            html += `
                <div class="mb-20">
                    <div class="font-14 font-600 mb-10">✨ Findings (${findings.length})</div>
                    <div style="max-height: 400px; overflow-y: auto;">
                        ${findings.map((finding, i) => `
                            <div class="p-15 mb-10 bg-blue-50 border-radius-6 border-left-4" style="border-left-color: var(--accent-blue);">
                                <div class="font-12 font-600 text-blue mb-8">Finding ${i + 1}</div>
                                <div class="text-sm" style="line-height: 1.6; white-space: pre-wrap;">${escapeHtml(finding.content || '')}</div>
                                ${finding.nodeId ? `<div class="text-xs text-secondary mt-8">Memory Node ID: ${finding.nodeId}</div>` : ''}
                                ${finding.tag ? `<div class="text-xs text-secondary">Tag: ${finding.tag}</div>` : ''}
                                ${finding.timestamp ? `<div class="text-xs text-secondary">Created: ${new Date(finding.timestamp).toLocaleString()}</div>` : ''}
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }
        
        if (insights.length > 0) {
            html += `
                <div class="mb-20">
                    <div class="font-14 font-600 mb-10">💡 Insights (${insights.length})</div>
                    <div style="max-height: 300px; overflow-y: auto;">
                        ${insights.map((insight, i) => `
                            <div class="p-12 mb-8 bg-purple-50 border-radius-6 border-left-4" style="border-left-color: var(--accent-purple);">
                                <div class="text-sm" style="line-height: 1.6; white-space: pre-wrap;">${escapeHtml(insight.content || '')}</div>
                                ${insight.nodeId ? `<div class="text-xs text-secondary mt-6">Node: ${insight.nodeId}</div>` : ''}
                                ${insight.timestamp ? `<div class="text-xs text-secondary">Created: ${new Date(insight.timestamp).toLocaleString()}</div>` : ''}
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }
        
        if (syntheses.length > 0) {
            html += `
                <div class="mb-20">
                    <div class="font-14 font-600 mb-10">📝 Synthesis</div>
                    <div class="p-15 bg-green-50 border-radius-6 border-left-4" style="border-left-color: var(--accent-green); max-height: 400px; overflow-y: auto;">
                        <div class="text-sm" style="line-height: 1.6; white-space: pre-wrap;">${escapeHtml(syntheses[0].content || '')}</div>
                        ${syntheses[0].findingsCount ? `<div class="text-xs text-secondary mt-10">Synthesized from ${syntheses[0].findingsCount} findings</div>` : ''}
                    </div>
                </div>
            `;
        }
        
        if (consistencyReviews.length > 0) {
            const review = consistencyReviews[0];
            html += `
                <div class="mb-20">
                    <div class="font-14 font-600 mb-10">🔍 Consistency Review</div>
                    <div class="p-15 bg-gray-50 border-radius-6" style="max-height: 400px; overflow-y: auto;">
                        ${review.divergence !== undefined ? `<div class="mb-10"><strong>Divergence Score:</strong> ${(review.divergence * 100).toFixed(1)}% <span class="text-xs text-secondary">(${review.divergence > 0.9 ? 'High - branches explore different angles' : review.divergence > 0.7 ? 'Medium - some disagreement' : 'Low - strong agreement'})</span></div>` : ''}
                        ${review.cycle !== undefined ? `<div class="mb-10"><strong>Cycle:</strong> ${review.cycle}</div>` : ''}
                        <div class="text-sm" style="line-height: 1.6; white-space: pre-wrap;">${escapeHtml(review.content || review.summary || '')}</div>
                    </div>
                </div>
            `;
        }
    } else if (fullMission.findingsCount > 0 || fullMission.insightsCount > 0) {
        // Fallback: Show counts if full data not available
        html += `
            <div class="mb-20">
                <div class="font-14 font-600 mb-10">Results Summary</div>
                <div class="p-15 bg-yellow-50 border-radius-6">
                    <div class="text-sm mb-8">
                        <strong>Findings:</strong> ${fullMission.findingsCount} | 
                        <strong>Insights:</strong> ${fullMission.insightsCount}
                    </div>
                    <div class="text-xs text-secondary">
                        💡 Tip: Content available in full trace export or coordinator logs
                    </div>
                </div>
            </div>
        `;
    }
    
    // Sample sources (if available)
    if (mission.results?.sources && mission.results.sources.length > 0) {
        html += `
            <div class="mb-20">
                <div class="font-14 font-600 mb-10">Sources (${mission.results.sources.length} total)</div>
                <div class="p-15 bg-gray-50 border-radius-6" style="max-height: 300px; overflow-y: auto;">
                    ${mission.results.sources.slice(0, 20).map(url => `
                        <div class="mb-8 text-xs">
                            <a href="${url}" target="_blank" class="text-blue" style="word-break: break-all;">
                                ${url}
                            </a>
                        </div>
                    `).join('')}
                    ${mission.results.sources.length > 20 ? 
                        `<div class="text-secondary text-xs mt-10">... and ${mission.results.sources.length - 20} more sources</div>` 
                        : ''}
                </div>
            </div>
        `;
    }
    
    // Enhanced Provenance Chain
    if (fullMission.mission?.goalId || fullMission.mission?.createdBy || fullMission.mission?.spawnCycle !== undefined) {
        html += `<div class="mb-20">
            <div class="font-14 font-600 mb-10">📋 Provenance Chain</div>`;
        
        // Try to fetch full provenance chain
        try {
            const provenanceData = await fetch(`/api/trace/${runName}/provenance/${agentId}`).then(r => r.json());
            
            if (provenanceData && provenanceData.links) {
                html += `<div class="p-15 bg-gray-50 border-radius-6">`;
                
                // Display chain as flowchart
                html += `<div class="provenance-chain">`;
                
                provenanceData.links.forEach((link, i) => {
                    if (link.type === 'goal') {
                        html += `
                            <div class="chain-link mb-15 p-12 bg-white border-radius-4 border-left-4" style="border-left-color: var(--accent-blue);">
                                <div class="font-12 font-600 text-blue mb-6">🎯 Goal</div>
                                <div class="font-mono text-xs mb-6">${link.id}</div>
                                <div class="text-sm mb-6">${escapeHtml(link.description || 'N/A')}</div>
                                ${link.priority ? `<div class="text-xs text-secondary">Priority: ${link.priority} | Source: ${link.source || 'unknown'}</div>` : ''}
                                ${link.created ? `<div class="text-xs text-secondary">Created: ${new Date(link.created).toLocaleString()}</div>` : ''}
                            </div>
                            <div class="chain-arrow text-center text-secondary mb-10">↓ spawned</div>
                        `;
                    } else if (link.type === 'coordinator_review') {
                        html += `
                            <div class="chain-link mb-15 p-12 bg-white border-radius-4 border-left-4" style="border-left-color: var(--accent-purple);">
                                <div class="font-12 font-600 text-purple mb-6">📊 Coordinator Review</div>
                                <div class="mb-6"><strong>Cycle ${link.cycle}</strong> | File: ${link.file}</div>
                                ${link.goalsEvaluated ? `<div class="text-xs mb-4">Goals Evaluated: ${link.goalsEvaluated}</div>` : ''}
                                ${link.agentsCompleted ? `<div class="text-xs mb-4">Agents Completed: ${link.agentsCompleted}</div>` : ''}
                                ${link.summary ? `<div class="text-xs text-secondary mt-6" style="line-height: 1.4;">${link.summary.substring(0, 200)}...</div>` : ''}
                                <button onclick="viewCoordinatorReview(${link.cycle})" class="btn-xs btn-secondary mt-8">View Full Review</button>
                            </div>
                            <div class="chain-arrow text-center text-secondary mb-10">↓ spawned</div>
                        `;
                    } else if (link.type === 'spawned_by') {
                        html += `
                            <div class="chain-link mb-15 p-12 bg-white border-radius-4 border-left-4" style="border-left-color: var(--accent-green);">
                                <div class="font-12 font-600 text-green mb-6">🚀 Spawned By</div>
                                <div class="mb-6"><strong>${link.source}</strong></div>
                                ${link.reason ? `<div class="text-xs">Reason: ${link.reason}</div>` : ''}
                                ${link.trigger ? `<div class="text-xs">Trigger: ${link.trigger}</div>` : ''}
                            </div>
                            <div class="chain-arrow text-center text-secondary mb-10">↓ executed</div>
                        `;
                    } else if (link.type === 'downstream_usage') {
                        html += `
                            <div class="chain-link mb-15 p-12 bg-white border-radius-4 border-left-4" style="border-left-color: var(--accent-orange);">
                                <div class="font-12 font-600 text-orange mb-6">🔄 Used By (${link.usedBy.length} agents)</div>
                                ${link.usedBy.map(u => `
                                    <div class="text-xs mb-4">
                                        <strong>${u.agentType}:</strong> ${u.agentId.substring(6, 22)} 
                                        <span class="text-secondary">(${u.sourcesUsed} sources consulted)</span>
                                    </div>
                                `).join('')}
                            </div>
                        `;
                    }
                });
                
                // Current mission
                html += `
                    <div class="chain-link p-12 bg-blue-100 border-radius-4 border-left-4" style="border-left-color: var(--accent-blue);">
                        <div class="font-12 font-600 text-blue mb-6">🤖 This Mission</div>
                        <div><strong>${fullMission.agentType}</strong></div>
                        <div class="text-xs text-secondary">${fullMission.agentId}</div>
                    </div>
                `;
                
                html += `</div></div>`;
            }
        } catch (error) {
            console.error('Could not load full provenance:', error);
            // Fallback to basic provenance display
            html += `
                <div class="p-15 bg-gray-50 border-radius-6">
                    ${fullMission.mission.goalId ? `<div class="mb-8"><strong>Goal ID:</strong> <span class="font-mono text-xs">${fullMission.mission.goalId}</span> <button onclick="viewGoal('${fullMission.mission.goalId}')" class="btn-xs btn-secondary">View Goal</button></div>` : ''}
                    ${fullMission.mission.createdBy ? `<div class="mb-8"><strong>Spawned By:</strong> ${fullMission.mission.createdBy}</div>` : ''}
                    ${fullMission.mission.spawnCycle !== undefined ? `<div class="mb-8"><strong>Spawn Cycle:</strong> ${fullMission.mission.spawnCycle} <button onclick="viewCoordinatorReview(${Math.floor(fullMission.mission.spawnCycle / 20) * 20})" class="btn-xs btn-secondary">View Review</button></div>` : ''}
                    ${fullMission.mission.priority !== undefined ? `<div class="mb-8"><strong>Priority:</strong> ${fullMission.mission.priority}</div>` : ''}
                    ${fullMission.mission.tools ? `<div class="mb-8"><strong>Tools:</strong> ${fullMission.mission.tools.join(', ')}</div>` : ''}
                </div>
            `;
        }
        
        html += `</div>`;
    }
    
    body.innerHTML = html;
    modal.style.display = 'flex';
}

/**
 * Close mission detail modal
 */
function closeMissionDetailModal() {
    document.getElementById('mission-detail-modal').style.display = 'none';
}

/**
 * Export mission sources as BibTeX
 */
async function exportMissionBibTeX(agentId) {
    try {
        const mission = window.tracedMissions?.find(m => m.agentId === agentId);
        if (!mission || !mission.results?.sources) {
            showToast('No sources available for this mission', 'warning');
            return;
        }
        
        const response = await fetch('/api/trace/export/bibtex', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                runName: runName,
                agentId: agentId,
                sources: mission.results.sources
            })
        });
        
        if (!response.ok) throw new Error('Export failed');
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${runName}_${agentId.substring(6, 22)}_sources.bib`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        
        showToast(`BibTeX exported: ${mission.results.sources.length} sources`, 'success');
    } catch (error) {
        console.error('BibTeX export failed:', error);
        showToast('Failed to export BibTeX: ' + error.message, 'error');
    }
}

/**
 * Show cross-domain comparison modal
 */
async function showCrossDomainComparison() {
    try {
        const modal = document.getElementById('comparison-modal');
        const body = document.getElementById('comparison-body');
        
        modal.style.display = 'flex';
        body.innerHTML = '<tr><td colspan="5" class="table-loading">Loading comparison across all domains...</td></tr>';
        
        const response = await fetch('/api/trace/compare');
        const data = await response.json();
        
        if (!data.comparison || data.comparison.length === 0) {
            body.innerHTML = '<tr><td colspan="5" class="text-center text-secondary">No research missions found across domains</td></tr>';
            return;
        }
        
        body.innerHTML = data.comparison.map((domain, i) => `
            <tr>
                <td><strong>${domain.domain}</strong></td>
                <td class="text-center">${domain.researchAgents}</td>
                <td class="text-center">${domain.totalSources}</td>
                <td class="text-center">${domain.avgSources}</td>
                <td class="text-center"><strong>${domain.maxSources}</strong></td>
            </tr>
        `).join('');
        
        // Add summary row
        body.innerHTML += `
            <tr class="bg-blue-50 font-600">
                <td><strong>TOTAL</strong></td>
                <td class="text-center">${data.totalMissions}</td>
                <td class="text-center">${data.totalSources}</td>
                <td class="text-center">${(data.totalSources / data.totalMissions).toFixed(1)}</td>
                <td class="text-center"><strong>${Math.max(...data.comparison.map(d => d.maxSources))}</strong></td>
            </tr>
        `;
        
    } catch (error) {
        console.error('Comparison failed:', error);
        document.getElementById('comparison-body').innerHTML = 
            `<tr><td colspan="5" class="text-center text-danger">Error: ${error.message}</td></tr>`;
    }
}

/**
 * Close comparison modal
 */
function closeComparisonModal() {
    document.getElementById('comparison-modal').style.display = 'none';
}

/**
 * View coordinator review in new tab
 */
function viewCoordinatorReview(cycle) {
    window.open(`/reports/review_${cycle}.md`, '_blank');
}

/**
 * View goal details (switch to goals tab and highlight)
 */
function viewGoal(goalId) {
    // Switch to goals tab
    document.querySelectorAll('.nav-link').forEach(link => link.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
    
    const goalsLink = document.querySelector('[data-tab="goals"]');
    const goalsPanel = document.getElementById('tab-goals');
    
    if (goalsLink) goalsLink.classList.add('active');
    if (goalsPanel) goalsPanel.classList.add('active');
    
    // Load goals and highlight the specific goal
    loadGoalsTab().then(() => {
        setTimeout(() => {
            const goalElements = document.querySelectorAll('[data-goal-id]');
            goalElements.forEach(el => {
                if (el.dataset.goalId === goalId) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.style.background = 'var(--accent-yellow-light)';
                    setTimeout(() => {
                        el.style.background = '';
                    }, 2000);
                }
            });
        }, 500);
    });
    
    closeMissionDetailModal();
}
