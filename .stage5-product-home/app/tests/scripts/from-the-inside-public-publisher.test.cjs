const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const SCRIPT = join(__dirname, '..', '..', 'instances', 'jerry', 'projects', 'from-the-inside', 'bin', 'publish-public-issue.py');

function writeFixture({ citeAgency = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'home23-fti-public-publish-'));
  const projectDir = join(root, 'from-the-inside');
  const siteDir = join(root, 'olddeadshows.com');
  const issueDir = join(projectDir, 'issues');
  const agencyDir = join(root, 'brain', 'agency');
  for (const dir of [
    issueDir,
    agencyDir,
    join(siteDir, 'issues'),
    join(siteDir, 'public', 'issues'),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(siteDir, 'public', 'index.html'), [
    '<html><body>',
    '  <article>',
    '    <h2>Existing issue</h2>',
    '  </article>',
    '</body></html>',
  ].join('\n'), 'utf8');
  writeFileSync(join(siteDir, 'public', 'feed.xml'), '<rss><channel>\n</channel></rss>\n', 'utf8');
  writeFileSync(join(siteDir, 'public', 'sitemap.xml'), '<urlset></urlset>\n', 'utf8');
  const consequenceLine = 'Agency consequence: dashboard_contract_changed - Agency dashboard began showing active resident pursuits.';
  const issue = {
    number: 998,
    title: 'Agency Gate Test',
    date: '2026-05-25',
    slug: 'agency-gate-test',
    description: 'A test issue for agency-gated publishing.',
    published: true,
    content: [
      'This issue should only publish when resident agency actually changed.',
      '',
      citeAgency ? consequenceLine : 'This issue has no lived agency consequence.',
      '',
      'Next handle: keep public artifacts downstream of resident consequence.',
    ].join('\n'),
  };
  writeFileSync(join(issueDir, '998.json'), `${JSON.stringify(issue, null, 2)}\n`, 'utf8');
  const agencyStatePath = join(agencyDir, 'state.json');
  writeFileSync(agencyStatePath, `${JSON.stringify({
    schema: 'home23.agency.state.v1',
    recentConsequences: [{
      at: '2026-05-25T17:00:00.000Z',
      changeType: 'dashboard_contract_changed',
      summary: 'Agency dashboard began showing active resident pursuits.',
      evidence: [{ type: 'file', ref: 'home23-dashboard.js' }],
    }],
  }, null, 2)}\n`, 'utf8');
  return { root, projectDir, siteDir, agencyStatePath };
}

function runPublisher(fixture, args) {
  return spawnSync('python3', [SCRIPT, ...args], {
    cwd: join(__dirname, '..', '..'),
    env: {
      ...process.env,
      HOME23_REPO_DIR: join(__dirname, '..', '..'),
      FROM_THE_INSIDE_PROJECT_DIR: fixture.projectDir,
      OLDDEADSHOWS_SITE_DIR: fixture.siteDir,
      HOME23_AGENCY_STATE_PATH: fixture.agencyStatePath,
    },
    encoding: 'utf8',
  });
}

test('publish-public-issue dry-run accepts an issue that cites a resident agency consequence', () => {
  const fixture = writeFixture({ citeAgency: true });
  const result = runPublisher(fixture, ['998']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /agency consequence preflight passed/i);
  assert.match(result.stdout, /dry-run XML checks passed/);
});

test('publish-public-issue vetoes public writes before apply when no agency consequence is cited', () => {
  const fixture = writeFixture({ citeAgency: false });
  const result = runPublisher(fixture, ['998', '--apply']);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /agency consequence preflight failed/i);
  assert.equal(existsSync(join(fixture.siteDir, 'public', 'issues', '998.html')), false);
  assert.equal(existsSync(join(fixture.siteDir, 'issues', '998.json')), false);
  assert.doesNotMatch(readFileSync(join(fixture.siteDir, 'public', 'index.html'), 'utf8'), /Agency Gate Test/);
});
