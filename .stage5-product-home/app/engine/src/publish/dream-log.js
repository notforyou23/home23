/**
 * DreamLogPublisher — writes a creative-output artifact to
 * workspace/dreams/ only when a critic verdict = "keep" is emitted
 * against creative content. Gates the surreal-transform lineage
 * behind a real quality ratchet.
 */

'use strict';

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class DreamLogPublisher {
  constructor({ outDir, ledger, logger }) {
    if (!outDir) throw new Error('DreamLogPublisher requires outDir');
    this.outDir = outDir;
    this.ledger = ledger;
    this.logger = logger || console;
  }

  async onCriticVerdict({ verdict, creative } = {}) {
    if (verdict !== 'keep' || !creative) return null;
    try { mkdirSync(this.outDir, { recursive: true }); } catch {}
    const date = new Date().toISOString().slice(0, 10);
    const slug = (creative.title || 'dream').replace(/[^a-z0-9-]+/gi, '-').toLowerCase().slice(0, 40);
    const path = join(this.outDir, `${date}-${slug}.md`);
    const body = [
      `# ${creative.title || 'Dream'}`,
      '',
      `_generated ${new Date().toISOString()}_`,
      '',
      creative.text || '',
      '',
    ].join('\n');
    writeFileSync(path, body);
    await this.ledger?.record?.({ target: 'dream_log', artifact: path });
    this.logger.info?.(`[publish] dream-log: ${path}`);
    return path;
  }
}
