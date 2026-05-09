'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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

class DocumentConverter {
  constructor({ logger = null, visionModel = 'gpt-4o-mini', pythonPath = 'python3' }) {
    this.logger = logger;
    this.visionModel = visionModel;
    this.pythonPath = resolvePythonPath(pythonPath);
    this._available = null; // lazy-checked
    this._availabilityWarned = false;
  }

  /**
   * Check if MarkItDown is installed.
   */
  get available() {
    if (this._available === null) {
      try {
        execFileSync(this.pythonPath, ['-c', 'from markitdown import MarkItDown'], {
          timeout: 10000,
          stdio: 'pipe'
        });
        this._available = true;
      } catch {
        this._available = false;
      }
    }
    return this._available;
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
      if (!this.available) {
        if (!this._availabilityWarned) {
          this.logger?.warn?.('MarkItDown not installed — binary files will be skipped. Install: pip install markitdown');
          this._availabilityWarned = true;
        }
        return { ok: false, status: 'converter_unavailable', retryable: true };
      }

      try {
        const env = { ...process.env };
        if (this.visionModel) {
          env.MLM_MODEL = this.visionModel;
        }

        const output = execFileSync(this.pythonPath, [CONVERT_SCRIPT, filePath], {
          timeout: 120000,
          maxBuffer: 50 * 1024 * 1024,
          encoding: 'utf8',
          env,
          stdio: ['pipe', 'pipe', 'pipe']
        });

        if (!output || output.trim().length === 0) {
          this.logger?.warn?.('MarkItDown returned empty output', { filePath });
          return { ok: false, status: 'conversion_empty', retryable: false };
        }

        return { ok: true, text: output, format: 'md' };
      } catch (err) {
        const error = (err.stderr || err.message || '').slice(0, 200);
        this.logger?.error?.('MarkItDown conversion failed', {
          filePath,
          error
        });
        return { ok: false, status: 'conversion_failed', retryable: false, error };
      }
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
}

module.exports = { DocumentConverter };
