import test from 'node:test';
import assert from 'node:assert/strict';
import { describeExecFailure } from '../../src/scheduler/exec-failure.ts';

test('an exec failure names the exit code and the script output instead of only the command line', () => {
  const err = Object.assign(new Error('Command failed: export HOME=/Users/jtr; python3 freshness.py\n'), {
    code: 1,
    stdout: '{"issues":["Last HealthKit POST was 31.2h ago (>30h)"],"details":{}}\n',
    stderr: '',
  });
  const text = describeExecFailure(err, 'export HOME=/Users/jtr; python3 freshness.py');
  assert.match(text, /exit 1/);
  assert.match(text, /Last HealthKit POST was 31\.2h ago/);
  assert.match(text, /python3 freshness\.py/);
});

test('an exec failure prefers stderr and keeps only the tail of long output', () => {
  const err = Object.assign(new Error('Command failed: run.sh'), {
    code: 2,
    stdout: 'x'.repeat(5000),
    stderr: 'Traceback (most recent call last):\n' + 'frame\n'.repeat(400) + 'KeyError: metric_date\n',
  });
  const text = describeExecFailure(err, 'run.sh');
  assert.match(text, /exit 2/);
  assert.match(text, /KeyError: metric_date/);
  assert.ok(text.length < 2500, `message should be bounded, got ${text.length}`);
});

test('a timed-out exec names the timeout and signal', () => {
  const err = Object.assign(new Error('Command failed: slow.sh'), { killed: true, signal: 'SIGTERM', code: null, stdout: '', stderr: '' });
  const text = describeExecFailure(err, 'slow.sh', 30_000);
  assert.match(text, /timed out after 30s/);
  assert.match(text, /SIGTERM/);
});

test('a non-exec error passes through unchanged', () => {
  assert.equal(describeExecFailure(new Error('spawn ENOENT'), 'x'), 'spawn ENOENT');
});
