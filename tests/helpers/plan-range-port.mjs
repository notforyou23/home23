import { createServer } from 'node:net';

// The Host port plan and the owned encoder accept only 20000-60999
// (probeOwnedReady, scripts/embedder/serve.mjs). listen(0) draws from the OS
// ephemeral range, which on macOS is 49152-65535 handed out in sequence, so a
// fixture that stands in for a plan port must pick one inside the plan range.
export async function listenInPlanRange(server, host = '127.0.0.1') {
  for (let attempt = 1; ; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 41000);
    try {
      await new Promise((accept, reject) => {
        const failed = error => { server.off('listening', bound); reject(error); };
        const bound = () => { server.off('error', failed); accept(); };
        server.once('error', failed).once('listening', bound).listen(port, host);
      });
      return port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || attempt >= 50) throw error;
    }
  }
}

/** A plan-range port that was free a moment ago, for servers that bind it themselves. */
export async function freePlanPort(host = '127.0.0.1') {
  const probe = createServer();
  const port = await listenInPlanRange(probe, host);
  await new Promise(accept => probe.close(accept));
  return port;
}
