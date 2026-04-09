const { expect } = require('chai');

const { IntrospectionModule } = require('../../src/system/introspection');

describe('IntrospectionModule structured previews', () => {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };

  it('summarizes json outputs instead of skipping them', () => {
    const module = new IntrospectionModule(
      { introspection: { enabled: true, maxPreviewLength: 500 } },
      logger,
      null,
      null
    );

    const preview = module.createStructuredPreview(
      '/tmp/research_findings.json',
      JSON.stringify({
        summary: 'Key summary',
        findings: ['Finding A', 'Finding B'],
        metadata: { sourcesFound: 4 }
      })
    );

    expect(preview).to.include('summary=Key summary');
    expect(preview).to.include('sourcesFound=4');
  });

  it('summarizes jsonl outputs line by line', () => {
    const module = new IntrospectionModule(
      { introspection: { enabled: true, maxPreviewLength: 500 } },
      logger,
      null,
      null
    );

    const preview = module.createStructuredPreview(
      '/tmp/findings.jsonl',
      [
        JSON.stringify({ type: 'finding', content: 'First finding' }),
        JSON.stringify({ type: 'finding', content: 'Second finding' })
      ].join('\n')
    );

    expect(preview).to.include('type=finding');
    expect(preview).to.include('content=First finding');
  });
});
