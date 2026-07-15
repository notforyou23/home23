'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  redactPrivatePaths,
  serializeProviderRecord,
} = require('../../cosmo23/lib/provider-record-sanitizer');

test('path redaction covers POSIX, file URI, Windows drive, and UNC paths without partial leaks', () => {
  const input = [
    '/opt/home23/brain/source.json',
    '/mnt/private/cache.bin',
    '/etc/home23/secrets.yaml',
    '/Volumes/PrivateBrain/run/result.json',
    'file:///Volumes/PrivateBrain/run/receipt.json',
    String.raw`D:\Brains\Jerry\memory.jsonl`,
    String.raw`\\nas01\brains\Jerry\manifest.json`,
  ].join(' | ');

  const redacted = redactPrivatePaths(input);

  for (const leaked of ['/opt/', '/mnt/', '/etc/', '/Volumes/', 'file://', 'D:\\', '\\\\nas01']) {
    assert.equal(redacted.includes(leaked), false, `leaked ${leaked}`);
  }
  assert.match(redacted, /\[redacted-path\]\/source\.json/);
  assert.match(redacted, /\[redacted-path\]\/manifest\.json/);
});

test('provider record serialization applies path redaction recursively', () => {
  const serialized = serializeProviderRecord({
    sourceChain: [
      { kind: 'source', ref: '/Volumes/PrivateBrain/current/source.json' },
      { kind: 'evidence', ref: String.raw`E:\Home23\receipts\proof.json` },
    ],
  }, { maxBytes: 4096, redactPaths: true });

  assert.doesNotMatch(serialized.json, /\/Volumes\/|E:\\Home23/);
  assert.match(serialized.json, /redacted-path/);
});

test('path redaction preserves URLs and typed evidence refs without re-redacting placeholders', () => {
  const input = [
    'https://example.com/evidence/receipt.json',
    'http://localhost:5002/api/state',
    'incident:/brain-route',
    'source:/manifest-v1',
    'local=/opt/home23/private/receipt.json',
    'file:///etc/home23/secrets.yaml',
  ].join(' | ');

  const redacted = redactPrivatePaths(input);

  assert.match(redacted, /https:\/\/example\.com\/evidence\/receipt\.json/);
  assert.match(redacted, /http:\/\/localhost:5002\/api\/state/);
  assert.match(redacted, /incident:\/brain-route/);
  assert.match(redacted, /source:\/manifest-v1/);
  assert.doesNotMatch(redacted, /\/opt\/|file:\/\/|\/etc\//);
  assert.equal((redacted.match(/\[redacted-path\]/g) || []).length, 2);
});

test('path redaction removes typed absolute local refs but preserves non-file typed refs', () => {
  const input = [
    'artifact:/Users/jtr/private/receipt.json',
    'source:/Volumes/PrivateBrain/current/manifest.json',
    'https://example.com/evidence/receipt.json',
    'incident:/brain-route',
    'source:/manifest-v1',
  ].join(' | ');

  const redacted = redactPrivatePaths(input);

  assert.doesNotMatch(redacted, /\/Users\/|\/Volumes\//);
  assert.match(redacted, /artifact:\[redacted-path\]\/receipt\.json/);
  assert.match(redacted, /source:\[redacted-path\]\/manifest\.json/);
  assert.match(redacted, /https:\/\/example\.com\/evidence\/receipt\.json/);
  assert.match(redacted, /incident:\/brain-route/);
  assert.match(redacted, /source:\/manifest-v1/);
});

test('path redaction preserves multi-segment semantic refs and protocol-relative URLs exactly', () => {
  const preserved = [
    'incident:/brain/route',
    'incident:/var/outage',
    'goal:/home23/current',
    'goal:/home/recovery',
    'node:/x/y',
    'node:/Users/incident/one',
    'source:/manifest/v1',
    '//example.com/a/b',
  ];

  for (const reference of preserved) {
    assert.equal(redactPrivatePaths(reference), reference);
  }
  assert.equal(
    redactPrivatePaths('source:/Volumes/PrivateBrain/current/manifest.json'),
    'source:[redacted-path]/manifest.json',
  );
  assert.equal(
    redactPrivatePaths('source:/data/private/secret.json'),
    'source:[redacted-path]/secret.json',
  );
  assert.equal(
    redactPrivatePaths('artifact:/data/private.log'),
    'artifact:[redacted-path]/private.log',
  );
  assert.equal(
    redactPrivatePaths('unknown:/custom-root/private/secret.json'),
    'unknown:[redacted-path]/secret.json',
  );
});

test('path redaction removes every file URI slash and authority form', () => {
  const variants = [
    'file:/secret',
    'FILE:/secret',
    'file://nas/share/secret.json',
    'FILE://NAS/share/secret.json',
    'file:///var/tmp/private.log',
    'file://localhost/var/tmp/private.log',
  ];

  for (const variant of variants) {
    const redacted = redactPrivatePaths(variant);
    assert.doesNotMatch(redacted, /file:|nas|localhost|\/var\/tmp/iu);
    assert.match(redacted, /^\[redacted-path\]\/(?:secret|secret\.json|private\.log)$/u);
  }
  assert.equal(redactPrivatePaths('//example.com/a/b'), '//example.com/a/b');
});
