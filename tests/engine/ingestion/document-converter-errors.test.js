import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyVisionError, classifyPythonProviderError } = require('../../../engine/src/ingestion/vision-ocr');
const { isConverterFaultQuarantine } = require('../../../engine/src/ingestion/document-converter');

// A provider, credential or model problem is configuration and must never
// pin a file as conversion_failed; only an error about the file itself may.

test('vision call errors: configuration, transient, or the file itself', () => {
  const cases = [
    [{ status: 404, message: "404 The model `MiniMax-M3` does not exist or you do not have access to it." }, 'misconfigured'],
    [{ status: 401, message: 'Incorrect API key provided' }, 'misconfigured'],
    [{ status: 403, message: 'Project does not have access to model' }, 'misconfigured'],
    [new Error('OpenAI Codex 400: {"detail":"The \'grok-4.5\' model is not supported when using Codex with a ChatGPT account."}'), 'misconfigured'],
    [new Error('No OpenAI Codex OAuth token configured. Refusing to use OPENAI_API_KEY for openai-codex.'), 'misconfigured'],
    [{ status: 400, message: 'This model does not support image input' }, 'misconfigured'],
    [{ status: 429, message: 'Rate limit reached for requests' }, 'transient'],
    [{ status: 529, message: 'Overloaded' }, 'transient'],
    [new Error('Connection error.'), 'transient'],
    [new Error('Request timed out.'), 'transient'],
    [{ status: 400, message: 'Invalid image: the file could not be decoded' }, 'file'],
    [{ status: 400, message: 'Could not process image' }, 'file'],
    [{ status: 400, message: 'something unexpected' }, 'misconfigured'],
  ];
  for (const [err, expected] of cases) {
    assert.equal(classifyVisionError(err), expected, String(err.message));
  }
});

test('python tracebacks: provider errors by class and SDK code, not by line numbers', () => {
  assert.equal(classifyPythonProviderError(
    "openai.NotFoundError: Error code: 404 - {'error': {'message': 'The model `MiniMax-M3` does not exist or you do not have access to it.', 'type': 'invalid_request_error', 'param': None, 'code': 'model_not_found'}}",
  ), 'misconfigured');
  assert.equal(classifyPythonProviderError(
    "openai.AuthenticationError: Error code: 401 - {'error': {'code': 'invalid_api_key'}}",
  ), 'misconfigured');
  assert.equal(classifyPythonProviderError("openai.RateLimitError: Error code: 429 - {'error': {}}"), 'transient');
  // A genuinely broken PDF: frames carry line numbers such as 404 and 401.
  assert.equal(classifyPythonProviderError([
    'Traceback (most recent call last):',
    '  File "/venv/lib/python3.12/site-packages/pdfminer/psparser.py", line 404, in nexttoken',
    '  File "/venv/lib/python3.12/site-packages/pdfminer/pdfparser.py", line 401, in do_keyword',
    'pdfminer.pdfparser.PDFSyntaxError: No /Root object! - Is this really a PDF?',
  ].join('\n')), null);
});

test('only converter-fault quarantines are released for re-evaluation', () => {
  const failed = (issue) => ({ parseStatus: 'conversion_failed', issues: [issue], quarantinedAt: 'x', nodeIds: [] });

  // Forrest: 234 PNGs sent to OpenAI with MiniMax-M3.
  assert.equal(isConverterFaultQuarantine('/w/shot.png', failed(
    "…openai.NotFoundError: Error code: 404 - {'error': {'code': 'model_not_found'}}",
  )), true);
  // Images without any vision client produced empty text.
  assert.equal(isConverterFaultQuarantine('/w/photo.jpg', failed('conversion produced empty text: photo.jpg')), true);
  // Formats no converter reads are re-recorded as unsupported_format.
  assert.equal(isConverterFaultQuarantine('/w/plan.pages', failed('UnsupportedFormatException')), true);
  assert.equal(isConverterFaultQuarantine('/w/scan.pdf', failed(
    'scanned PDF (no text layer) and no OPENAI_API_KEY — OCR fallback unavailable\nconversion produced empty text: scan.pdf',
  )), true);
  assert.equal(isConverterFaultQuarantine('/w/notes.docx', failed(
    'markitdown._exceptions.MissingDependencyException: DocxConverter recognized the input as a potential .docx file, but the dependencies needed to read .docx files have not been installed.',
  )), true);

  // The file's own faults stay pinned.
  assert.equal(isConverterFaultQuarantine('/w/broken.pdf', failed('pdfminer.pdfparser.PDFSyntaxError: No /Root object!')), false);
  assert.equal(isConverterFaultQuarantine('/w/scan.pdf', failed('vision OCR returned no text for any page')), false);
  assert.equal(isConverterFaultQuarantine('/w/corrupt.png', failed('vision OCR (openai gpt-4o-mini): Invalid image')), false);
  assert.equal(isConverterFaultQuarantine('/w/blank.png', { parseStatus: 'conversion_empty', issues: ['vision OCR returned no text'] }), false);
  assert.equal(isConverterFaultQuarantine('/w/long.md', { parseStatus: 'suspect_truncation', issues: ['x'] }), false);
});
