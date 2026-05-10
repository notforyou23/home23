import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const HOME23_ROOT = process.cwd();

test('live-problems panel exposes an operator readout, not only raw verifier rows', () => {
  const js = fs.readFileSync(path.join(HOME23_ROOT, 'engine/src/dashboard/home23-dashboard.js'), 'utf8');
  const css = fs.readFileSync(path.join(HOME23_ROOT, 'engine/src/dashboard/home23-dashboard.css'), 'utf8');
  const html = fs.readFileSync(path.join(HOME23_ROOT, 'engine/src/dashboard/home23-dashboard.html'), 'utf8');

  assert.match(html, /h23-problems-overlay-panel/);
  assert.match(js, /renderProblemsOperatorSummary/);
  assert.match(js, /Operator Status/);
  assert.match(js, /Needed From You/);
  assert.match(js, /problemRepairText/);
  assert.match(js, /nothing; this issue is resolved/);
  assert.match(css, /\.h23-problems-operator/);
  assert.match(css, /\.h23-problem-operator-grid/);
});

test('Good Life issue detail shows user-facing repair context before raw JSON', () => {
  const js = fs.readFileSync(path.join(HOME23_ROOT, 'engine/src/dashboard/home23-dashboard.js'), 'utf8');
  const css = fs.readFileSync(path.join(HOME23_ROOT, 'engine/src/dashboard/home23-dashboard.css'), 'utf8');

  assert.match(js, /h23-goodlife-issue-brief/);
  assert.match(js, /What is wrong/);
  assert.match(js, /What is happening/);
  assert.match(js, /Needed from jtr/);
  assert.match(js, /Stop condition/);
  assert.match(css, /\.h23-goodlife-issue-brief/);
});
