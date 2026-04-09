const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const yaml = require('js-yaml');

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function parseGuidedPlanContent(content, file) {
  if (!content) {
    return null;
  }

  const task = firstNonEmpty(
    content.match(/\*\*Task:\*\*\s*(.+)$/m)?.[1],
    content.match(/^TASK:\s*(.+)$/m)?.[1]
  );

  let config = {};
  const yamlBlock = content.match(/```yaml\s*([\s\S]*?)```/i)?.[1];
  if (yamlBlock) {
    try {
      config = yaml.load(yamlBlock) || {};
    } catch {
      config = {};
    }
  }

  const context = firstNonEmpty(
    typeof config.context === 'string' ? config.context : '',
    content.match(/\*\*Context:\*\*\s*([\s\S]*?)\n##/m)?.[1]
  );

  return {
    file,
    task,
    context
  };
}

async function findInitialGuidedPlan(runPath) {
  const entries = await fsp.readdir(runPath);
  const planFiles = entries
    .filter(name => /^guided-plan(?:-\d+)?\.md$/.test(name))
    .sort((a, b) => {
      const aTs = Number(a.match(/guided-plan-(\d+)\.md$/)?.[1] || Number.MAX_SAFE_INTEGER);
      const bTs = Number(b.match(/guided-plan-(\d+)\.md$/)?.[1] || Number.MAX_SAFE_INTEGER);
      return aTs - bTs;
    });

  for (const file of planFiles) {
    const parsed = parseGuidedPlanContent(await readTextIfExists(path.join(runPath, file)), file);
    if (parsed?.task) {
      return parsed;
    }
  }

  return null;
}

async function findArchivedPlan(runPath) {
  const plansDir = path.join(runPath, 'plans');
  try {
    const entries = await fsp.readdir(plansDir);
    const planFiles = entries
      .filter(name => /^plan:main(?:_file)?_archived_\d+\.json$/.test(name))
      .sort((a, b) => {
        const aTs = Number(a.match(/_(\d+)\.json$/)?.[1] || 0);
        const bTs = Number(b.match(/_(\d+)\.json$/)?.[1] || 0);
        return bTs - aTs;
      });

    for (const file of planFiles) {
      const parsed = await readJsonIfExists(path.join(plansDir, file));
      if (parsed?.title) {
        return {
          file,
          title: parsed.title
        };
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function inferResearchMetadata(runPath, metadata) {
  const initialPlan = await findInitialGuidedPlan(runPath);
  const archivedPlan = await findArchivedPlan(runPath);

  const domain = firstNonEmpty(
    metadata?.researchDomain,
    metadata?.domain,
    metadata?.topic,
    initialPlan?.task,
    archivedPlan?.title
  );
  const context = firstNonEmpty(
    metadata?.researchContext,
    metadata?.context,
    initialPlan?.context
  );

  return {
    domain,
    context,
    sources: {
      initialPlan: initialPlan?.file || null,
      archivedPlan: archivedPlan?.file || null
    }
  };
}

async function repairRunMetadata(runPath, logger = console) {
  const metadataPath = path.join(runPath, 'run-metadata.json');
  const existing = (await readJsonIfExists(metadataPath)) || {};
  const inferred = await inferResearchMetadata(runPath, existing);

  const next = {
    ...existing
  };

  const original = JSON.stringify(existing);

  if (!firstNonEmpty(next.topic)) {
    next.topic = inferred.domain;
  }
  if (!firstNonEmpty(next.domain)) {
    next.domain = inferred.domain;
  }
  if (!firstNonEmpty(next.researchDomain)) {
    next.researchDomain = firstNonEmpty(next.domain, next.topic, inferred.domain);
  }
  if (!firstNonEmpty(next.context)) {
    next.context = inferred.context;
  }
  if (!firstNonEmpty(next.researchContext)) {
    next.researchContext = firstNonEmpty(next.context, inferred.context);
  }

  if (!firstNonEmpty(next.researchDomain)) {
    return {
      runName: path.basename(runPath),
      repaired: false,
      reason: 'no_inferable_domain'
    };
  }

  if (JSON.stringify(next) === original) {
    return {
      runName: path.basename(runPath),
      repaired: false,
      reason: 'already_ok'
    };
  }

  next.metadataRepair = {
    repairedAt: new Date().toISOString(),
    sources: inferred.sources
  };

  await fsp.writeFile(metadataPath, JSON.stringify(next, null, 2), 'utf8');
  logger.info?.('[metadata-repair] repaired run metadata', {
    runName: path.basename(runPath),
    researchDomain: next.researchDomain,
    sources: inferred.sources
  });

  return {
    runName: path.basename(runPath),
    repaired: true,
    researchDomain: next.researchDomain
  };
}

async function repairAllRunMetadata(runsDir, logger = console) {
  const summary = {
    scanned: 0,
    repaired: 0,
    runs: []
  };

  try {
    const entries = await fsp.readdir(runsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const runPath = path.join(runsDir, entry.name);
      const metadataPath = path.join(runPath, 'run-metadata.json');
      if (!fs.existsSync(metadataPath)) {
        continue;
      }
      summary.scanned += 1;
      const result = await repairRunMetadata(runPath, logger);
      summary.runs.push(result);
      if (result.repaired) {
        summary.repaired += 1;
      }
    }
  } catch (error) {
    logger.warn?.('[metadata-repair] failed to scan runs', {
      error: error.message
    });
  }

  return summary;
}

module.exports = {
  repairRunMetadata,
  repairAllRunMetadata
};
