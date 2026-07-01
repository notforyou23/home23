const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  summarizeRunArtifacts,
  buildArtifactFirstContext
} = require('./run-artifact-inventory');

function withTempRun(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-run-artifacts-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('summarizeRunArtifacts distinguishes extracted records from query exports', () => withTempRun((runPath) => {
  fs.mkdirSync(path.join(runPath, 'outputs', 'extracted'), { recursive: true });
  fs.mkdirSync(path.join(runPath, 'outputs', 'raw-anecdotes'), { recursive: true });
  fs.mkdirSync(path.join(runPath, 'exports', 'markdown'), { recursive: true });
  fs.mkdirSync(path.join(runPath, 'kv'), { recursive: true });

  fs.writeFileSync(
    path.join(runPath, 'outputs', 'extracted', 'archive-comments.json'),
    JSON.stringify({
      entries: [
        { source_url: 'https://archive.org/details/show-1', quote: 'Fan memory one.' },
        { source_url: 'https://archive.org/details/show-2', quote: 'Fan memory two.' }
      ]
    })
  );
  fs.writeFileSync(
    path.join(runPath, 'outputs', 'raw-anecdotes', 'archive-org-comments.json'),
    JSON.stringify({
      entries: [{ source_url: 'https://archive.org/details/show-1', text: 'raw record' }]
    })
  );
  fs.writeFileSync(
    path.join(runPath, 'kv', 'research_source_index.json'),
    JSON.stringify({ key: 'research_source_index', value: { urls: ['https://archive.org/details/show-1'] } })
  );
  fs.writeFileSync(path.join(runPath, 'exports', 'markdown', 'query.md'), '# Query\n\nA previous query answer.');

  const inventory = summarizeRunArtifacts(runPath);

  assert.equal(inventory.exists, true);
  assert.equal(inventory.answerSubstrate, 'records_present');
  assert.equal(inventory.categories.extractedRecords.records, 2);
  assert.equal(inventory.categories.rawAnecdotes.records, 1);
  assert.equal(inventory.categories.queryExports.files, 1);
  assert.equal(inventory.sourceEvidence.sourceIndexUrls, 1);
  assert.equal(inventory.warnings.includes('source_urls_missing'), false);

  const context = buildArtifactFirstContext(inventory);
  assert.match(context, /Answer substrate: records_present/);
  assert.match(context, /Raw anecdote files\/records: 1\/1/);
}));

test('summarizeRunArtifacts surfaces invalid JSON and meta-only runs', () => withTempRun((runPath) => {
  fs.mkdirSync(path.join(runPath, 'exports', 'markdown'), { recursive: true });
  fs.mkdirSync(path.join(runPath, 'outputs', 'research', 'agent_1'), { recursive: true });
  fs.writeFileSync(path.join(runPath, 'exports', 'markdown', 'query.md'), '# Query\n\nLooks researched.');
  fs.writeFileSync(path.join(runPath, 'outputs', 'research', 'agent_1', 'research_summary.md'), '# Summary\n\nNeeds extraction.');
  fs.writeFileSync(path.join(runPath, 'outputs', 'research', 'agent_1', 'research_findings.json'), '{"entries":[}\n');

  const inventory = summarizeRunArtifacts(runPath);

  assert.equal(inventory.answerSubstrate, 'meta_only');
  assert.equal(inventory.totals.invalidJsonFiles, 1);
  assert.equal(inventory.warnings.includes('invalid_json_artifacts_present'), true);
  assert.equal(inventory.warnings.includes('raw_anecdotes_missing'), true);
  assert.equal(inventory.warnings.includes('source_route_receipts_missing'), true);
}));

test('summarizeRunArtifacts fingerprint changes when artifact content changes', () => withTempRun((runPath) => {
  fs.mkdirSync(path.join(runPath, 'outputs', 'raw-anecdotes'), { recursive: true });
  const artifactPath = path.join(runPath, 'outputs', 'raw-anecdotes', 'archive-org-comments.json');

  fs.writeFileSync(
    artifactPath,
    JSON.stringify({ entries: [{ source_url: 'https://archive.org/details/show', text: 'first account' }] })
  );
  const first = summarizeRunArtifacts(runPath);

  fs.writeFileSync(
    artifactPath,
    JSON.stringify({ entries: [{ source_url: 'https://archive.org/details/show', text: 'second account' }] })
  );
  const second = summarizeRunArtifacts(runPath);

  assert.equal(first.categories.rawAnecdotes.records, 1);
  assert.equal(second.categories.rawAnecdotes.records, 1);
  assert.notEqual(first.fingerprint, second.fingerprint);
}));

test('buildArtifactFirstContext includes exact structured anecdote artifacts', () => withTempRun((runPath) => {
  fs.mkdirSync(path.join(runPath, 'outputs', 'raw-anecdotes'), { recursive: true });
  fs.writeFileSync(
    path.join(runPath, 'outputs', 'raw-anecdotes', 'archive-org-comments.json'),
    JSON.stringify({
      status: 'records_extracted',
      entries: [
        {
          identifier: 'oaitw1998-06-18.sbd.16441.untouched',
          reviewer: 'Jbart02s',
          created_at: '2021-12-22 17:55:31',
          review_body: 'High Lonesome Sound and Midnight Moonlight setlist note.',
          route: 'archive.reviews',
          source_url: 'https://archive.org/details/oaitw1998-06-18.sbd.16441.untouched#reviews'
        },
        {
          identifier: 'oaitw1998-06-18.sbd.16441.untouched',
          reviewer: 'Fennario Spring',
          created_at: '2025-04-13 08:51:13',
          review_body: 'such a stellar reunion',
          route: 'archive.reviews',
          source_url: 'https://archive.org/details/oaitw1998-06-18.sbd.16441.untouched#reviews'
        }
      ],
      identifier_statuses: [
        {
          identifier: 'lom-1974-11-28.sbd',
          status: 'no_reviews_found',
          review_count_reported: 0,
          metadata_route: 'accepted',
          review_route: 'accepted',
          source_url: 'https://archive.org/details/lom-1974-11-28.sbd'
        },
        {
          identifier: 'oaitw1998-06-18.sbd.16441.untouched',
          status: 'reviews_extracted',
          review_count_reported: 2,
          metadata_route: 'accepted',
          review_route: 'accepted',
          source_url: 'https://archive.org/details/oaitw1998-06-18.sbd.16441.untouched'
        }
      ],
      route_receipts: {
        attempts: [
          { route: 'archive.metadata', status: 'accepted' },
          { route: 'archive.reviews', status: 'accepted' },
          { route: 'local-search', status: 'failed', code: 'LOW_QUALITY_SEARCH_RESULTS' }
        ],
        failed_routes: ['local-search']
      }
    })
  );
  fs.writeFileSync(
    path.join(runPath, 'outputs', 'raw-anecdotes', 'forum-social-candidates.json'),
    JSON.stringify({
      status: 'candidates_found',
      candidates: [
        {
          project: 'Legion of Mary',
          date_show_reference: 'May 13, 1975',
          source_type: 'blog_review',
          route: 'direct-source-fetch',
          confidence: 0.95,
          source_url: 'https://lostlivedead.blogspot.com/2009/12/may-13-1975-keystone-berkeley-lucky.html',
          excerpt: 'Lost Live Dead discusses Lucky Strike billing and leans toward a May 13 date.'
        }
      ],
      route_receipts: {
        attempts: [
          { route: 'direct-source-fetch', status: 'accepted' },
          { route: 'web.search', status: 'rejected' },
          { route: 'commoncrawl.cdx', status: 'failed', error: 'HTTP 404' }
        ],
        failed_routes: ['web.search', 'commoncrawl.cdx']
      }
    })
  );
  fs.writeFileSync(
    path.join(runPath, 'outputs', 'jerry-side-project-anecdotes.md'),
    '# Jerry Garcia Side-Project Anecdotes: Evidence Report\n\n## Confirmed extracted anecdotes\n\n## Failed or empty routes\n'
  );

  const inventory = summarizeRunArtifacts(runPath);
  const context = buildArtifactFirstContext(inventory);

  assert.equal(inventory.artifactDetails.rawAnecdotes.length, 2);
  assert.match(context, /Structured raw artifact truth/);
  assert.match(context, /archive-org-comments\.json: status=records_extracted, entries=2, candidates=0/);
  assert.match(context, /forum-social-candidates\.json: status=candidates_found, entries=0, candidates=1/);
  assert.match(context, /project=Legion of Mary/);
  assert.match(context, /failedRoutes=web\.search, commoncrawl\.cdx/);
  assert.match(context, /reviews=0/);
  assert.match(context, /Markdown report truth/);
  assert.match(context, /## Confirmed extracted anecdotes/);
}));
