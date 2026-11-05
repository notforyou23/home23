const { execSync } = require('child_process');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePid(rawOutput) {
  if (!rawOutput) return null;

  // Return all PIDs (there might be multiple processes)
  const pids = rawOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && /^\d+$/.test(line));

  return pids.length > 0 ? pids : null;
}

function parseSinglePid(rawOutput) {
  const pids = parsePid(rawOutput);
  return pids ? pids[0] : null;
}

function getCommandPreview(pid) {
  const command = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8' }).toString().trim();
  if (!command) return 'unknown';
  return command.length > 120 ? `${command.slice(0, 117)}...` : command;
}

function isPortInUse(port) {
  const pids = parsePid(execSync(`lsof -ti:${port}`, { encoding: 'utf8' }).toString().trim());
  return pids && pids.length > 0 ? pids[0] : null;
}

function getAllPidsOnPort(port) {
  try {
    const pids = parsePid(execSync(`lsof -ti:${port}`, { encoding: 'utf8' }).toString().trim());
    return pids || [];
  } catch {
    return [];
  }
}

async function promptForKill(port, pid, commandPreview) {
  process.stdout.write(`⚠️ Port ${port} in use by PID ${pid} (${commandPreview})\n`);
  process.stdout.write('Kill it and continue? (y/N) ');

  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', (data) => {
      process.stdin.pause();
      const answer = String(data || '').trim().toLowerCase();
      resolve(answer === 'y');
    });
    process.stdin.once('error', () => resolve(false));
  });
}

async function checkAndKillStaleProcess(port = 3405) {
  let pid;

  try {
    pid = isPortInUse(port);
  } catch {
    return { ok: true, killed: false };
  }

  if (!pid) {
    return { ok: true, killed: false };
  }

  let commandPreview = 'unknown';
  try {
    commandPreview = getCommandPreview(pid);
  } catch {
    // Keep fallback command preview
  }

  const shouldKill = await promptForKill(port, pid, commandPreview);
  if (!shouldKill) {
    console.error(`❌ Aborted: Port ${port} is in use.`);
    return { ok: false, killed: false };
  }

  // Kill ALL processes on this port (there might be multiple)
  const allPids = getAllPidsOnPort(port);
  for (const p of allPids) {
    try {
      execSync(`kill -9 ${p}`);
    } catch (err) {
      // Ignore errors for individual PIDs (might already be dead)
    }
  }

  // Wait for port to be released (retry up to 5 times)
  for (let attempt = 1; attempt <= 5; attempt++) {
    await sleep(500);
    
    let stillInUse;
    try {
      stillInUse = isPortInUse(port);
    } catch {
      // lsof failed = port is free
      return { ok: true, killed: true };
    }

    if (!stillInUse) {
      return { ok: true, killed: true };
    }

    if (attempt < 5) {
      process.stdout.write(`⏳ Waiting for port ${port} to be released (attempt ${attempt}/5)...\r`);
    }
  }

  console.error(`\n❌ Port ${port} is still in use after kill. Try manually: kill -9 $(lsof -ti:${port})`);
  return { ok: false, killed: true };
}

module.exports = {
  checkAndKillStaleProcess,
};
