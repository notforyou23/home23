'use strict';

/**
 * Honest Mirror — Diagnostic Scanner
 *
 * A dumb, honest, cheap mirror that catches the system lying to itself.
 *
 * Never trusts self-reports. Reads reality directly: files on disk, PM2 state,
 * cron job state, truth.jsonl contents. No LLM calls. Pure local checks.
 *
 * Findings feed into the existing live-problems store. The scanner is a sensor,
 * not a second brain. Bounded auto-fixes only — never destructive.
 *
 * See DESIGN.md for full architecture.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CHECKS_DIR = path.join(__dirname, 'checks');

function loadChecks() {
  const checks = [];
  if (!fs.existsSync(CHECKS_DIR)) return checks;
  for (const file of fs.readdirSync(CHECKS_DIR).sort()) {
    if (!file.endsWith('.js')) continue;
    try {
      const mod = require(path.join(CHECKS_DIR, file));
      if (mod && mod.id && typeof mod.run === 'function') {
        checks.push(mod);
      }
    } catch (err) {
      // A broken check module should not crash the scanner
      checks.push({
        id: file.replace(/\.js$/, ''),
        label: file,
        intervalMs: 5 * 60 * 1000,
        _broken: err.message,
        async run() {
          return { ok: false, error: `check module failed to load: ${this._broken}`, findings: [] };
        },
      });
    }
  }
  return checks;
}

class DiagnosticScanner {
  constructor({
    brainDir,
    logger = console,
    intervalMs = 5 * 60 * 1000,
    liveProblemStore = null,
  } = {}) {
    if (!brainDir) throw new Error('DiagnosticScanner requires brainDir');
    this.brainDir = brainDir;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.liveProblemStore = liveProblemStore;
    this.checks = loadChecks();
    this.lastRunAt = new Map(); // checkId -> timestamp ms
    this.reportPath = path.join(brainDir, 'diagnostic-report.json');
    this.fixReceiptsPath = path.join(brainDir, 'diagnostic-fix-receipts.jsonl');
    this._timer = null;
    this._running = false;
  }

  start() {
    if (this._timer) return;
    this.logger.info?.('[diagnostic] scanner started', {
      checks: this.checks.map(c => c.id),
      intervalMs: this.intervalMs,
    });
    // Run once immediately
    this.tick().catch(err => {
      this.logger.error?.('[diagnostic] initial tick failed', { error: err.message });
    });
    this._timer = setInterval(() => {
      this.tick().catch(err => {
        this.logger.error?.('[diagnostic] tick failed', { error: err.message });
      });
    }, this.intervalMs);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async tick() {
    if (this._running) return;
    this._running = true;
    try {
      const now = Date.now();
      const allFindings = [];
      const checkResults = [];

      for (const check of this.checks) {
        const lastRun = this.lastRunAt.get(check.id) || 0;
        const checkInterval = check.intervalMs || this.intervalMs;
        if (now - lastRun < checkInterval) continue;

        this.lastRunAt.set(check.id, now);
        const ctx = this._buildContext();

        let result;
        try {
          result = await check.run(ctx);
        } catch (err) {
          result = { ok: false, error: err.message, findings: [] };
        }

        checkResults.push({
          id: check.id,
          label: check.label,
          ok: result.ok,
          error: result.error || null,
          findingCount: result.findings?.length || 0,
        });

        if (result.findings) {
          for (const finding of result.findings) {
            allFindings.push({ ...finding, checkId: check.id, detectedAt: new Date(now).toISOString() });
          }
        }
      }

      // Apply auto-fixes for fixable findings
      const fixReceipts = [];
      for (const finding of allFindings) {
        if (finding.autoFixable && typeof finding.autoFix === 'function') {
          try {
            const fixResult = await finding.autoFix(ctx);
            fixReceipts.push({
              at: new Date().toISOString(),
              checkId: finding.checkId,
              findingId: finding.id,
              action: fixResult.action || 'fix_applied',
              result: fixResult.result || 'ok',
              evidence: fixResult.evidence || null,
              reversible: fixResult.reversible !== false,
            });
          } catch (err) {
            fixReceipts.push({
              at: new Date().toISOString(),
              checkId: finding.checkId,
              findingId: finding.id,
              action: 'fix_attempted',
              result: 'failed',
              error: err.message,
            });
          }
        }
      }

      // Write fix receipts
      if (fixReceipts.length > 0) {
        const lines = fixReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
        fs.appendFileSync(this.fixReceiptsPath, lines);
      }

      // Upsert findings into live-problems store
      if (this.liveProblemStore && allFindings.length > 0) {
        for (const finding of allFindings) {
          if (finding.liveProblem) {
            this._upsertLiveProblem(finding);
          }
        }
      }

      // Close resolved live-problems for findings that are no longer detected
      this._closeResolvedProblems(allFindings, checkResults);

      // Build full check list: include all registered checks, not just those that ran this tick
      const allChecks = this.checks.map(check => {
        const ran = checkResults.find(r => r.id === check.id);
        return ran || {
          id: check.id,
          label: check.label,
          ok: true,
          error: null,
          findingCount: 0,
          ranThisTick: false,
          nextRunInMs: check.intervalMs - (now - (this.lastRunAt.get(check.id) || 0)),
        };
      });
      // Mark checks that actually ran
      for (const rc of checkResults) {
        const entry = allChecks.find(c => c.id === rc.id);
        if (entry) entry.ranThisTick = true;
      }

      // Write report
      const report = {
        generatedAt: new Date(now).toISOString(),
        checksRegistered: this.checks.length,
        checksRun: checkResults.length,
        totalFindings: allFindings.length,
        criticalFindings: allFindings.filter(f => f.severity === 'critical').length,
        warningFindings: allFindings.filter(f => f.severity === 'warning').length,
        infoFindings: allFindings.filter(f => f.severity === 'info').length,
        autoFixesApplied: fixReceipts.length,
        checks: allChecks,
        findings: allFindings.map(f => ({
          id: f.id,
          checkId: f.checkId,
          severity: f.severity,
          code: f.code,
          message: f.message,
          autoFixable: f.autoFixable || false,
          detectedAt: f.detectedAt,
        })),
      };
      fs.writeFileSync(this.reportPath, JSON.stringify(report, null, 2));

      if (allFindings.length > 0) {
        this.logger.warn?.('[diagnostic] findings detected', {
          total: allFindings.length,
          critical: report.criticalFindings,
          warning: report.warningFindings,
        });
      } else if (checkResults.length > 0) {
        this.logger.info?.('[diagnostic] scan clean', { checks: checkResults.length });
      }

      return report;
    } finally {
      this._running = false;
    }
  }

  _buildContext() {
    return {
      brainDir: this.brainDir,
      homeRoot: path.resolve(this.brainDir, '..', '..'),
      agentName: process.env.HOME23_AGENT || 'jerry',
      logger: this.logger,
      now: () => new Date().toISOString(),
    };
  }

  _upsertLiveProblem(finding) {
    if (!this.liveProblemStore || !finding.liveProblem) return;
    try {
      const existing = this.liveProblemStore.get(finding.id);
      if (existing) {
        // Update lastCheckedAt — the problem is still present
        existing.lastCheckedAt = new Date().toISOString();
        existing.lastResult = { ok: false, detail: finding.message, at: new Date().toISOString() };
        this.liveProblemStore.save();
        return;
      }
      // Create new live-problem
      this.liveProblemStore.upsert({
        id: finding.id,
        claim: finding.liveProblem.claim,
        verifier: finding.liveProblem.verifier,
        remediation: finding.liveProblem.remediation || [],
        state: 'open',
        seedOrigin: 'diagnostic',
        openedAt: new Date().toISOString(),
        firstSeenAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        lastResult: { ok: false, detail: finding.message, at: new Date().toISOString() },
        stepIndex: 0,
        remediationLog: [],
      });
      this.logger.info?.('[diagnostic] upserted live-problem', { id: finding.id, claim: finding.liveProblem.claim });
    } catch (err) {
      this.logger.warn?.('[diagnostic] failed to upsert live-problem', { id: finding.id, error: err.message });
    }
  }

  _closeResolvedProblems(currentFindings, checkResults) {
    if (!this.liveProblemStore) return;
    const currentIds = new Set(currentFindings.map(f => f.id));
    // Find diagnostic-origin problems that are no longer detected
    for (const problem of this.liveProblemStore.all()) {
      if (problem.seedOrigin !== 'diagnostic') continue;
      if (problem.state !== 'open' && problem.state !== 'chronic') continue;
      if (currentIds.has(problem.id)) continue;
      // Check if any check that could produce this finding ran this tick
      const findingPrefix = problem.id.split(':')[0];
      const relevantCheckRan = checkResults.some(r => r.id === findingPrefix || problem.id.startsWith(r.id + '_'));
      if (!relevantCheckRan) continue;
      // The check ran and didn't produce this finding — it's resolved
      try {
        problem.state = 'resolved';
        problem.resolvedAt = new Date().toISOString();
        problem.lastResult = { ok: true, detail: 'diagnostic check no longer detects this issue', at: new Date().toISOString() };
        this.liveProblemStore.save();
        this.logger.info?.('[diagnostic] resolved live-problem', { id: problem.id });
      } catch (err) {
        this.logger.warn?.('[diagnostic] failed to resolve live-problem', { id: problem.id, error: err.message });
      }
    }
  }

  getReport() {
    try {
      if (!fs.existsSync(this.reportPath)) return null;
      return JSON.parse(fs.readFileSync(this.reportPath, 'utf8'));
    } catch {
      return null;
    }
  }
}

module.exports = { DiagnosticScanner };