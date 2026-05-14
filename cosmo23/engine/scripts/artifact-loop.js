#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const { auditArtifactLoop } = require('../src/artifacts/artifact-audit');
const { migrateExistingOutputs } = require('../src/artifacts/artifact-migration');
const { ArtifactRegistry } = require('../src/artifacts/artifact-registry');
const { ArtifactLifecycleManager } = require('../src/artifacts/artifact-lifecycle');
const { verifyArtifactLoop } = require('../src/artifacts/artifact-loop-verifier');

async function main() {
  const [command, runDirArg, ...rest] = process.argv.slice(2);
  if (!command || !['audit', 'migrate', 'verify', 'transition', 'promote', 'supersede'].includes(command) || (command !== 'verify' && !runDirArg)) {
    usage();
    process.exit(2);
  }

  const runDir = runDirArg ? path.resolve(runDirArg) : null;
  const writeReport = getFlag(rest, '--write-report');

  if (command === 'verify') {
    const report = await verifyArtifactLoop({
      runDir: runDir || null,
      logger: console
    });
    printJson({
      command,
      runDir: report.runDir,
      reportPath: report.reportPath,
      passed: report.passed,
      sourceArtifactId: report.sourceArtifactId,
      followupArtifactId: report.followupArtifactId,
      auditTotals: report.auditTotals,
      graphEdges: report.graphEdges
    });
    return;
  }

  if (command === 'audit') {
    const audit = await auditArtifactLoop(runDir);
    if (writeReport) {
      const reportPath = path.join(runDir, 'coordinator', 'artifact_audit_report.json');
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, JSON.stringify(audit, null, 2), 'utf8');
      audit.reportPath = reportPath;
    }
    printJson({
      command,
      runDir,
      reportPath: audit.reportPath || null,
      totals: audit.totals
    });
    return;
  }

  if (command === 'migrate') {
    const migration = await migrateExistingOutputs(runDir);
    const reportPath = path.join(runDir, 'coordinator', 'artifact_migration_report.json');
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(migration, null, 2), 'utf8');
    const audit = await auditArtifactLoop(runDir);
    printJson({
      command,
      runDir,
      reportPath,
      scanned: migration.scanned,
      migrated: migration.migrated,
      taskBindings: migration.taskBindings || 0,
      failed: migration.failed,
      auditTotals: audit.totals
    });
    return;
  }

  if (command === 'transition') {
    const artifactId = rest[0];
    const toState = rest[1];
    if (!artifactId || !toState) {
      usage();
      process.exit(2);
    }
    const registry = new ArtifactRegistry({ runDir });
    await registry.initialize();
    const lifecycle = new ArtifactLifecycleManager({ registry });
    const artifact = await lifecycle.transition(artifactId, toState, {
      changedBy: getOption(rest, '--changed-by') || 'artifact-loop-cli',
      reason: getOption(rest, '--reason') || null
    });
    printJson({
      command,
      runDir,
      artifactId,
      lifecycleState: artifact.lifecycleState,
      transitions: artifact.lifecycleTransitions?.length || 0
    });
    return;
  }

  if (command === 'promote') {
    const artifactId = rest[0];
    if (!artifactId) {
      usage();
      process.exit(2);
    }
    const registry = new ArtifactRegistry({ runDir });
    await registry.initialize();
    const lifecycle = new ArtifactLifecycleManager({ registry });
    const artifact = await lifecycle.promoteCommitted(artifactId, {
      changedBy: getOption(rest, '--changed-by') || 'artifact-loop-cli',
      reason: getOption(rest, '--reason') || null,
      validationResults: getOption(rest, '--validation')
        ? [getOption(rest, '--validation')]
        : [],
      force: getFlag(rest, '--force')
    });
    printJson({
      command,
      runDir,
      artifactId,
      lifecycleState: artifact.lifecycleState,
      transitions: artifact.lifecycleTransitions?.length || 0
    });
    return;
  }

  if (command === 'supersede') {
    const oldArtifactId = rest[0];
    const newArtifactId = rest[1];
    if (!oldArtifactId || !newArtifactId) {
      usage();
      process.exit(2);
    }
    const registry = new ArtifactRegistry({ runDir });
    await registry.initialize();
    const lifecycle = new ArtifactLifecycleManager({ registry });
    const result = await lifecycle.supersede(oldArtifactId, newArtifactId, {
      changedBy: getOption(rest, '--changed-by') || 'artifact-loop-cli',
      reason: getOption(rest, '--reason') || null
    });
    printJson({
      command,
      runDir,
      oldArtifactId,
      newArtifactId,
      oldState: result.oldArtifact.lifecycleState,
      supersededBy: result.oldArtifact.supersededBy
    });
  }
}

function getFlag(args, name) {
  return args.includes(name);
}

function getOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] || null;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  process.stderr.write(`Usage:
  node cosmo23/engine/scripts/artifact-loop.js audit <run-dir> [--write-report]
  node cosmo23/engine/scripts/artifact-loop.js migrate <run-dir>
  node cosmo23/engine/scripts/artifact-loop.js verify [run-dir]
  node cosmo23/engine/scripts/artifact-loop.js transition <run-dir> <artifact-id> <state> [--reason "..."]
  node cosmo23/engine/scripts/artifact-loop.js promote <run-dir> <artifact-id> [--validation "..."] [--force]
  node cosmo23/engine/scripts/artifact-loop.js supersede <run-dir> <old-artifact-id> <new-artifact-id> [--reason "..."]

Examples:
  node cosmo23/engine/scripts/artifact-loop.js audit cosmo23/runs/labor23
  node cosmo23/engine/scripts/artifact-loop.js migrate cosmo23/runs/labor23
  node cosmo23/engine/scripts/artifact-loop.js verify
`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
