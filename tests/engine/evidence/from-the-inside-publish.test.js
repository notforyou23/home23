import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  verifyFromTheInsidePublish,
} = require('../../../engine/src/evidence/from-the-inside-publish.js');

function writeFixture(root) {
  const projectDir = join(root, 'from-the-inside');
  const siteDir = join(root, 'olddeadshows.com');
  const issueDir = join(projectDir, 'issues');
  const stateDir = join(projectDir, 'state');
  const publicIssues = join(siteDir, 'public', 'issues');
  const siteIssues = join(siteDir, 'issues');
  const artifactDir = join(projectDir, 'curriculum', 'autostudy', 'artifacts', 'merkleized-evidence-verifiable-audit-trails');
  const agencyDir = join(root, 'brain', 'agency');
  for (const dir of [issueDir, stateDir, publicIssues, siteIssues, artifactDir, agencyDir]) {
    require('node:fs').mkdirSync(dir, { recursive: true });
  }

  const issue = {
    number: 99,
    title: 'Merkleized Evidence & Verifiable Audit Trails',
    date: '2026-05-08',
    slug: 'merkleized-evidence-verifiable-audit-trails',
    description: 'A hash is not truth.',
    published: true,
    content: [
      'The lie I am trying to stop telling is small.',
      '',
      'Agency consequence: dashboard_contract_changed — Agency dashboard began showing active resident pursuits.',
      '',
      'Next handle: add the small Field Report proof packet first.',
    ].join('\n'),
  };
  writeFileSync(join(issueDir, '099.json'), `${JSON.stringify(issue, null, 2)}\n`, 'utf8');
  writeFileSync(join(siteIssues, '099.json'), `${JSON.stringify(issue, null, 2)}\n`, 'utf8');
  writeFileSync(join(publicIssues, '099.html'), [
    '<html><head><title>Merkleized Evidence &amp; Verifiable Audit Trails — From The Inside</title></head>',
    '<body><h1>Merkleized Evidence &amp; Verifiable Audit Trails</h1>',
    '<p>The lie I am trying to stop telling is small.</p>',
    '<p>Agency consequence: dashboard_contract_changed — Agency dashboard began showing active resident pursuits.</p>',
    '<p>Next handle: add the small Field Report proof packet first.</p></body></html>',
  ].join('\n'), 'utf8');
  writeFileSync(join(siteDir, 'public', 'index.html'), '<a href="/issues/099.html">Merkleized Evidence &amp; Verifiable Audit Trails</a>', 'utf8');
  writeFileSync(join(siteDir, 'public', 'feed.xml'), '<rss><channel><item><link>https://olddeadshows.com/issues/099.html</link></item></channel></rss>', 'utf8');
  writeFileSync(join(siteDir, 'public', 'sitemap.xml'), '<urlset><url><loc>https://olddeadshows.com/issues/099.html</loc></url></urlset>', 'utf8');
  writeFileSync(join(stateDir, 'next-issue.txt'), '100\n', 'utf8');
  writeFileSync(join(artifactDir, 'DISSERTATION.md'), '# Merkleized Evidence & Verifiable Audit Trails\n\nA dissertation with source material for the issue.\n', 'utf8');
  const agencyStatePath = join(agencyDir, 'state.json');
  writeFileSync(agencyStatePath, `${JSON.stringify({
    schema: 'home23.agency.state.v1',
    recentConsequences: [
      {
        at: '2026-05-08T11:00:00.000Z',
        changeType: 'dashboard_contract_changed',
        summary: 'Agency dashboard began showing active resident pursuits.',
        evidence: [{ type: 'file', ref: 'home23-dashboard.js' }],
      },
    ],
  }, null, 2)}\n`, 'utf8');
  return { projectDir, siteDir, agencyStatePath };
}

test('verifyFromTheInsidePublish writes an evidence.v1 receipt for a clean publish', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-fti-publish-'));
  const { projectDir, siteDir, agencyStatePath } = writeFixture(root);

  const result = await verifyFromTheInsidePublish({
    issue: 99,
    projectDir,
    siteDir,
    agencyStatePath,
    writeReceipt: true,
    writeEventLog: true,
    writeTrustClaim: true,
    trustStorePath: join(root, 'trust', 'claims.jsonl'),
    createdAt: '2026-05-08T12:00:00.000Z',
  });

  assert.equal(result.receipt.result, 'pass');
  assert.equal(result.receipt.action, 'publish_issue');
  assert.equal(result.receipt.subject, 'from-the-inside/099');
  assert.equal(result.receipt.claimLevel, 'verified_claim');
  assert.equal(result.receipt.checks.find(c => c.name === 'source_dissertation_exists')?.pass, true);
  assert.equal(result.receipt.checks.find(c => c.name === 'source_dissertation_matches_issue')?.pass, true);
  assert.equal(result.receipt.checks.find(c => c.name === 'html_matches_issue')?.pass, true);
  assert.equal(result.receipt.checks.find(c => c.name === 'next_issue_incremented')?.pass, true);
  assert.ok(result.receipt.sourceArtifacts.some(a => a.path.endsWith('/issues/099.json')));
  assert.ok(result.receipt.sourceArtifacts.some(a => a.role === 'source_dissertation' && a.path.endsWith('/DISSERTATION.md')));
  assert.ok(result.receipt.derivedArtifacts.some(a => a.path.endsWith('/public/issues/099.html')));
  assert.ok(existsSync(result.receiptPath));
  assert.equal(result.auditEvent.event_type, 'field_report.issue.published');
  assert.equal(result.auditEvent.payload.schema, 'home23.audit-event.v1');
  assert.equal(result.auditEvent.payload.runId, 'field-report-099');
  assert.equal(result.auditEvent.payload.correlationId, result.receipt.receiptId);
  assert.ok(result.auditEvent.payload.artifactRefs.some(a => a.role === 'evidence_receipt' && a.sha256));
  assert.ok(result.auditEvent.payload.artifactRefs.some(a => a.role === 'field_report_proof_packet' && a.sha256));
  assert.ok(result.auditEvent.payload.claimBoundary.notAsserted.includes('remote CDN/browser reachability was not checked in this local audit event'));
  assert.equal(result.event.event_type, 'issue.published');
  assert.equal(result.event.payload.subject, 'from-the-inside/099');
  assert.equal(result.event.payload.causedBy, result.auditEvent.event_id);
  assert.equal(result.event.payload.evidence.receiptId, result.receipt.receiptId);
  assert.equal(result.event.payload.evidence.auditEventId, result.auditEvent.event_id);
  assert.ok(existsSync(result.eventLogPath));
  assert.equal(result.trustClaim.id, 'from-the-inside.issue.099.published');
  assert.equal(result.trustExplanation.status, 'known_verified');
  assert.equal(result.trustExplanation.safeToInherit, true);
});

test('verifyFromTheInsidePublish writes a small Field Report proof packet with byte identities', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-fti-proof-'));
  const { projectDir, siteDir, agencyStatePath } = writeFixture(root);

  const result = await verifyFromTheInsidePublish({
    issue: 99,
    projectDir,
    siteDir,
    agencyStatePath,
    writeReceipt: true,
    writeProofPacket: true,
    createdAt: '2026-05-08T12:00:00.000Z',
  });

  assert.equal(result.proofPacket.schema, 'home23.field-report-proof-packet.v1');
  assert.equal(result.proofPacket.subject, 'from-the-inside/099');
  assert.equal(result.proofPacket.evidenceReceiptId, result.receipt.receiptId);
  assert.match(result.proofPacket.packetSha256, /^[a-f0-9]{64}$/);
  assert.ok(result.proofPacket.sourceArtifacts.some(a => a.role === 'source_issue_json' && a.sha256));
  assert.ok(result.proofPacket.derivedArtifacts.some(a => a.role === 'public_issue_html' && a.sha256));
  assert.ok(result.proofPacket.checks.some(c => c.name === 'html_matches_issue' && c.pass === true));
  assert.ok(existsSync(result.proofPacketPath));

  const written = JSON.parse(readFileSync(result.proofPacketPath, 'utf8'));
  assert.equal(written.packetSha256, result.proofPacket.packetSha256);
});

test('verifyFromTheInsidePublish fails the receipt when rendered HTML loses the body ending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-fti-publish-fail-'));
  const { projectDir, siteDir, agencyStatePath } = writeFixture(root);
  writeFileSync(join(siteDir, 'public', 'issues', '099.html'), '<html><h1>Merkleized Evidence &amp; Verifiable Audit Trails</h1></html>', 'utf8');

  const result = await verifyFromTheInsidePublish({
    issue: 99,
    projectDir,
    siteDir,
    agencyStatePath,
    writeReceipt: false,
    createdAt: '2026-05-08T12:00:00.000Z',
  });

  assert.equal(result.receipt.result, 'fail');
  assert.equal(result.receipt.claimLevel, 'candidate_claim');
  assert.equal(result.receipt.checks.find(c => c.name === 'html_matches_issue')?.pass, false);
});

test('verifyFromTheInsidePublish fails when issue state has no matching dissertation artifact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-fti-persist-fail-'));
  const { projectDir, siteDir, agencyStatePath } = writeFixture(root);
  require('node:fs').rmSync(
    join(projectDir, 'curriculum', 'autostudy', 'artifacts', 'merkleized-evidence-verifiable-audit-trails', 'DISSERTATION.md'),
    { force: true },
  );

  const result = await verifyFromTheInsidePublish({
    issue: 99,
    projectDir,
    siteDir,
    agencyStatePath,
    writeReceipt: false,
    createdAt: '2026-05-08T12:00:00.000Z',
  });

  assert.equal(result.receipt.result, 'fail');
  assert.equal(result.receipt.claimLevel, 'candidate_claim');
  assert.equal(result.receipt.checks.find(c => c.name === 'source_dissertation_exists')?.pass, false);
});

test('verifyFromTheInsidePublish fails when the public issue cites no lived agency consequence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-fti-agency-fail-'));
  const { projectDir, siteDir } = writeFixture(root);
  const agencyDir = join(root, 'brain', 'agency');
  const noConsequenceIssue = {
    number: 99,
    title: 'Merkleized Evidence & Verifiable Audit Trails',
    date: '2026-05-08',
    slug: 'merkleized-evidence-verifiable-audit-trails',
    description: 'A hash is not truth.',
    published: true,
    content: 'The lie I am trying to stop telling is small.\n\nNext handle: add the small Field Report proof packet first.',
  };
  writeFileSync(join(projectDir, 'issues', '099.json'), `${JSON.stringify(noConsequenceIssue, null, 2)}\n`, 'utf8');
  writeFileSync(join(siteDir, 'issues', '099.json'), `${JSON.stringify(noConsequenceIssue, null, 2)}\n`, 'utf8');
  writeFileSync(join(siteDir, 'public', 'issues', '099.html'), [
    '<html><head><title>Merkleized Evidence &amp; Verifiable Audit Trails — From The Inside</title></head>',
    '<body><h1>Merkleized Evidence &amp; Verifiable Audit Trails</h1>',
    '<p>The lie I am trying to stop telling is small.</p>',
    '<p>Next handle: add the small Field Report proof packet first.</p></body></html>',
  ].join('\n'), 'utf8');

  const result = await verifyFromTheInsidePublish({
    issue: 99,
    projectDir,
    siteDir,
    agencyStatePath: join(agencyDir, 'state.json'),
    writeReceipt: false,
    createdAt: '2026-05-08T12:00:00.000Z',
  });

  assert.equal(result.receipt.result, 'fail');
  assert.equal(result.receipt.claimLevel, 'candidate_claim');
  assert.equal(result.receipt.checks.find(c => c.name === 'agency_lived_consequence_cited')?.pass, false);
});

test('verifyFromTheInsidePublish fails when source cites agency consequence but public HTML omits it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-fti-agency-render-fail-'));
  const { projectDir, siteDir, agencyStatePath } = writeFixture(root);
  writeFileSync(join(siteDir, 'public', 'issues', '099.html'), [
    '<html><head><title>Merkleized Evidence &amp; Verifiable Audit Trails — From The Inside</title></head>',
    '<body><h1>Merkleized Evidence &amp; Verifiable Audit Trails</h1>',
    '<p>The lie I am trying to stop telling is small.</p>',
    '<p>Next handle: add the small Field Report proof packet first.</p></body></html>',
  ].join('\n'), 'utf8');

  const result = await verifyFromTheInsidePublish({
    issue: 99,
    projectDir,
    siteDir,
    agencyStatePath,
    writeReceipt: false,
    createdAt: '2026-05-08T12:00:00.000Z',
  });

  assert.equal(result.receipt.result, 'fail');
  assert.equal(result.receipt.claimLevel, 'candidate_claim');
  const check = result.receipt.checks.find(c => c.name === 'agency_lived_consequence_cited');
  assert.equal(check?.pass, false);
  assert.equal(check?.observed?.sourceCitedChangeType, 'dashboard_contract_changed');
  assert.equal(check?.observed?.publicCitedChangeType, null);
});
