#!/usr/bin/env node
/** A separate process group alone is still in Core's PM2 kill tree. Exit the
 * launcher, then verify reparenting before the requester admits the worker. */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const launchFailure = () => Object.assign(new Error('The independent update worker could not start.'), { code: 'launch_failed' });

export async function launchIndependentUpdateWorker({ executor, homeRoot, operationId }) {
  let pid;
  try {
    // execFile resolves after the short-lived launcher exits and its worker
    // has been reparented. Only the launcher holds these output pipes.
    const { stdout } = await executeFile(join(executor, 'node'),
      [join(executor, 'product-home-update-launcher.mjs'), homeRoot, operationId],
      { timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 1024,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' } });
    const receipt = JSON.parse(stdout);
    if (!Number.isSafeInteger(receipt.pid) || receipt.pid < 2 || receipt.pid === process.pid) throw launchFailure();
    pid = receipt.pid;
    // Check the whole ancestry, including a possible OS subreaper. Fail
    // closed if the worker disappeared or is still inside Core's tree.
    const rows = execFileSync('/bin/ps', ['-e', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 2_000, maxBuffer: 1024 * 1024 });
    const parents = new Map(rows.trim().split('\n').map(row => row.trim().split(/\s+/).map(Number)));
    const seen = new Set();
    let ancestor = pid;
    while (ancestor > 1) {
      if (ancestor === process.pid || ancestor === receipt.launcherPid || seen.has(ancestor) || !parents.has(ancestor)) throw launchFailure();
      seen.add(ancestor);
      ancestor = parents.get(ancestor);
    }
    process.kill(pid, 0);
    return { pid };
  } catch {
    // The worker cannot run until its PID is durably admitted. A failed
    // handoff must leave neither a live worker nor a falsely running record.
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    throw launchFailure();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [homeRoot, operationId] = process.argv.slice(2);
  const child = spawn(process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), 'product-home-update-worker.mjs'), homeRoot, operationId],
    { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  process.stdout.write(`${JSON.stringify({ pid: child.pid, launcherPid: process.pid })}\n`);
  child.unref();
}
