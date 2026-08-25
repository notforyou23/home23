/**
 * Feature-off M28 adapter from the coordination lifecycle port to the
 * existing, installation-root-scoped agent-create contract.
 *
 * This module is deliberately not wired into the CLI, runtime, or HTTP API.
 */

import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { runAgentCreate } from './agent-create.js';
import { generateEcosystem } from './generate-ecosystem.js';
import processNamesAuthority from '../../shared/agent-process-names.cjs';
import modelDefaults from '../../shared/model-defaults.cjs';

const { agentProcessNames } = processNamesAuthority;
const RESIDENT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

function assertResidentName(name) {
  if (typeof name !== 'string' || !RESIDENT_NAME.test(name)) {
    throw Object.assign(new Error('Invalid persistent resident binding'), { code: 'resident_name_invalid' });
  }
}

function promptFor(spec, options) {
  const values = new Map([
    ['Agent display name', spec.displayName],
    ['Owner name', options.ownerName || 'owner'],
    ['Important facts this agent should know about you (optional)', ''],
    ['What should this agent help with?', spec.purpose],
    ['Project folders to ingest now (comma-separated paths, optional)', ''],
    ['Owner Telegram ID', ''],
    ['Timezone', options.timezone || 'UTC'],
    ['Default chat model', options.defaultModel || modelDefaults.DEFAULT_CHAT_MODEL],
    ['Default provider', options.defaultProvider || modelDefaults.DEFAULT_CHAT_PROVIDER],
  ]);
  return {
    askWithDefault: async (question, fallback) => values.get(question) ?? fallback,
    askSecret: async () => '',
    close: () => {},
  };
}

function residentProjection(installationRoot, residentBinding) {
  const instancePath = join(installationRoot, 'instances', residentBinding);
  if (!existsSync(join(instancePath, 'config.yaml'))) return null;
  return Object.freeze({
    kind: 'persistent_resident',
    residentBinding,
    instancePath,
    processNames: Object.freeze(agentProcessNames({
      home23Root: installationRoot,
      agentName: residentBinding,
    })),
  });
}

/**
 * The caller must supply an explicit installation root. Tests inject the
 * underlying create/generate functions; production defaults are the same
 * contracts used by `home23 agent create` and ecosystem generation.
 */
export function createPersistentResidentProvisioner(options) {
  const installationRoot = options?.installationRoot;
  if (typeof installationRoot !== 'string' || !installationRoot) {
    throw new TypeError('installationRoot is required');
  }
  const createAgent = options.createAgent || runAgentCreate;
  const generate = options.generateEcosystem || generateEcosystem;
  const rename = options.rename || renameSync;
  const now = options.now || (() => new Date());

  async function archiveBinding(residentBinding, reason) {
    assertResidentName(residentBinding);
    const source = join(installationRoot, 'instances', residentBinding);
    if (existsSync(source)) {
      const stamp = now();
      if (!(stamp instanceof Date) || !Number.isFinite(stamp.getTime())) {
        throw new TypeError('Lifecycle archive clock is invalid');
      }
      const archiveRoot = join(installationRoot, 'instances', '.house', 'bot-lifecycle-archive');
      mkdirSync(archiveRoot, { recursive: true });
      const suffix = stamp.toISOString().replace(/[^0-9]/g, '');
      const safeReason = String(reason || 'adapter_failure').replace(/[^a-z0-9_-]/gi, '_').slice(0, 80);
      let destination = join(archiveRoot, `${residentBinding}-${suffix}-${safeReason}`);
      let collision = 2;
      while (existsSync(destination)) {
        destination = join(archiveRoot, `${residentBinding}-${suffix}-${safeReason}-${collision}`);
        collision += 1;
      }
      rename(source, destination);
    }
    generate(installationRoot, { quiet: true });
  }

  return Object.freeze({
    inspect: async (residentBinding) => {
      assertResidentName(residentBinding);
      return residentProjection(installationRoot, residentBinding);
    },

    create: async (spec) => {
      assertResidentName(spec?.residentBinding);
      if (spec.copyPrivateMemory !== false) {
        throw Object.assign(new Error('Private-memory copying is forbidden'), { code: 'private_memory_copy_forbidden' });
      }
      if (residentProjection(installationRoot, spec.residentBinding)) {
        return residentProjection(installationRoot, spec.residentBinding);
      }
      try {
        await createAgent(installationRoot, spec.residentBinding, {
          prompt: promptFor(spec, options),
          ingestPaths: [],
        });
      } catch (error) {
        if (existsSync(join(installationRoot, 'instances', spec.residentBinding))) {
          await archiveBinding(spec.residentBinding, 'resident_create_failed');
        }
        throw error;
      }
      const resident = residentProjection(installationRoot, spec.residentBinding);
      if (!resident) {
        throw Object.assign(new Error('Agent create returned without a resident config'), { code: 'resident_create_incomplete' });
      }
      return resident;
    },

    archivePartial: async (resident, reason) => {
      await archiveBinding(resident?.residentBinding, reason);
    },
  });
}
