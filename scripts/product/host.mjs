#!/usr/bin/env node
/** Native Host bridge: one JSON result on stdout; credentials enter stdin only. */
import { isAbsolute, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { absoluteHome, productEnvironment } from '../../cli/lib/product-environment.js';
const originalStdout = process.stdout.write.bind(process.stdout);
// Third-party preparation modules use console.log. Keep protocol stdout clean.
console.log = console.info = (...values) => console.error(...values);
const args = process.argv.slice(2);
const action = args.shift();
let homeRoot;
const sensitive = [];
const USAGE = 'Usage: host.mjs device-connect-status|device-connect|home-update-status|home-update-action|register-application|adoption-plan|adopt|preview|stage|update|update-resume|update-recovery|install-staged|check-update|stage-release|download-release|backup|backup-inspect|backup-recover|move|install|catalog|status|create|oauth-start|oauth-complete|oauth-status|oauth-cancel|oauth-logout|semantic-prepare|start|stop --home ABS [--payload ABS] [--staging ABS] [--feed ABS] [--trust-key ABS] [--archive ABS] [--key ABS] [--inspection ABS] [--destination ABS] [--provider ABS] [--preservation-plan ABS --plan-sha256 HEX] [--application ABS] [--client-build INT] [--admit]';

function adoptionReply(result) {
  const { plan, inventory, ...rest } = result;
  const source = plan || result;
  return {
    ...rest,
    // The full path inventory can be hundreds of thousands of entries. Keep
    // the command reply bounded while retaining every blocking path/reason.
    inventoryEntryCount: source.inventory?.paths?.length || 0,
    inventoryExceptions: source.inventory?.paths?.filter(entry => entry.role === 'unknown' || entry.type === 'symlink')
      .map(({ path, type, role, target, mapping }) => ({ path, type, role, ...(target !== undefined ? { target } : {}),
        ...(mapping?.destination ? { destination: mapping.destination } : {}) })) || [],
    ...(plan ? { plan: { schema: plan.schema, root: plan.root, layout: plan.layout,
      canAdopt: plan.canAdopt, reasons: plan.reasons, identity: plan.identity,
      inventoryEntryCount: plan.inventory?.paths?.length || 0 } } : {}),
    homeBirth: result.homeBirth || source.plan?.homeBirth || 'not_run',
    encoderRecipe: source.plan?.encoderRecipe || 'unchanged',
    writersStarted: false,
  };
}

/** Owner-facing wrappers: these replies are host.mjs command results, not installed-UI proof or public trust. */
function portabilityReply(kind, result) {
  const commandResult = {
    ...result,
    resultKind: 'command',
    installedUiProof: false,
    // Local owner portability is not a public distribution trust signal.
    publisherTrust: 'local',
    publicTrust: false,
  };
  if (kind === 'backup') {
    return {
      ...commandResult,
      status: result.ok === false ? 'failed' : 'backed-up',
      keyIsRecoveryMaterial: true,
      keyOutsideArchive: true,
      ownerMessage: result.ok === false
        ? undefined
        : 'Backup command completed. The separate key file is recovery material kept outside the archive. Writers were not started. This is a command result, not an installed-UI proof. Local trust is not public trust.',
    };
  }
  if (kind === 'backup-inspect') {
    return {
      ...commandResult,
      status: result.ok === false ? 'failed' : 'inspected',
      restoredRunning: false,
      ownerMessage: result.ok === false
        ? undefined
        : 'Inspect/restore command completed into the inspection root. Reconnect is required for ports and machine paths. The restored tree is not already running. This is a command result, not an installed-UI proof. Local trust is not public trust.',
    };
  }
  if (kind === 'backup-recover') {
    return {
      ...commandResult,
      status: result.ok === false ? 'failed' : 'recovered',
      restoredRunning: false,
      writersStarted: false,
      birthInvoked: false,
      ownerMessage: result.ok === false
        ? undefined
        : 'Recovery installed a verified runtime into the inspected folder and rebound ports, supervisor registration, and absolute machine paths. Writers were not started and birth was not run. This is a command result, not an installed-UI proof. Local trust is not public trust.',
    };
  }
  return {
    ...commandResult,
    status: result.ok === false ? 'failed' : 'moved',
    ownerMessage: result.ok === false
      ? undefined
      : 'Move command completed. Destination desired-running remains false and writers were not started. The source stays fenced. This is a command result, not an installed-UI proof. Local trust is not public trust.',
  };
}

try {
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (key === '--admit') {
      if (!['update', 'install-staged'].includes(action) || options.admit) throw new Error(USAGE);
      options.admit = true;
      continue;
    }
    if (!['--home', '--payload', '--staging', '--feed', '--trust-key', '--archive', '--key', '--inspection', '--destination', '--provider', '--preservation-plan', '--plan-sha256', '--application', '--client-build'].includes(key) || !args.length || options[key]) throw new Error(USAGE);
    options[key] = args.shift();
  }
  if (action !== 'backup-inspect' && action !== 'backup-recover') homeRoot = absoluteHome(options['--home']);
  if (options['--staging'] && !['stage', 'update', 'stage-release', 'download-release', 'install-staged'].includes(action)) throw new Error('--staging is only supported by stage, update, stage-release, download-release, and install-staged.');
  if (options['--feed'] && !['check-update', 'stage-release', 'download-release'].includes(action)) throw new Error('--feed is only supported by check-update, stage-release, and download-release.');
  if (options['--trust-key'] && !['check-update', 'stage-release', 'download-release', 'install-staged'].includes(action)) throw new Error('--trust-key is only supported by check-update, stage-release, download-release, and install-staged.');
  const oauthActions = ['oauth-start', 'oauth-complete', 'oauth-status', 'oauth-cancel', 'oauth-logout'];
  if (options['--provider'] && !oauthActions.includes(action)) throw new Error('--provider is only supported by oauth-start, oauth-complete, oauth-status, oauth-cancel, and oauth-logout.');
  if (options['--application'] && action !== 'register-application') throw new Error('--application is only supported by register-application.');
  if (options['--client-build'] && action !== 'home-update-status') throw new Error('--client-build is only supported by home-update-status.');
  if ((options['--preservation-plan'] || options['--plan-sha256']) && !['adoption-plan', 'adopt'].includes(action)) throw new Error('The preservation plan is only supported by adoption commands.');
  let input = {};
  if (action === 'stage' || action === 'update') input.staging = options['--staging'];
  if (options.admit) input.admit = true;
  if (action === 'device-connect-status' || action === 'device-connect') {
    const { getDeviceConnectionStatus, enableDeviceConnection } = await import('../../cli/lib/product-device-connection.js');
    const result = action === 'device-connect-status'
      ? await getDeviceConnectionStatus({ homeRoot })
      : await enableDeviceConnection({ homeRoot });
    originalStdout(JSON.stringify(result) + '\n');
    if (result.ok === false) process.exitCode = 1;
  } else if (action === 'home-update-status' || action === 'home-update-action' || action === 'register-application') {
    const { homeUpdateStatus, requestHomeUpdate, registerProductApplication } = await import('../../cli/lib/product-home-update.js');
    let result;
    if (action === 'register-application') {
      if (!options['--application'] || !isAbsolute(options['--application'])) throw new Error('register-application requires --application ABS.');
      result = await registerProductApplication({ homeRoot, applicationPath: resolve(options['--application']) });
    } else if (action === 'home-update-status') {
      const build = options['--client-build'];
      if (build && (!/^\d+$/.test(build) || !Number.isSafeInteger(Number(build)))) throw new Error('Invalid client build.');
      result = await homeUpdateStatus({ homeRoot, clientBuild: build ? Number(build) : undefined });
    } else {
      let raw = '';
      for await (const part of process.stdin) { raw += part; if (Buffer.byteLength(raw) > 65536) throw new Error('Home update action input is too large.'); }
      let request;
      try { request = JSON.parse(raw || '{}'); } catch { throw new Error('Home update action requires valid JSON input.'); }
      if (!['check', 'update', 'resume', 'recover'].includes(request.action)
        || typeof request.idempotencyKey !== 'string' || !request.idempotencyKey.trim()
        || (request.clientBuild !== undefined && (!Number.isSafeInteger(request.clientBuild) || request.clientBuild < 0))) {
        throw new Error('Invalid Home23 update action request.');
      }
      result = await requestHomeUpdate({ homeRoot, action: request.action, idempotencyKey: request.idempotencyKey,
        principalId: 'local-owner', clientBuild: request.clientBuild });
    }
    originalStdout(JSON.stringify(result) + '\n');
    if (result.ok === false) process.exitCode = 1;
  } else if (action === 'adoption-plan' || action === 'adopt') {
    if (action === 'adopt' && (!options['--destination'] || !options['--payload'])) throw new Error('adopt requires --destination and --payload.');
    if (action === 'adoption-plan' && (options['--destination'] || options['--payload'])) throw new Error('adoption-plan only accepts --home.');
    if (Boolean(options['--preservation-plan']) !== Boolean(options['--plan-sha256'])) throw new Error('Adoption preservation requires a plan file and its SHA-256.');
    if (options['--plan-sha256'] && !/^[a-f0-9]{64}$/.test(options['--plan-sha256'])) throw new Error('Invalid adoption plan SHA-256.');
    let preservationPlan = null;
    if (options['--preservation-plan']) {
      const bytes = readFileSync(resolve(options['--preservation-plan']));
      if (createHash('sha256').update(bytes).digest('hex') !== options['--plan-sha256']) throw new Error('Adoption plan file changed.');
      preservationPlan = JSON.parse(bytes.toString('utf8'));
    }
    const { planManagedSourceAdoption, adoptManagedSourceHome } = await import('../../cli/lib/product-update.js');
    const result = action === 'adoption-plan'
      ? planManagedSourceAdoption(homeRoot, { preservationPlan })
      : await adoptManagedSourceHome({ sourceHome: homeRoot, destinationRoot: options['--destination'], payloadPath: options['--payload'], preservationPlan });
    originalStdout(JSON.stringify(adoptionReply(result)) + '\n');
    if (result.ok === false || result.canAdopt === false) process.exitCode = 1;
  } else if (action === 'move') {
    if (!options['--destination'] || !options['--archive'] || !options['--key']) throw new Error('move requires --destination, --archive, and --key.');
    const { moveHome } = await import('../../cli/lib/product-backup.js');
    const result = portabilityReply('move', await moveHome({
      sourceHome: homeRoot,
      destinationRoot: options['--destination'],
      archivePath: options['--archive'],
      keyPath: options['--key'],
    }));
    originalStdout(JSON.stringify(result) + '\n');
    if (result.ok === false) process.exitCode = 1;
  } else if (action === 'backup-recover') {
    if (!options['--inspection'] || !options['--payload'] || !options['--archive'] || !options['--key']) {
      throw new Error('backup-recover requires --inspection, --payload, --archive, and --key.');
    }
    const { recoverInspectedHome } = await import('../../cli/lib/product-backup.js');
    const result = portabilityReply('backup-recover', await recoverInspectedHome({
      inspectionRoot: options['--inspection'],
      payloadPath: options['--payload'],
      archivePath: options['--archive'],
      keyPath: options['--key'],
    }));
    originalStdout(JSON.stringify(result) + '\n');
    if (result.ok === false) process.exitCode = 1;
  } else if (action === 'backup' || action === 'backup-inspect') {
    if (action === 'backup' && (!options['--archive'] || !options['--key'])) throw new Error('backup requires --archive and --key.');
    if (action === 'backup-inspect' && (!options['--archive'] || !options['--key'] || !options['--inspection'])) {
      throw new Error('backup-inspect requires --archive, --key, and --inspection.');
    }
    const { createHomeBackup, inspectHomeBackup } = await import('../../cli/lib/product-backup.js');
    const result = portabilityReply(
      action,
      action === 'backup'
        ? await createHomeBackup({ homeRoot, archivePath: options['--archive'], keyPath: options['--key'] })
        : await inspectHomeBackup({ archivePath: options['--archive'], keyPath: options['--key'], inspectionRoot: options['--inspection'] }),
    );
    originalStdout(JSON.stringify(result) + '\n');
    if (result.ok === false) process.exitCode = 1;
  } else if (action === 'download-release') {
    if (!options['--feed'] || !options['--staging'] || !options['--trust-key']) throw new Error('download-release requires --feed, --staging, and --trust-key.');
    const { downloadDevelopmentRelease } = await import('../../cli/lib/product-update-feed.js');
    const result = await downloadDevelopmentRelease({
      homeRoot, feedPath: options['--feed'], staging: options['--staging'], trustKeyPath: options['--trust-key'],
      onProgress: progress => process.stderr.write(`${JSON.stringify(progress)}\n`),
    });
    originalStdout(JSON.stringify(result) + '\n');
    if (result.ok === false) process.exitCode = 1;
  } else if (action === 'stage-release') {
    if (!options['--feed'] || !options['--staging'] || !options['--trust-key']) throw new Error('stage-release requires --feed, --staging, and --trust-key.');
    const { stageAuthenticatedRelease } = await import('../../cli/lib/product-update-feed.js');
    const result = stageAuthenticatedRelease({ homeRoot, feedPath: options['--feed'], staging: options['--staging'], trustKeyPath: options['--trust-key'] });
    originalStdout(JSON.stringify(result) + '\n');
    if (result.ok === false) process.exitCode = 1;
  } else if (action === 'check-update') {
    if (!options['--feed']) throw new Error('check-update requires --feed ABS.');
    const { inspectReleaseFeed } = await import('../../cli/lib/product-update-feed.js');
    const result = inspectReleaseFeed({ homeRoot, feedPath: options['--feed'], trustKeyPath: options['--trust-key'] });
    originalStdout(JSON.stringify(result) + '\n');
    if (result.status === 'unavailable' || result.status === 'damaged' || result.status === 'incompatible') process.exitCode = 1;
  } else if (action === 'install-staged') {
    if (!options['--staging']) throw new Error('install-staged requires --staging ABS.');
    const { selectStagedInstall } = await import('../../cli/lib/product-update-feed.js');
    const selection = selectStagedInstall({ staging: options['--staging'], trustKeyPath: options['--trust-key'] });
    if (!selection.selected) {
      originalStdout(JSON.stringify(selection) + '\n');
      process.exitCode = 1;
    } else {
      const { applyProductUpdate } = await import('../../cli/lib/product-update-apply.js');
      // The verified download stage is already owned and claimed for this home.
      // Reuse it in place; do not copy the payload into a second staging tree.
      const result = await applyProductUpdate({
        homeRoot,
        candidatePayload: selection.candidatePayload,
        staging: resolve(options['--staging']),
        reuseVerifiedStage: true,
        admit: options.admit === true,
      });
      originalStdout(JSON.stringify({
        ...result,
        usesUpdateController: true,
        selectedCandidatePayload: selection.candidatePayload,
        packageId: result.toPackageId || selection.packageId,
        // Integrity and stage selection are not publisher authentication.
        // Retain development signature evidence from the authenticated download path.
        publisherTrust: selection.publisherTrust === 'development' && selection.developmentSignatureVerified === true
          ? 'development'
          : (result.publisherTrust || 'unverified'),
        developmentSignatureVerified: selection.developmentSignatureVerified === true,
        // Not installed until the update controller returns committed.
        installed: result.status === 'committed',
        canInstall: false,
      }) + '\n');
      if (result.ok === false) process.exitCode = 1;
    }
  } else if (action === 'update-recovery') {
    const { readUpdateJournal } = await import('../../cli/lib/product-update-apply.js');
    const journal = readUpdateJournal(homeRoot);
    if (!journal) {
      originalStdout(JSON.stringify({
        ok: true,
        status: 'absent',
        phase: 'absent',
        homeRoot,
        canInstall: false,
        networkInstall: false,
        current: false,
      }) + '\n');
    } else {
      originalStdout(JSON.stringify({
        ok: true,
        status: journal.phase,
        phase: journal.phase,
        homeRoot: journal.homeRoot,
        fromPackageId: journal.fromPackageId,
        toPackageId: journal.toPackageId,
        canInstall: false,
        networkInstall: false,
        current: journal.phase === 'committed',
        recoveryRequired: journal.phase === 'recovery_required',
      }) + '\n');
    }
  } else if (action === 'update' || action === 'update-resume') {
    const { applyProductUpdate, resumeProductUpdate } = await import('../../cli/lib/product-update-apply.js');
    const result = action === 'update-resume'
      ? await resumeProductUpdate({ homeRoot })
      : await applyProductUpdate({ homeRoot, candidatePayload: options['--payload'], staging: input.staging, admit: input.admit === true });
    originalStdout(JSON.stringify(result) + '\n');
    if (result.ok === false) process.exitCode = 1;
  } else {
  if (action === 'create' || action === 'oauth-start' || action === 'oauth-complete' || action === 'oauth-status' || action === 'oauth-cancel' || action === 'oauth-logout') {
    let raw = '';
    for await (const part of process.stdin) { raw += part; if (Buffer.byteLength(raw) > 65536) throw new Error('Home23 setup input is too large.'); }
    try { input = JSON.parse(raw || '{}'); } catch { throw new Error(action === 'create' ? 'Home23 setup requires a valid JSON profile on stdin.' : 'Home23 OAuth requires valid JSON on stdin.'); }
    if (typeof input.credential?.apiKey === 'string') sensitive.push(input.credential.apiKey, input.credential.apiKey.trim());
    if (typeof input.callbackUrl === 'string' && input.callbackUrl) sensitive.push(input.callbackUrl);
    if (oauthActions.includes(action) && options['--provider']) {
      if (input.provider && input.provider !== options['--provider']) throw new Error('The provider on stdin must match --provider.');
      input.provider ||= options['--provider'];
    }
  }
  const cleanEnv = productEnvironment(homeRoot);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, cleanEnv);
  // Redact supplied credentials even if a downstream dependency logs an error.
  const originalError = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => originalError(sensitive.filter(Boolean).reduce((value, secret) => value.split(secret).join('[redacted]'), String(chunk)), ...rest);
  const { runHostAction } = await import('../../cli/lib/product-host.js');
  const result = await runHostAction(action, { homeRoot, payloadPath: options['--payload'], input });
  originalStdout(JSON.stringify(result) + '\n');
  if (result.ok === false) process.exitCode = 1;
  }
} catch (error) {
  const message = sensitive.filter(Boolean).reduce((value, secret) => value.split(secret).join('[redacted]'), String(error.message || 'Home23 Host operation failed.'));
  originalStdout(JSON.stringify({ ok: false, status: 'degraded', homeRoot, error: { code: error.code || 'host_operation_failed', message } }) + '\n');
  process.exitCode = 1;
}
