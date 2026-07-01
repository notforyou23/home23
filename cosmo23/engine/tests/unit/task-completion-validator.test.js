const { expect } = require('chai');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { validateExpectedOutputFile } = require('../../src/core/task-completion-validator');

describe('task-completion-validator', () => {
  it('rejects Archive comment artifacts that resolve placeholder identifiers', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-task-validator-'));
    const filePath = path.join(tempDir, 'archive-org-comments.json');
    await fs.writeFile(filePath, JSON.stringify({
      status: 'no_reviews_found',
      required_identifiers: ['-'],
      identifier_statuses: [{
        identifier: '-',
        status: 'no_reviews_found',
        metadata_route: 'accepted',
        review_route: 'accepted',
        source_url: 'https://archive.org/details/-'
      }],
      entries: [],
      urls_searched: ['https://archive.org/details/-'],
      route_receipts: {
        attempts: [
          { route: 'archive.metadata', status: 'accepted' },
          { route: 'archive.reviews', status: 'accepted' }
        ]
      }
    }, null, 2));

    const validation = await validateExpectedOutputFile(filePath);

    expect(validation.passed).to.equal(false);
    expect(validation.reason).to.equal('archive_invalid_required_identifier:-');
  });

  it('rejects final research markdown that omits explicitly requested route and next-source sections', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-task-validator-md-missing-'));
    const filePath = path.join(tempDir, 'jerry-side-project-anecdotes.md');
    await fs.writeFile(filePath, [
      '# Jerry Garcia Side-Project Anecdotes',
      '',
      '## Confirmed extracted anecdotes / listener-review evidence',
      '',
      'Evidence from Archive.org and secondary source pages is summarized here.',
      '',
      '## Negative receipts',
      '',
      'Two Archive.org identifiers had accepted no-review receipts.'
    ].join('\n'));

    const validation = await validateExpectedOutputFile(
      filePath,
      { label: '@outputs/jerry-side-project-anecdotes.md' },
      {
        task: {
          description: 'Write a concise evidence-backed markdown report with: confirmed extracted anecdotes, negative receipts, useful source routes, failed/empty routes, and next source families to pursue.'
        }
      }
    );

    expect(validation.passed).to.equal(false);
    expect(validation.reason).to.equal('markdown_missing_required_sections:useful source routes,failed/empty routes,next source families');
  });

  it('accepts final research markdown that includes all explicitly requested report sections', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-task-validator-md-complete-'));
    const filePath = path.join(tempDir, 'jerry-side-project-anecdotes.md');
    await fs.writeFile(filePath, [
      '# Jerry Garcia Side-Project Anecdotes',
      '',
      '## Confirmed extracted anecdotes / listener-review evidence',
      '',
      'Evidence from Archive.org and secondary source pages is summarized here with source URLs and hashes.',
      '',
      '## Negative receipts',
      '',
      'Archive.org no-review receipts are listed here.',
      '',
      '## Useful source routes',
      '',
      'archive.reviews and direct-source-fetch produced usable evidence.',
      '',
      '## Failed/empty routes',
      '',
      'web.search and local-search returned empty or irrelevant results.',
      '',
      '## Next source families',
      '',
      'Forum, Dead.net, Reddit, and JerryBase-linked notes should be pursued next.'
    ].join('\n'));

    const validation = await validateExpectedOutputFile(
      filePath,
      { label: '@outputs/jerry-side-project-anecdotes.md' },
      {
        task: {
          description: 'Write a concise evidence-backed markdown report with: confirmed extracted anecdotes, negative receipts, useful source routes, failed/empty routes, and next source families to pursue.'
        }
      }
    );

    expect(validation.passed).to.equal(true);
  });
});
