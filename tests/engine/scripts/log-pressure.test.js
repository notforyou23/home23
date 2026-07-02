import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = process.cwd();

function makeTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'home23-pressure-'));
  mkdirSync(join(home, 'bin'), { recursive: true });
  return home;
}

function writeExecutable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function runLogPressure(home, extraEnv = {}) {
  execFileSync('bash', ['scripts/log-pressure.sh'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${join(home, 'bin')}:${process.env.PATH}`,
      ...extraEnv,
    },
    stdio: 'pipe',
  });
}

function readLoggedEntry(home) {
  const rows = readFileSync(join(home, '.pressure_log.jsonl'), 'utf8')
    .trim()
    .split('\n');
  return JSON.parse(rows.at(-1));
}

test('log-pressure uses HTTP pressure API before SSH', () => {
  const home = makeTempHome();
  try {
    writeExecutable(
      join(home, 'bin', 'curl'),
      `#!/bin/bash
cat <<'JSON'
{"latest":{"ts":"2026-05-11T10:00:00Z","pressure_pa":101234,"pressure_inhg":29.89,"temp_c":20.1,"temp_f":68.2}}
JSON
`
    );
    writeExecutable(
      join(home, 'bin', 'ssh'),
      `#!/bin/bash
echo "ssh should not be called" >&2
exit 2
`
    );

    runLogPressure(home, { PI_PRESSURE_API_URL: 'http://sensor.test/api/latest' });

    const entry = readLoggedEntry(home);
    assert.equal(entry.ts, '2026-05-11T10:00:00Z');
    assert.equal(entry.pressure_pa, 101234);
    assert.equal(entry.pressure_inhg, 29.89);
    assert.equal(entry.temp_c, 20.1);
    assert.equal(entry.temp_f, 68.2);
    assert.equal(entry.source_transport, 'http');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('log-pressure SSH fallback prefers explicit automation key when present', () => {
  const home = makeTempHome();
  try {
    mkdirSync(join(home, '.ssh'), { recursive: true });
    const keyPath = join(home, '.ssh', 'id_ed25519_pi');
    writeFileSync(keyPath, 'test-key');
    const argsPath = join(home, 'ssh-args.txt');

    writeExecutable(
      join(home, 'bin', 'curl'),
      `#!/bin/bash
exit 0
`
    );
    writeExecutable(
      join(home, 'bin', 'ssh'),
      `#!/bin/bash
printf '%s\\n' "$*" > "$SSH_ARGS_CAPTURE"
cat <<'JSON'
{"ts":"2026-05-11T10:05:00Z","pressure_pa":101111,"pressure_inhg":29.85,"temp_c":20,"temp_f":68}
JSON
`
    );

    runLogPressure(home, { PI_SSH_TARGET: 'sensor-host', SSH_ARGS_CAPTURE: argsPath });

    const entry = readLoggedEntry(home);
    const sshArgs = readFileSync(argsPath, 'utf8');
    assert.equal(entry.source_transport, 'ssh_key_file');
    assert.equal(entry.pressure_pa, 101111);
    assert.match(sshArgs, new RegExp(`-i ${keyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(sshArgs, /IdentitiesOnly=yes/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('log-pressure SSH fallback can still use agent when no automation key exists', () => {
  const home = makeTempHome();
  try {
    const argsPath = join(home, 'ssh-args.txt');
    writeExecutable(
      join(home, 'bin', 'curl'),
      `#!/bin/bash
exit 0
`
    );
    writeExecutable(
      join(home, 'bin', 'ssh'),
      `#!/bin/bash
printf '%s\\n' "$*" > "$SSH_ARGS_CAPTURE"
cat <<'JSON'
{"ts":"2026-05-11T10:10:00Z","pressure_pa":101000,"pressure_inhg":29.82}
JSON
`
    );

    runLogPressure(home, { PI_SSH_TARGET: 'sensor-host', SSH_ARGS_CAPTURE: argsPath });

    const entry = readLoggedEntry(home);
    const sshArgs = readFileSync(argsPath, 'utf8');
    assert.equal(entry.source_transport, 'ssh_agent');
    assert.equal(entry.pressure_pa, 101000);
    assert.doesNotMatch(sshArgs, / -i /);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
