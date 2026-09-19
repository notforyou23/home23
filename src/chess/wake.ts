import { createResidentCredential } from '../coordination/resident-protocol/index.js';
import { ResidentUdsClient } from '../coordination/transport/uds/index.js';
import type { ScheduledChannelTurn } from '../coordination/app/scheduled-turns.js';
/** Uses the same signed resident capability as the harness; never creates credentials. */
export function signedChessWake(env: NodeJS.ProcessEnv = process.env) {
  if (!env.HOME23_AGENT || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(env.HOME23_AGENT) || !/^[a-f0-9]{64}$/i.test(env.HOME23_COORDINATION_RESIDENT_KEY ?? '') ||
      !env.HOME23_COORDINATION_RESIDENT_CLIENT_INSTANCE_ID || !/^[1-9][0-9]*$/.test(env.HOME23_COORDINATION_RESIDENT_KEY_VERSION ?? '') ||
      !env.HOME23_COORDINATION_SOCKET_PATH?.startsWith('/')) throw new Error('Existing signed resident environment required');
  const rootKey = Buffer.from(env.HOME23_COORDINATION_RESIDENT_KEY!, 'hex');
  const credential = createResidentCredential({ residentSlug: env.HOME23_AGENT, role: 'resident', instanceId: env.HOME23_COORDINATION_RESIDENT_CLIENT_INSTANCE_ID,
    keyVersion: Number(env.HOME23_COORDINATION_RESIDENT_KEY_VERSION), rootKey });
  rootKey.fill(0);
  const client = new ResidentUdsClient({ socketPath: env.HOME23_COORDINATION_SOCKET_PATH,
    serverInstanceId: env.HOME23_COORDINATION_SERVER_INSTANCE_ID ?? 'home23-coordination', credential });
  let last = 0;
  return { close: () => client.close(), async submit(input: ScheduledChannelTurn) {
    const wait = 2000 - (Date.now() - last); if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    last = Date.now();
    return (await client.request({ method: 'POST', path: '/internal/v1/scheduled-turns', fence: null,
      payload: JSON.parse(JSON.stringify(input)), deadlineAtMs: Date.now() + 10000 })).payload as { state: string; workIds?: string[]; error?: string };
  } };
}
