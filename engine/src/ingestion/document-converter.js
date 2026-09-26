'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { unprivilegedChildEnv } = require('../../../shared/child-process-env.cjs');

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
  images: { exts: ['.jpg', '.jpeg', '.png'], modules: [] },
  html: { exts: ['.html', '.htm'], modules: [] },
  epub: { exts: ['.epub'], modules: [] },
  zip: { exts: ['.zip'], modules: [] },
});

// Document formats Home23 used to claim but no MarkItDown converter reads.
// They were quarantined as conversion_failed, which read as a broken file.
const UNSUPPORTED_EXTS = new Set([
  '.doc', '.rtf', '.pages', '.odt', '.numbers', '.ods', '.key', '.odp', '.ppt',
  '.gif', '.bmp', '.tiff', '.tif', '.webp', '.heic',
  '.ogg', '.flac', '.aac',
]);

const FORMAT_BY_EXT = new Map();
for (const [format, spec] of Object.entries(PYTHON_FORMATS)) {
  for (const ext of spec.exts) FORMAT_BY_EXT.set(ext, format);
}

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
  constructor({ logger = null, visionModel = 'gpt-4o-mini', pythonPath = 'python3', enabled = true, execFileImpl = execFile, now = Date.now }) {
    this.logger = logger;
    this.visionModel = visionModel;
    this.enabled = enabled !== false;
    const runtime = resolvePythonPath(pythonPath);
    this.pythonPath = runtime.path;
    this.pythonSource = runtime.source;
    this._execFile = execFileImpl;
    this._now = now;
    this._health = null; // unknown until the first async probe
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
    return this._health?.markitdown === true;
  }

  /**
   * Probe the runtime, MarkItDown and each format's modules asynchronously.
   * Cached for 10 minutes, or 60 seconds while MarkItDown is missing, so
   * installing or repairing the converter needs no engine restart.
   */
  async checkHealth({ force = false } = {}) {
    if (!this.enabled) {
      this._health = this._buildHealth(null);
      this._healthCheckedAt = this._now();
      return this._health;
    }
    const ttl = this._health?.markitdown ? HEALTH_TTL_MS : UNAVAILABLE_TTL_MS;
    if (!force && this._health && this._now() - this._healthCheckedAt < ttl) return this._health;
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
      this._health = this._buildHealth(probe);
      this._healthCheckedAt = this._now();
      this._healthProbe = null;
      return this._health;
    })();
    return this._healthProbe;
  }

  /**
   * The cached health for status reads; starts a background re-probe when
   * stale instead of making the caller wait on a subprocess.
   */
  healthSnapshot({ refresh = true } = {}) {
    const ttl = this._health?.markitdown ? HEALTH_TTL_MS : UNAVAILABLE_TTL_MS;
    if (refresh && !this._closed && (!this._health || this._now() - this._healthCheckedAt >= ttl)) {
      this.checkHealth().catch(() => {});
    }
    return this._health || {
      state: 'checking',
      enabled: this.enabled,
      reason: 'converter check has not finished yet',
      remedy: null,
      runtime: { path: this.pythonPath, source: this.pythonSource },
      python: null,
      markitdown: false,
      formats: {},
      unavailableFormats: [],
      checkedAt: null,
      available: false,
    };
  }

  _buildHealth(probe) {
    const runtime = { path: this.pythonPath, source: this.pythonSource };
    const base = {
      enabled: this.enabled,
      runtime,
      python: probe?.python || null,
      markitdown: probe?.markitdown === true,
      checkedAt: new Date(this._now()).toISOString(),
    };
    if (!this.enabled) {
      return { ...base, state: 'disabled', reason: 'document conversion is turned off in feeder settings',
        remedy: 'Enable the converter in Settings > Feeder', formats: {}, unavailableFormats: [], available: false };
    }
    const formats = {};
    for (const [format, spec] of Object.entries(PYTHON_FORMATS)) {
      formats[format] = base.markitdown && spec.modules.every(m => probe?.modules?.[m] === true);
    }
    const unavailableFormats = Object.keys(formats).filter(format => !formats[format]);
    const python = /\s/.test(this.pythonPath) ? `"${this.pythonPath}"` : this.pythonPath;
    const pip = `${python} -m pip install`;
    if (!base.markitdown) {
      return { ...base, state: 'unavailable', formats, unavailableFormats, available: false,
        reason: probe?.error || 'MarkItDown is not installed',
        remedy: `Run node cli/home23.js init, or: ${pip} "markitdown[pdf]" openai` };
    }
    const extras = [...new Set(unavailableFormats.map(format => PYTHON_FORMATS[format].extra).filter(Boolean))];
    const remedy = extras.length ? `${pip} "markitdown[${extras.join(',')}]"` : null;
    if (!formats.pdf) {
      return { ...base, state: 'degraded', formats, unavailableFormats, available: true,
        reason: 'PDF support is not installed (pdfminer.six, pdfplumber)', remedy };
    }
    return { ...base, state: 'ready', formats, unavailableFormats, available: true,
      reason: unavailableFormats.length ? `not installed: ${unavailableFormats.join(', ')}` : null, remedy };
  }

  /**
   * Whether a file waiting on the converter could convert now (per the
   * cached health). Cheap: never spawns.
   */
  canConvertNow(filePath) {
    if (!this.enabled || this._closed) return false;
    const format = formatOf(filePath);
    return Boolean(format && this._health?.markitdown && this._health.formats?.[format]);
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
          error: `no converter reads ${ext} files; export it as PDF, DOCX or plain text to ingest it` };
      }
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
      if (this.visionModel) {
        env.MLM_MODEL = this.visionModel;
      }

      // 300s: scanned-PDF OCR renders and vision-reads up to 20 pages —
      // a plain text-layer conversion never gets near this. Async: the
      // synchronous call froze the whole engine (cognition, admin HTTP,
      // heartbeats) for the length of every conversion.
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
      // A missing optional module is the converter's fault, not the file's.
      if (MISSING_DEPENDENCY.test(error)) {
        this.logger?.warn?.('MarkItDown is missing a module for this format', { filePath, error });
        return { ok: false, status: 'converter_unavailable', retryable: true, needs: format, error };
      }
      this.logger?.error?.('MarkItDown conversion failed', {
        filePath,
        error
      });
      return { ok: false, status: 'conversion_failed', retryable: false, error };
    }
  }
}

module.exports = { DocumentConverter, PYTHON_FORMATS, UNSUPPORTED_EXTS };
