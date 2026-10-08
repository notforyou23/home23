/** Preserve supervisor registrations before an admitted software update stops roles. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPrivateJSON } from './product-environment.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const modulePath = root => join(root, 'app/cli/lib/product-supervisor.js');
const importSupervisor = root => import(pathToFileURL(modulePath(root)).href);

export async function captureSupervisorForUpdate(home, candidate, dependencies = {}) {
  if ((dependencies.platform || process.platform) !== 'darwin') return null;
  if (!existsSync(modulePath(candidate))) {
    if (existsSync(modulePath(home))) throw fail('candidate_supervisor_missing', 'The candidate cannot retain this home\'s background supervisor.');
    return null; // Older packages have no supervisor ownership capability.
  }
  const supervisor = dependencies.supervisor || await importSupervisor(candidate);
  const status = await supervisor.inspectProductSupervisor(home);
  if (status.ownership === 'absent') return { ownership: 'absent', registrations: [] };
  if (!['legacy', 'launchd'].includes(status.ownership)) throw fail('host_supervisor_ambiguous', 'The home supervisor is not ready for an admission snapshot.');
  // This client forbids daemon creation if the canonical socket disappears.
  const { stdout } = await supervisor.productSupervisorCommand(home, ['jlist', '--silent']);
  const registrations = JSON.parse(stdout);
  if (!Array.isArray(registrations) || registrations.some(r => !r?.name || !['online', 'stopped', 'errored'].includes(r.pm2_env?.status)) ||
      new Set(registrations.map(r => r.name)).size !== registrations.length) throw fail('host_supervisor_ambiguous', 'The supervisor registration snapshot is invalid.');
  const current = await supervisor.inspectProductSupervisor(home);
  if (current.pid !== status.pid || current.generation !== status.generation || current.ownership !== status.ownership) throw fail('host_supervisor_ambiguous', 'The supervisor changed during admission.');
  return { ownership: status.ownership, expectedPid: status.pid, generation: status.generation, registrations };
}

export async function adoptSupervisorForUpdate(home, journal, dependencies = {}) {
  if ((dependencies.platform || process.platform) !== 'darwin' || !journal.supervisorAdmission) return null;
  const supervisor = dependencies.supervisor || await importSupervisor(home);
  const admission = journal.supervisorAdmission;
  const status = await supervisor.inspectProductSupervisor(home);
  if (['legacy', 'launchd'].includes(admission.ownership)) {
    if ((status.ownership === admission.ownership) && (status.pid !== admission.expectedPid || status.generation !== admission.generation)) {
      throw fail('host_supervisor_ambiguous', 'The admitted supervisor generation changed before migration.');
    }
    if (admission.ownership === 'launchd' && status.ownership !== 'launchd') throw fail('host_supervisor_ambiguous', 'The admitted supervisor ownership changed.');
    return supervisor.adoptProductSupervisor(home, { updateOwnerToken: journal.ownerToken,
      updateId: journal.id, expectedPid: admission.expectedPid, generation: admission.generation,
      registrations: admission.registrations });
  }
  if (status.ownership === 'absent' && admission.ownership === 'absent') {
    if (!journal.desiredRunning) return { ownership: 'absent', running: false };
    return supervisor.ensureProductSupervisor(home);
  }
  throw fail('host_supervisor_ambiguous', 'The admitted supervisor ownership changed.');
}

/** The app may only quit after its resident supervisor has independent ownership. */
export async function verifySupervisorBeforeApplication(home, dependencies = {}) {
  if ((dependencies.platform || process.platform) !== 'darwin' || !existsSync(modulePath(home))) return { ownership: 'not_required' };
  const supervisor = dependencies.supervisor || await importSupervisor(home);
  const status = await supervisor.inspectProductSupervisor(home);
  if (status.ownership === 'launchd') return { ownership: status.ownership, pid: status.pid };
  if (status.ownership === 'absent' && readPrivateJSON(join(home, '.home23-host.json'))?.desiredRunning === false) return { ownership: 'absent', running: false };
  throw fail('host_supervisor_adoption_required', 'The home supervisor needs background ownership before the Mac application can be replaced.');
}
