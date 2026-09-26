'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { unprivilegedChildEnv } = require('../../../shared/child-process-env.cjs');
const {
  IMAGE_OCR_PROMPT,
  PAGE_OCR_PROMPT,
  callVisionModel,
  classifyPythonProviderError,
  classifyVisionError,
  resolveVisionTarget,
} = require('./vision-ocr');

const NATIVE_TEXT_EXTS = new Set([
  '.md', '.txt', '.yaml', '.yml', '.json', '.csv', '.org', '.rst',
  '.tsx', '.jsx', '.js', '.ts', '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.cpp', '.h', '.swift', '.sh', '.toml', '.log', '.tex',
  '.ini', '.conf', '.cfg', '.env', '.plist', '.sql', '.jsonl',
  '.opml', '.bib', '.tsv', '.srt', '.vtt', '.eml', '.mbox',
  '.ics', '.vcf', '.css', '.xml'
]);

// What MarkItDown 0.1.x can actually read, by format, and the python
// modules each needs beyond MarkItDown itself. `extra` is the pip extra that
// installs them; init installs only markitdown[pdf].
const PYTHON_FORMATS = Object.freeze({
  pdf: { exts: ['.pdf'], modules: ['pdfminer', 'pdfplumber'], extra: 'pdf' },
  docx: { exts: ['.docx'], modules: ['mammoth'], extra: 'docx' },
  pptx: { exts: ['.pptx'], modules: ['pptx'], extra: 'pptx' },
  xlsx: { exts: ['.xlsx'], modules: ['pandas', 'openpyxl'], extra: 'xlsx' },
  xls: { exts: ['.xls'], modules: ['pandas', 'xlrd'], extra: 'xls' },
  audio: { exts: ['.mp3', '.wav', '.m4a'], modules: ['pydub', 'speech_recognition'], extra: 'audio-transcription' },
  html: { exts: ['.html', '.htm'], modules: [] },
  epub: { exts: ['.epub'], modules: [] },
  zip: { exts: ['.zip'], modules: [] },
});

// Images go straight to the configured vision model (vision-ocr.js); these
// are the types the vision APIs accept.
const IMAGE_MIME_TYPES = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
});

// Document formats Home23 used to claim but no converter reads.
// They were quarantined as conversion_failed, which read as a broken file.
const UNSUPPORTED_EXTS = new Set([
  '.doc', '.rtf', '.pages', '.odt', '.numbers', '.ods', '.key', '.odp', '.ppt',
  '.bmp', '.tiff', '.tif', '.heic',
  '.ogg', '.flac', '.aac',
]);

const FORMAT_BY_EXT = new Map();
for (const [format, spec] of Object.entries(PYTHON_FORMATS)) {
  for (const ext of spec.exts) FORMAT_BY_EXT.set(ext, format);
}
for (const ext of Object.keys(IMAGE_MIME_TYPES)) FORMAT_BY_EXT.set(ext, 'images');

const CONVERTIBLE_EXTS = new Set([...FORMAT_BY_EXT.keys(), ...UNSUPPORTED_EXTS]);

// One probe for runtime, MarkItDown and every format's modules. find_spec
// does not import the optional modules; MarkItDown itself is imported so a
// broken install reads as broken, not present.
const HEALTH_PROBE = [
  'import importlib.util, json, sys',
  `mods = ${JSON.stringify([...new Set(Object.values(PYTHON_FORMATS).flatMap(spec => spec.modules))])}`,
  'found = {m: importlib.util.find_spec(m) is not None for m in mods}',
  'try:',
  '    from markitdown import MarkItDown',
  '    ok, err = True, None',
  'except Exception as e:',
  '    ok, err = False, f"{type(e).__name__}: {e}"',
  'print(json.dumps({"python": sys.version.split()[0], "markitdown": ok, "error": err, "modules": found}))',
].join('\n');

const CONVERT_SCRIPT = path.join(__dirname, 'convert-file.py');

// Home23 bundles its MarkItDown + PDF deps inside a dedicated venv at
// engine/.venv-markitdown so the converter doesn't depend on the host
// system python picking up `markitdown[pdf]` via `--break-system-packages`.
// cli/home23.js init creates this venv; convert-file.py is still a normal
// script that works with any python that has the deps available.
const BUNDLED_VENV_PYTHON = path.join(__dirname, '..', '..', '.venv-markitdown', 'bin', 'python3');

function resolvePythonPath(explicitPath) {
  // Explicit override from config always wins.
  if (explicitPath && explicitPath !== 'python3') return { path: explicitPath, source: 'config' };
  // Prefer the bundled venv if it exists — gives us markitdown[pdf] + openai
  // pinned to a known-good install that survives `brew upgrade python`.
  try {
    if (fs.existsSync(BUNDLED_VENV_PYTHON)) return { path: BUNDLED_VENV_PYTHON, source: 'bundled' };
  } catch { /* ignore */ }
  // Last resort: system python3 (user may have installed markitdown globally).
  return { path: 'python3', source: 'system' };
}

function formatOf(filePath) {
  return FORMAT_BY_EXT.get(path.extname(filePath).toLowerCase()) || null;
}

function tail(text, max = 600) {
  const raw = String(text || '').trim();
  return raw.length > max ? `…${raw.slice(-max)}` : raw;
}

const HEALTH_TTL_MS = 10 * 60 * 1000;
const UNAVAILABLE_TTL_MS = 60 * 1000;
// After a provider error, image OCR pauses instead of spending one failing
// call per waiting file: a bad model or credential costs one call per 30 min.
const VISION_MISCONFIGURED_COOLDOWN_MS = 30 * 60 * 1000;
const VISION_TRANSIENT_COOLDOWN_MS = 60 * 1000;
const VISION_TARGET_TTL_MS = 30 * 1000;
const EXIT_EMPTY = 3; // convert-file.py: MarkItDown produced no text

function findPdftoppm() {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'pdftoppm');
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const candidate of ['/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function stripCodeFence(text) {
  // Vision models habitually wrap transcriptions in a ``` fence; fenced
  // markdown defeats semantic chunking (headings inside a code block).
  let t = String(text || '').trim();
  if (t.startsWith('```')) {
    const lines = t.split('\n').slice(1);
    if (lines.length && lines[lines.length - 1].trim() === '```') lines.pop();
    t = lines.join('\n').trim();
  }
  return t;
}

/**
 * Promise wrapper over the callback execFile so stdout/stderr survive on a
 * failure and tests can inject the spawner.
 */
function runChild(execFileImpl, file, args, options) {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

const MISSING_DEPENDENCY = /MissingDependencyException|ModuleNotFoundError|No module named/;

function isAbort(err, signal) {
  return Boolean(signal?.aborted) || err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
}

class DocumentConverter {
  constructor({
    logger = null,
    visionModel = 'gpt-4o-mini',
    pythonPath = 'python3',
    enabled = true,
    execFileImpl = execFile,
    now = Date.now,
    visionResolver = resolveVisionTarget,
    visionCall = callVisionModel,
    pdftoppmPath,
  }) {
    this.logger = logger;
    this.visionModel = visionModel;
    this.enabled = enabled !== false;
    const runtime = resolvePythonPath(pythonPath);
    this.pythonPath = runtime.path;
    this.pythonSource = runtime.source;
    this._execFile = execFileImpl;
    this._now = now;
    this._resolveVision = visionResolver;
    this._callVision = visionCall;
    this._pdftoppm = pdftoppmPath === undefined ? findPdftoppm : () => pdftoppmPath;
    this._visionTargetCache = null;
    this._visionFault = null;
    this._visionOkAt = null;
    this._probe = null; // python probe result; unknown until the first async probe
    this._healthCheckedAt = 0;
    this._healthProbe = null;
    this._availabilityWarned = false;
    // Conversions run in a child process; one at a time, like the old
    // synchronous path, but without blocking the engine's event loop.
    this._tail = Promise.resolve();
    this._abort = new AbortController();
    this._closed = false;
  }

  /**
   * Last known MarkItDown availability (false until a probe has answered).
   * Never spawns: the old getter ran a synchronous 10 s probe on first read.
   */
  get available() {
    return this._probe?.markitdown === true;
  }

  /**
   * Probe the runtime, MarkItDown and each format's modules asynchronously.
   * Cached for 10 minutes, or 60 seconds while MarkItDown is missing, so
   * installing or repairing the converter needs no engine restart.
   */
  async checkHealth({ force = false } = {}) {
    if (!this.enabled) return this._composeHealth();
    const ttl = this._probe?.markitdown ? HEALTH_TTL_MS : UNAVAILABLE_TTL_MS;
    if (!force && this._probe && this._now() - this._healthCheckedAt < ttl) return this._composeHealth();
    if (this._healthProbe) return this._healthProbe;
    this._healthProbe = (async () => {
      let probe;
      try {
        const { stdout } = await runChild(this._execFile, this.pythonPath, ['-c', HEALTH_PROBE], {
          timeout: 20000,
          encoding: 'utf8',
          env: unprivilegedChildEnv(),
          signal: this._abort.signal,
        });
        probe = JSON.parse(String(stdout || '').trim().split('\n').pop());
      } catch (err) {
        probe = {
          markitdown: false,
          error: err.code === 'ENOENT'
            ? `python runtime not found: ${this.pythonPath}`
            : tail(err.stderr || err.message, 300),
        };
      }
      this._probe = probe;
      this._healthCheckedAt = this._now();
      this._healthProbe = null;
      return this._composeHealth();
    })();
    return this._healthProbe;
  }

  /**
   * The cached health for status reads; starts a background re-probe when
   * stale instead of making the caller wait on a subprocess.
   */
  healthSnapshot({ refresh = true } = {}) {
    const ttl = this._probe?.markitdown ? HEALTH_TTL_MS : UNAVAILABLE_TTL_MS;
    if (refresh && this.enabled && !this._closed && (!this._probe || this._now() - this._healthCheckedAt >= ttl)) {
      this.checkHealth().catch(() => {});
    }
    return this._composeHealth();
  }

  /**
   * Health = the cached python probe plus the live vision state, composed
   * at read time so a vision fault shows as soon as it happens.
   */
  _composeHealth() {
    const probe = this._probe;
    const vision = this._visionStatus();
    const base = {
      enabled: this.enabled,
      runtime: { path: this.pythonPath, source: this.pythonSource },
      python: probe?.python || null,
      markitdown: probe?.markitdown === true,
      vision,
      tools: { pdftoppm: this._pdftoppm() || null },
      checkedAt: probe ? new Date(this._healthCheckedAt).toISOString() : null,
    };
    if (!this.enabled) {
      return { ...base, state: 'disabled', reason: 'document conversion is turned off in feeder settings',
        remedy: 'Enable the converter in Settings > Feeder', formats: {}, unavailableFormats: [], available: false };
    }
    const formats = {};
    for (const [format, spec] of Object.entries(PYTHON_FORMATS)) {
      formats[format] = base.markitdown && spec.modules.every(m => probe?.modules?.[m] === true);
    }
    formats.images = vision.usable;
    const unavailableFormats = Object.keys(formats).filter(format => !formats[format]);
    if (!probe) {
      return { ...base, state: 'checking', reason: 'converter check has not finished yet', remedy: null,
        formats, unavailableFormats, available: false };
    }
    const python = /\s/.test(this.pythonPath) ? `"${this.pythonPath}"` : this.pythonPath;
    const pip = `${python} -m pip install`;
    const reasons = [];
    const remedies = [];
    const visionProblem = describeVisionProblem(vision);
    if (!base.markitdown) {
      reasons.push(probe.error || 'MarkItDown is not installed');
      remedies.push(`Run node cli/home23.js init, or: ${pip} "markitdown[pdf]" openai`);
      if (visionProblem) { reasons.push(visionProblem.reason); remedies.push(visionProblem.remedy); }
      return { ...base, state: 'unavailable', formats, unavailableFormats, available: false,
        reason: reasons.join('; '), remedy: remedies.join('; ') };
    }
    if (!formats.pdf) reasons.push('PDF support is not installed (pdfminer.six, pdfplumber)');
    if (visionProblem) { reasons.push(visionProblem.reason); remedies.push(visionProblem.remedy); }
    const optional = unavailableFormats.filter(format => format !== 'pdf' && format !== 'images');
    const extras = [...new Set(unavailableFormats.map(format => PYTHON_FORMATS[format]?.extra).filter(Boolean))];
    if (optional.length) reasons.push(`not installed: ${optional.join(', ')}`);
    if (extras.length) remedies.push(`${pip} "markitdown[${extras.join(',')}]"`);
    return { ...base, state: !formats.pdf || visionProblem ? 'degraded' : 'ready', formats, unavailableFormats,
      available: true, reason: reasons.join('; ') || null, remedy: remedies.join('; ') || null };
  }

  _visionTarget() {
    const cached = this._visionTargetCache;
    if (cached && this._now() - cached.at < VISION_TARGET_TTL_MS) return cached.target;
    let target;
    try {
      target = this._resolveVision(this.visionModel);
    } catch (err) {
      target = { model: this.visionModel, provider: null, api: null, hasCredentials: false, error: err.message };
    }
    this._visionTargetCache = { at: this._now(), target };
    return target;
  }

  /**
   * Whether image OCR can be attempted now, and why not. Never includes the
   * credential itself.
   */
  _visionStatus() {
    if (!this.enabled) return { state: 'disabled', usable: false, model: this.visionModel, provider: null };
    const target = this._visionTarget();
    const base = {
      model: target.model,
      provider: target.provider,
      api: target.api,
      lastOkAt: this._visionOkAt !== null ? new Date(this._visionOkAt).toISOString() : null,
    };
    if (!target.hasCredentials) {
      return { ...base, state: 'no_credentials', usable: false,
        error: target.error || `no credentials for ${target.provider || 'the vision provider'}` };
    }
    const fault = this._visionFault;
    if (fault && this._now() < fault.until && fault.model === target.model
      && fault.provider === target.provider && fault.credential === target.credential) {
      return { ...base, state: fault.kind === 'transient' ? 'unavailable' : 'misconfigured', usable: false,
        error: fault.error, retryAt: new Date(fault.until).toISOString() };
    }
    return { ...base, state: this._visionOkAt !== null ? 'ok' : 'unverified', usable: true };
  }

  /**
   * Whether a file waiting on the converter could convert now (per the
   * cached health and the vision state). Cheap: never spawns.
   */
  canConvertNow(filePath, needs = null) {
    if (!this.enabled || this._closed) return false;
    if (needs === 'vision') return this._visionStatus().usable;
    if (needs === 'pdftoppm') return Boolean(this._pdftoppm());
    const format = formatOf(filePath);
    if (format === 'images') return this._visionStatus().usable;
    if (!format || !this._probe?.markitdown) return false;
    return PYTHON_FORMATS[format].modules.every(m => this._probe.modules?.[m] === true);
  }

  /**
   * Cancel in-flight and queued conversions (feeder shutdown). Cancelled
   * work reports a retryable status and is never quarantined.
   */
  close() {
    if (this._closed) return;
    this._closed = true;
    this._abort.abort();
  }

  _exclusive(task) {
    const run = this._tail.then(task, task);
    this._tail = run.catch(() => {});
    return run;
  }

  /**
   * Check if a file is native text (can be read directly).
   */
  isNativeText(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return NATIVE_TEXT_EXTS.has(ext);
  }

  /**
   * Check if a file can be converted by MarkItDown.
   */
  isConvertible(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return CONVERTIBLE_EXTS.has(ext);
  }

  /**
   * Convert a file to markdown text.
   * @param {string} filePath - Absolute path to the file
   * @returns {{ text: string, format: string } | null}
   */
  async convert(filePath) {
    const result = await this.convertDetailed(filePath);
    return result.ok ? { text: result.text, format: result.format } : null;
  }

  /**
   * Convert a file with structured failure metadata so callers can distinguish
   * transient converter availability from deterministic file conversion errors.
   * @param {string} filePath - Absolute path to the file
   * @returns {{ ok: true, text: string, format: string } | { ok: false, status: string, retryable: boolean, error?: string }}
   */
  async convertDetailed(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (this._closed) return { ok: false, status: 'conversion_aborted', retryable: true, error: 'converter closed' };

    // Native text — read directly
    if (this.isNativeText(filePath)) {
      try {
        const text = fs.readFileSync(filePath, 'utf8');
        if (!text || text.trim().length === 0) {
          return { ok: false, status: 'empty_text', retryable: false };
        }
        return { ok: true, text, format: ext.slice(1) };
      } catch (err) {
        this.logger?.error?.('Failed to read native text file', { filePath, error: err.message });
        return { ok: false, status: 'read_failed', retryable: true, error: err.message };
      }
    }

    // Convertible binary — use MarkItDown
    if (this.isConvertible(filePath)) {
      if (!this.enabled) {
        return { ok: false, status: 'converter_disabled', retryable: true, needs: 'enabled',
          error: 'document conversion is turned off in feeder settings' };
      }
      if (UNSUPPORTED_EXTS.has(ext)) {
        return { ok: false, status: 'unsupported_format', retryable: false,
          error: `no converter reads ${ext} files; export it as PDF, DOCX, PNG or plain text to ingest it` };
      }
      if (IMAGE_MIME_TYPES[ext]) return this._exclusive(() => this._convertImage(filePath, IMAGE_MIME_TYPES[ext]));
      return this._exclusive(() => this._convertBinary(filePath));
    }

    // Unknown extension — try reading as UTF-8
    try {
      const buf = fs.readFileSync(filePath);
      // Quick binary check: look for null bytes in first 8KB
      const sample = buf.slice(0, 8192);
      if (sample.includes(0)) {
        this.logger?.debug?.('Skipping binary file with unknown extension', { filePath });
        return { ok: false, status: 'unknown_binary', retryable: false };
      }
      const text = buf.toString('utf8');
      if (!text || text.trim().length === 0) {
        return { ok: false, status: 'empty_text', retryable: false };
      }
      return { ok: true, text, format: ext.slice(1) || 'txt' };
    } catch (err) {
      this.logger?.debug?.('Failed to read unknown file type', { filePath, error: err.message });
      return { ok: false, status: 'read_failed', retryable: true, error: err.message };
    }
  }

  async _convertBinary(filePath) {
    const signal = this._abort.signal;
    if (this._closed) return { ok: false, status: 'conversion_aborted', retryable: true, error: 'converter closed' };
    const format = formatOf(filePath);
    const health = await this.checkHealth();
    if (!health.markitdown) {
      if (!this._availabilityWarned) {
        this.logger?.warn?.('MarkItDown not available — binary files wait until it is', { reason: health.reason, remedy: health.remedy });
        this._availabilityWarned = true;
      }
      return { ok: false, status: 'converter_unavailable', retryable: true, needs: 'runtime', error: health.reason };
    }
    if (!health.formats[format]) {
      return { ok: false, status: 'converter_unavailable', retryable: true, needs: format,
        error: `${format} conversion is not installed${health.remedy ? `: ${health.remedy}` : ''}` };
    }

    try {
      const env = unprivilegedChildEnv();
      // MarkItDown's own image hooks (pictures inside a PPTX) speak only the
      // OpenAI chat API, so they get the vision model only when its provider
      // does; they never get a model from another provider.
      const target = this._visionTarget();
      if (target.api === 'openai' && target.apiKey && this._visionStatus().usable) {
        env.HOME23_VISION_API_KEY = target.apiKey;
        env.HOME23_VISION_MODEL = target.model;
        if (target.baseURL) env.HOME23_VISION_BASE_URL = target.baseURL;
      }

      // 300s: a large text-layer conversion. Async: the synchronous call
      // froze the whole engine (cognition, admin HTTP, heartbeats) for the
      // length of every conversion.
      const { stdout: output } = await runChild(this._execFile, this.pythonPath, [CONVERT_SCRIPT, filePath], {
        timeout: 300000,
        maxBuffer: 50 * 1024 * 1024,
        encoding: 'utf8',
        env,
        signal,
      });

      if (!output || output.trim().length === 0) {
        this.logger?.warn?.('MarkItDown returned empty output', { filePath });
        return { ok: false, status: 'conversion_empty', retryable: false };
      }

      return { ok: true, text: output, format: 'md' };
    } catch (err) {
      if (isAbort(err, signal)) {
        return { ok: false, status: 'conversion_aborted', retryable: true, error: 'conversion cancelled by feeder shutdown' };
      }
      // Keep the TAIL of stderr: a python traceback puts the actual
      // exception on its last line — the first 200 chars are just frames.
      const error = tail(err.stderr || err.message);
      // No text layer: render the pages and OCR them with the vision model.
      if (err.code === EXIT_EMPTY) {
        if (format === 'pdf') return this._ocrScannedPdf(filePath, signal);
        return { ok: false, status: 'conversion_empty', retryable: false, error };
      }
      // A missing optional module is the converter's fault, not the file's.
      if (MISSING_DEPENDENCY.test(error)) {
        this.logger?.warn?.('MarkItDown is missing a module for this format', { filePath, error });
        return { ok: false, status: 'converter_unavailable', retryable: true, needs: format, error };
      }
      // A provider error from MarkItDown's image hook is configuration.
      const providerFault = classifyPythonProviderError(error);
      if (providerFault) return this._visionFailure(providerFault, this._visionTarget(), error);
      this.logger?.error?.('MarkItDown conversion failed', {
        filePath,
        error
      });
      return { ok: false, status: 'conversion_failed', retryable: false, error };
    }
  }

  async _convertImage(filePath, mimeType) {
    let buffer;
    try {
      buffer = fs.readFileSync(filePath);
    } catch (err) {
      return { ok: false, status: 'read_failed', retryable: true, error: err.message };
    }
    const result = await this._transcribe(buffer, mimeType, IMAGE_OCR_PROMPT, this._abort.signal);
    if (!result.ok) return result;
    if (!result.text) {
      return { ok: false, status: 'conversion_empty', retryable: false, error: 'vision OCR returned no text' };
    }
    return { ok: true, text: result.text, format: 'md' };
  }

  async _ocrScannedPdf(filePath, signal) {
    const gate = this._visionStatus();
    if (!gate.usable) return this._visionUnusable(gate);
    const pdftoppm = this._pdftoppm();
    if (!pdftoppm) {
      return { ok: false, status: 'converter_unavailable', retryable: true, needs: 'pdftoppm',
        error: 'scanned PDF (no text layer) and pdftoppm is not installed: brew install poppler' };
    }
    const maxPages = Number.parseInt(process.env.HOME23_OCR_MAX_PAGES || '20', 10) || 20;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-pdf-ocr-'));
    try {
      const prefix = path.join(tmpDir, 'page');
      try {
        await runChild(this._execFile, pdftoppm, ['-png', '-r', '150', '-l', String(maxPages), filePath, prefix], {
          timeout: 120000,
          env: unprivilegedChildEnv(),
          signal,
        });
      } catch (err) {
        if (isAbort(err, signal)) {
          return { ok: false, status: 'conversion_aborted', retryable: true, error: 'conversion cancelled by feeder shutdown' };
        }
        return { ok: false, status: 'conversion_failed', retryable: false, error: `pdftoppm failed: ${tail(err.stderr || err.message, 300)}` };
      }
      // pdftoppm zero-pads page numbers to one width, so name order is page order.
      const pages = fs.readdirSync(tmpDir).filter(name => /^page-\d+\.png$/.test(name)).sort();
      if (!pages.length) return { ok: false, status: 'conversion_failed', retryable: false, error: 'pdftoppm produced no page images' };
      const chunks = [];
      for (const page of pages) {
        const result = await this._transcribe(fs.readFileSync(path.join(tmpDir, page)), 'image/png', PAGE_OCR_PROMPT, signal);
        if (!result.ok) return result;
        if (result.text) chunks.push(result.text);
      }
      if (!chunks.length) {
        return { ok: false, status: 'conversion_empty', retryable: false, error: 'vision OCR returned no text for any page' };
      }
      return { ok: true, text: chunks.join('\n\n'), format: 'md' };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * One vision call against the configured model's own provider. Provider
   * errors pause image OCR (see _visionStatus) and are retryable; only an
   * error naming the image itself is the file's fault.
   */
  async _transcribe(buffer, mimeType, prompt, signal) {
    const gate = this._visionStatus();
    if (!gate.usable) return this._visionUnusable(gate);
    const target = this._visionTarget();
    try {
      const text = await this._callVision({
        target, prompt, mimeType, base64: buffer.toString('base64'), signal, logger: this.logger,
      });
      if (this._closed) return { ok: false, status: 'conversion_aborted', retryable: true, error: 'converter closed' };
      this._visionOkAt = this._now();
      this._visionFault = null;
      return { ok: true, text: stripCodeFence(text) };
    } catch (err) {
      if (isAbort(err, signal)) {
        return { ok: false, status: 'conversion_aborted', retryable: true, error: 'conversion cancelled by feeder shutdown' };
      }
      const error = `vision OCR (${target.provider} ${target.model}): ${tail(err?.message || err, 400)}`;
      const kind = classifyVisionError(err);
      if (kind === 'file') return { ok: false, status: 'conversion_failed', retryable: false, error };
      return this._visionFailure(kind, target, error);
    }
  }

  _visionFailure(kind, target, error) {
    const cooldown = kind === 'transient' ? VISION_TRANSIENT_COOLDOWN_MS : VISION_MISCONFIGURED_COOLDOWN_MS;
    const until = this._now() + cooldown;
    this._visionFault = { kind, error, until, model: target.model, provider: target.provider, credential: target.credential };
    this.logger?.warn?.('Vision OCR paused after a provider error; waiting files retry automatically', {
      provider: target.provider,
      model: target.model,
      kind,
      retryAt: new Date(until).toISOString(),
      error,
    });
    return { ok: false, status: kind === 'transient' ? 'converter_unavailable' : 'converter_misconfigured',
      retryable: true, needs: 'vision', error };
  }

  _visionUnusable(gate) {
    return { ok: false, status: gate.state === 'unavailable' ? 'converter_unavailable' : 'converter_misconfigured',
      retryable: true, needs: 'vision', error: gate.error || `vision OCR is ${gate.state}` };
  }
}

function describeVisionProblem(vision) {
  const who = `${vision.provider || 'its provider'} (vision model ${vision.model})`;
  if (vision.state === 'no_credentials') {
    return { reason: `image OCR has no credentials for ${who}`,
      remedy: `Add or sign in to ${vision.provider || 'the provider'} in Settings > Providers` };
  }
  if (vision.state === 'misconfigured') {
    return { reason: `image OCR paused: ${vision.error}`,
      remedy: `Check the ${vision.provider || 'provider'} credential or the Vision Model in Settings > Feeder; waiting images retry automatically` };
  }
  if (vision.state === 'unavailable') {
    return { reason: `image OCR retrying after a provider error: ${vision.error}`, remedy: 'Waiting images retry automatically' };
  }
  return null;
}

// Issues the old converter recorded for faults that were never the file's:
// no OpenAI key, no pdftoppm, a missing python module.
const CONVERTER_FAULT_ISSUE = /no OPENAI_API_KEY|OCR fallback unavailable|pdftoppm not installed|MissingDependencyException|ModuleNotFoundError|No module named/;

/**
 * Whether a quarantined manifest entry was the converter's fault rather than
 * the file's: an image OCR'd against the wrong provider or without a key, a
 * format now named unsupported, a provider or dependency error. Such
 * entries are released at feeder start so the scan re-evaluates them.
 */
function isConverterFaultQuarantine(filePath, entry) {
  if (!['conversion_failed', 'conversion_empty'].includes(entry?.parseStatus)) return false;
  const issues = (Array.isArray(entry.issues) ? entry.issues : []).map(String).join('\n');
  const ext = path.extname(filePath).toLowerCase();
  // A verdict from this vision path is the file's own; do not retry it.
  if (IMAGE_MIME_TYPES[ext]) return !/^vision OCR\b/m.test(issues);
  if (UNSUPPORTED_EXTS.has(ext)) return true;
  return CONVERTER_FAULT_ISSUE.test(issues) || classifyPythonProviderError(issues) !== null;
}

module.exports = { DocumentConverter, PYTHON_FORMATS, UNSUPPORTED_EXTS, IMAGE_MIME_TYPES, isConverterFaultQuarantine };
