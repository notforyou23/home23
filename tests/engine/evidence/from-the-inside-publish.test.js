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
  for (const dir of [issueDir, stateDir, publicIssues, siteIssues]) {
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
      'Next handle: add the small Field Report proof packet first.',
    ].join('\n'),
  };
  writeFileSync(join(issueDir, '099.json'), `${JSON.stringify(issue, null, 2)}\n`, 'utf8');
  writeFileSync(join(siteIssues, '099.json'), `${JSON.stringify(issue, null, 2)}\n`, 'utf8');
  writeFileSync(join(publicIssues, '099.html'), [
    '<html><head><title>Merkleized Evidence &amp; Verifiable Audit Trails — From The Inside</title></head>',
    '<body><h1>Merkleized Evidence &amp; Verifiable Audit Trails</h1>',
    '<p>The lie I am trying to stop telling is small.</p>',
    '<p>Next handle: add the small Field Report proof packet first.</p></body></html>',
  ].join('\n'), 'utf8');
  writeFileSync(join(siteDir, 'public', 'index.html'), '<a href="/issues/099.html">Merkleized Evidence &amp; Verifiable Audit Trails</a>', 'utf8');
  writeFileSync(join(siteDir, 'public', 'feed.xml'), '<rss><channel><item><link>https://olddeadshows.com/issues/099.html</link></item></channel></rss>', 'utf8');
  writeFileSync(join(siteDir, 'public', 'sitemap.xml'), '<urlset><url><loc>https://olddeadshows.com/issues/099.html</loc></url></urlset>', 'utf8');
  writeFileSync(join(stateDir, 'next-issue.txt'), '100\n', 'utf8');
  return { projectDir, siteDir };
}

test('verifyFromTheInsidePublish writes an evidence.v1 receipt for a clean publish', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-fti-publish-'));
  const { projectDir, siteDir } = writeFixture(root);

  const result = await verifyFromTheInsidePublish({
    issue: 99,
    projectDir,
    siteDir,
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
  assert.equal(result.receipt.checks.find(c => c.name === 'html_matches_issue')?.pass, true);
  assert.equal(result.receipt.checks.find(c => c.name === 'next_issue_incremented')?.pass, true);
  assert.ok(result.receipt.sourceArtifacts.some(a => a.path.endsWith('/issues/099.json')));
  assert.ok(result.receipt.derivedArtifacts.some(a => a.path.endsWith('/public/issues/099.html')));
  assert.ok(existsSync(result.receiptPath));
  assert.equal(result.event.event_type, 'issue.published');
  assert.equal(result.event.payload.subject, 'from-the-inside/099');
  assert.equal(result.event.payload.evidence.receiptId, result.receipt.receiptId);
  assert.ok(existsSync(result.eventLogPath));
  assert.equal(result.trustClaim.id, 'from-the-inside.issue.099.published');
  assert.equal(result.trustExplanation.status, 'known_verified');
  assert.equal(result.trustExplanation.safeToInherit, true);
});

test('verifyFromTheInsidePublish writes a small Field Report proof packet with byte identities', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-fti-proof-'));
  const { projectDir, siteDir } = writeFixture(root);

  const result = await verifyFromTheInsidePublish({
    issue: 99,
    projectDir,
    siteDir,
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
  const { projectDir, siteDir } = writeFixture(root);
  writeFileSync(join(siteDir, 'public', 'issues', '099.html'), '<html><h1>Merkleized Evidence &amp; Verifiable Audit Trails</h1></html>', 'utf8');

  const result = await verifyFromTheInsidePublish({
    issue: 99,
    projectDir,
    siteDir,
    writeReceipt: false,
    createdAt: '2026-05-08T12:00:00.000Z',
  });

  assert.equal(result.receipt.result, 'fail');
  assert.equal(result.receipt.claimLevel, 'candidate_claim');
  assert.equal(result.receipt.checks.find(c => c.name === 'html_matches_issue')?.pass, false);
});
