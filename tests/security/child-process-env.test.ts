import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  PRIVILEGED_CHILD_ENV_KEYS,
  unprivilegedChildEnv,
} from '../../src/security/child-process-env.js';
import { shellTool } from '../../src/agent/tools/shell.js';

const AUTHORITY_ENV = 'HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY';
const CAPABILITY_ENV = 'HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY';

test('unprivileged child environments remove authority and operations secrets without mutating input', () => {
  const source = {
    PATH: '/usr/bin',
    KEEP: 'yes',
    [AUTHORITY_ENV]: 'authority-test-value',
    [CAPABILITY_ENV]: 'capability-test-value',
  };
  const result = unprivilegedChildEnv(source, {
    EXTRA: 'kept',
    [AUTHORITY_ENV]: 'override-must-not-restore',
  });

  assert.deepEqual(PRIVILEGED_CHILD_ENV_KEYS, [CAPABILITY_ENV, AUTHORITY_ENV]);
  assert.equal(result.KEEP, 'yes');
  assert.equal(result.EXTRA, 'kept');
  assert.equal(Object.hasOwn(result, AUTHORITY_ENV), false);
  assert.equal(Object.hasOwn(result, CAPABILITY_ENV), false);
  assert.equal(source[AUTHORITY_ENV], 'authority-test-value');
  assert.equal(source[CAPABILITY_ENV], 'capability-test-value');
});

test('model shell subprocess cannot observe privileged Home23 authority env', async (t) => {
  const previousAuthority = process.env[AUTHORITY_ENV];
  const previousCapability = process.env[CAPABILITY_ENV];
  process.env[AUTHORITY_ENV] = 'authority-test-value';
  process.env[CAPABILITY_ENV] = 'capability-test-value';
  t.after(() => {
    if (previousAuthority === undefined) delete process.env[AUTHORITY_ENV];
    else process.env[AUTHORITY_ENV] = previousAuthority;
    if (previousCapability === undefined) delete process.env[CAPABILITY_ENV];
    else process.env[CAPABILITY_ENV] = previousCapability;
  });

  const result = await shellTool.execute({
    command: `node -e "process.stdout.write(String(Boolean(process.env.${AUTHORITY_ENV} || process.env.${CAPABILITY_ENV})))"`,
  }, {
    projectRoot: process.cwd(),
    workspacePath: process.cwd(),
  } as any);

  assert.match(result.content, /STDOUT:\nfalse/);
  assert.doesNotMatch(result.content, /authority-test-value|capability-test-value/);
});

test('every model-controlled spawn uses the centralized unprivileged child environment', () => {
  const required = new Map([
    ['src/agent/tools/shell.ts', /unprivilegedChildEnv\(/],
    ['src/agent/tools/files.ts', /env:\s*unprivilegedChildEnv\(/],
    ['src/acp/bridge.ts', /env:\s*unprivilegedChildEnv\(/],
    ['src/home.ts', /env:\s*unprivilegedChildEnv\(/],
  ]);
  for (const [file, pattern] of required) {
    const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    assert.match(source, pattern, file);
  }
});
