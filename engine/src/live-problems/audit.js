const os = require('os');
const { TargetsRegistry } = require('./registry');

function expandHome(p) {
  if (!p || typeof p !== 'string') return p;
  return p.startsWith('~') ? p.replace(/^~/, os.homedir()) : p;
}

function pushFinding(findings, severity, code, message, meta = {}) {
  findings.push({ severity, code, message, ...meta });
}

function firstPathToken(pathStr) {
  if (!pathStr || typeof pathStr !== 'string') return null;
  const trimmed = pathStr.trim();
  if (!trimmed) return null;
  const dot = trimmed.indexOf('.');
  const bracket = trimmed.indexOf('[');
  let end = trimmed.length;
  if (dot >= 0) end = Math.min(end, dot);
  if (bracket >= 0) end = Math.min(end, bracket);
  return trimmed.slice(0, end) || null;
}

function parseNowMinusMinutesTemplate(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^\{\{iso:now-(\d+)min\}\}$/);
  return match ? Number(match[1]) : null;
}

function findFileTarget(registry, filePath) {
  const expanded = expandHome(filePath);
  return (registry.files || []).find((entry) => expandHome(entry.path) === expanded) || null;
}

function findSensorTarget(registry, jsonPath) {
  if (typeof jsonPath !== 'string') return null;
  const match = jsonPath.match(/^sensors\[id=([^\]]+)\]\.ts$/);
  if (!match) return null;
  return (registry.sensors || []).find((entry) => entry.id === match[1]) || null;
}

function auditFileFreshness(problem, verifier, registry, findings) {
  const target = findFileTarget(registry, verifier.args?.path);
  if (!target) return;

  const actual = Number.isFinite(verifier.args?.maxAgeMin) ? verifier.args.maxAgeMin : 360;
  const minFreshness = Number.isFinite(target.minimumFreshnessMin)
    ? target.minimumFreshnessMin
    : (Number.isFinite(target.cadenceMin) ? target.cadenceMin : null);

  if (minFreshness !== null && actual < minFreshness) {
    pushFinding(
      findings,
      'error',
      'freshness_below_target_minimum',
      `${problem.id}: ${verifier.type} threshold ${actual}m is below ${minFreshness}m for ${target.path}`,
      { problemId: problem.id, verifierType: verifier.type, target: target.path, actual, minimum: minFreshness }
    );
  }
}

function auditJsonl(problem, verifier, registry, findings) {
  const target = findFileTarget(registry, verifier.args?.path);
  if (!target) return;

  const actualWindow = Number.isFinite(verifier.args?.windowMinutes) ? verifier.args.windowMinutes : 60;
  const minimumWindow = Number.isFinite(target.minimumWindowMin)
    ? target.minimumWindowMin
    : (Number.isFinite(target.cadenceMin) ? target.cadenceMin : null);

  if (minimumWindow !== null && actualWindow < minimumWindow) {
    pushFinding(
      findings,
      'error',
      'window_below_target_minimum',
      `${problem.id}: jsonl_recent_match window ${actualWindow}m is below ${minimumWindow}m for ${target.path}`,
      { problemId: problem.id, verifierType: verifier.type, target: target.path, actual: actualWindow, minimum: minimumWindow }
    );
  }

  const allowedTsFields = Array.isArray(target.jsonlTsFields) ? target.jsonlTsFields : [];
  const actualTsField = verifier.args?.tsField || 'ts';
  if (allowedTsFields.length > 0 && !allowedTsFields.includes(actualTsField)) {
    pushFinding(
      findings,
      'error',
      'jsonl_ts_field_mismatch',
      `${problem.id}: tsField "${actualTsField}" is not valid for ${target.path}; allowed: ${allowedTsFields.join(', ')}`,
      { problemId: problem.id, verifierType: verifier.type, target: target.path, actual: actualTsField, allowed: allowedTsFields }
    );
  }

  const allowedTopLevel = Array.isArray(target.jsonlTopLevelFields) ? target.jsonlTopLevelFields : [];
  const matchField = verifier.args?.matchField;
  if (allowedTopLevel.length > 0 && typeof matchField === 'string' && matchField.trim()) {
    const topLevel = firstPathToken(matchField);
    if (topLevel && !allowedTopLevel.includes(topLevel)) {
      pushFinding(
        findings,
        'error',
        'jsonl_match_field_mismatch',
        `${problem.id}: matchField "${matchField}" does not match ${target.path} top-level schema; allowed roots: ${allowedTopLevel.join(', ')}`,
        { problemId: problem.id, verifierType: verifier.type, target: target.path, actual: matchField, allowed: allowedTopLevel }
      );
    }
  }
}

function auditJsonPathHttp(problem, verifier, registry, findings) {
  const sensor = findSensorTarget(registry, verifier.args?.path);
  if (!sensor) return;
  const actual = parseNowMinusMinutesTemplate(verifier.args?.value);
  const minimum = Number.isFinite(sensor.minimumFreshnessMin)
    ? sensor.minimumFreshnessMin
    : (Number.isFinite(sensor.cadenceMin) ? sensor.cadenceMin : null);
  if (actual !== null && minimum !== null && actual < minimum) {
    pushFinding(
      findings,
      'error',
      'sensor_freshness_below_target_minimum',
      `${problem.id}: sensor freshness window ${actual}m is below ${minimum}m for ${sensor.id}`,
      { problemId: problem.id, verifierType: verifier.type, target: sensor.id, actual, minimum }
    );
  }
}

function auditVerifier(problem, verifier, registry, findings, pathPrefix = '') {
  if (!verifier?.type) return;

  if (verifier.type === 'file_mtime') {
    auditFileFreshness(problem, verifier, registry, findings);
    return;
  }

  if (verifier.type === 'jsonl_recent_match') {
    auditJsonl(problem, verifier, registry, findings);
    return;
  }

  if (verifier.type === 'jsonpath_http') {
    auditJsonPathHttp(problem, verifier, registry, findings);
    return;
  }

  if (verifier.type === 'composed') {
    const children = Array.isArray(verifier.args?.verifiers) ? verifier.args.verifiers : [];
    for (let i = 0; i < children.length; i += 1) {
      auditVerifier(problem, children[i], registry, findings, `${pathPrefix}child[${i}].`);
    }
  }
}

function auditProblemSpec(problem, opts = {}) {
  const registry = opts.registry || new TargetsRegistry().load();
  const findings = [];
  auditVerifier(problem, problem?.verifier, registry, findings);
  return {
    ok: !findings.some((finding) => finding.severity === 'error'),
    findings,
  };
}

function auditProblemList(problems, opts = {}) {
  const registry = opts.registry || new TargetsRegistry().load();
  return (problems || []).map((problem) => ({
    id: problem?.id || 'unknown',
    ...auditProblemSpec(problem, { registry }),
  }));
}

module.exports = {
  auditProblemSpec,
  auditProblemList,
  parseNowMinusMinutesTemplate,
  firstPathToken,
};
