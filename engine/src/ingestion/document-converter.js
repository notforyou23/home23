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

const CONVERTIBLE_EXTS = new Set([
  // Documents
  '.pdf', '.docx', '.doc', '.rtf', '.pages', '.odt',
  // Spreadsheets
  '.xlsx', '.xls', '.numbers', '.ods',
  // Presentations
  '.pptx', '.ppt', '.key', '.odp',
  // Images (OCR)
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp', '.heic',
  // Audio (transcription)
  '.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac',
  // Web
  '.html', '.htm',
  // Archives
  '.zip',
  // eBooks
  '.epub'
]);

const CONVERT_SCRIPT = path.join(__dirname, 'convert-file.py');

// Home23 bundles its MarkItDown + PDF deps inside a dedicated venv at
// engine/.venv-markitdown so the converter doesn't depend on the host
// system python picking up `markitdown[pdf]` via `--break-system-packages`.
// cli/home23.js init creates this venv; convert-file.py is still a normal
// script that works with any python that has the deps available.
const BUNDLED_VENV_PYTHON = path.join(__dirname, '..', '..', '.venv-markitdown', 'bin', 'python3');

function resolvePythonPath(explicitPath) {
  // Explicit override from config always wins.
  if (explicitPath && explicitPath !== 'python3') return explicitPath;
  // Prefer the bundled venv if it exists — gives us markitdown[pdf] + openai
  // pinned to a known-good install that survives `brew upgrade python`.
  try {
    if (fs.existsSync(BUNDLED_VENV_PYTHON)) return BUNDLED_VENV_PYTHON;
  } catch { /* ignore */ }
  // Last resort: system python3 (user may have installed markitdown globally).
  return 'python3';
}

const AVAILABLE_TTL_MS = 10 * 60 * 1000;
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

function isAbort(err, signal) {
  return Boolean(signal?.aborted) || err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
}

class DocumentConverter {
  constructor({ logger = null, visionModel = 'gpt-4o-mini', pythonPath = 'python3', execFileImpl = execFile, now = Date.now }) {
    this.logger = logger;
    this.visionModel = visionModel;
    this.pythonPath = resolvePythonPath(pythonPath);
    this._execFile = execFileImpl;
    this._now = now;
    this._available = null; // unknown until the first async probe
    this._availabilityCheckedAt = 0;
    this._availabilityProbe = null;
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
    return this._available === true;
  }

  /**
   * Probe MarkItDown asynchronously. Cached for 10 minutes when present and
   * 60 seconds when absent, so installing it needs no engine restart.
   */
  async checkAvailability({ force = false } = {}) {
    const ttl = this._available ? AVAILABLE_TTL_MS : UNAVAILABLE_TTL_MS;
    if (!force && this._available !== null && this._now() - this._availabilityCheckedAt < ttl) {
      return this._available;
    }
    if (this._availabilityProbe) return this._availabilityProbe;
    this._availabilityProbe = (async () => {
      try {
        await runChild(this._execFile, this.pythonPath, ['-c', 'from markitdown import MarkItDown'], {
          timeout: 20000,
          env: unprivilegedChildEnv(),
          signal: this._abort.signal,
        });
        this._available = true;
      } catch {
        this._available = false;
      } finally {
        this._availabilityCheckedAt = this._now();
        this._availabilityProbe = null;
      }
      return this._available;
    })();
    return this._availabilityProbe;
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
    if (!(await this.checkAvailability())) {
      if (!this._availabilityWarned) {
        this.logger?.warn?.('MarkItDown not installed — binary files will be skipped. Install: pip install markitdown');
        this._availabilityWarned = true;
      }
      return { ok: false, status: 'converter_unavailable', retryable: true };
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
      const raw = String(err.stderr || err.message || '').trim();
      const error = raw.length > 600 ? `…${raw.slice(-600)}` : raw;
      this.logger?.error?.('MarkItDown conversion failed', {
        filePath,
        error
      });
      return { ok: false, status: 'conversion_failed', retryable: false, error };
    }
  }
}

module.exports = { DocumentConverter };
