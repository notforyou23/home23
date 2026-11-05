import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadWorkersModule(projectRoot) {
  const builtPath = path.join(projectRoot, 'dist', 'workers', 'index.js');
  const sourcePath = path.join(projectRoot, 'src', 'workers', 'index.ts');
  const modulePath = existsSync(builtPath) ? builtPath : sourcePath;
  return await import(pathToFileURL(modulePath).href);
}

function parseOptions(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--template') out.template = args[++i];
    else if (arg === '--owner') out.ownerAgent = args[++i];
    else out._.push(arg);
  }
  return out;
}

export async function handleWorkerCommand(args, projectRoot) {
  const [subcommand, ...rest] = args;
  const workers = await loadWorkersModule(projectRoot);

  if (subcommand === 'create') {
    const opts = parseOptions(rest);
    const name = opts._[0];
    if (!name) throw new Error('Usage: home23 worker create <name> --template <template> [--owner <agent>]');
    const result = workers.createWorkerFromTemplate(projectRoot, {
      name,
      template: opts.template || name,
      ownerAgent: opts.ownerAgent
    });
    console.log(`created worker ${result.worker.name} at ${result.createdPath}`);
    return;
  }

  if (subcommand === 'list') {
    const rows = workers.listWorkers(projectRoot);
    if (rows.length === 0) {
      console.log('no workers created');
      return;
    }
    for (const worker of rows) {
      console.log(`${worker.name}\t${worker.ownerAgent}\t${worker.class}\t${worker.purpose}`);
    }
    return;
  }

  if (subcommand === 'run') {
    const opts = parseOptions(rest);
    const name = opts._[0];
    const prompt = opts._.slice(1).join(' ');
    if (!name || !prompt) throw new Error('Usage: home23 worker run <name> "<prompt>"');
    const baseUrl = process.env.HOME23_WORKER_CONNECTOR_URL || 'http://127.0.0.1:5004';
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/workers/${encodeURIComponent(name)}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, requestedBy: 'cli', requester: 'home23-cli' })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `worker connector HTTP ${res.status}`);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  throw new Error('Usage: home23 worker <create|list|run> ...');
}
