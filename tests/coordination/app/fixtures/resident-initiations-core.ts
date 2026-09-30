import { createCoordinationProcess } from '../../../../src/coordination/app/composition.js';
import type { CoordinationRuntimeConfig } from '../../../../src/coordination/app/runtime-config.js';

let core: ReturnType<typeof createCoordinationProcess> | undefined;
process.on('message', async (message: { operation: string; config?: CoordinationRuntimeConfig }) => {
  try {
    if (message.operation === 'start' && message.config) {
      core = createCoordinationProcess(message.config);
      process.send?.({ type: 'ready', address: await core.start() });
    } else if (message.operation === 'drain') {
      await core?.drain();
      process.exit(0);
    }
  } catch (error) {
    process.send?.({ type: 'error', error: error instanceof Error ? error.stack : String(error) });
    process.exit(1);
  }
});
