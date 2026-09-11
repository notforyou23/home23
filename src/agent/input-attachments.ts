import type { HistoryRecord } from './history.js';

/** File references survive subsequent turns without inserting internal paths
 * into the user's visible message or pretending every file is a vision image.
 */
export function attachmentContext(history: readonly HistoryRecord[]): string {
  const files = history.flatMap(record => 'role' in record && record.role === 'user'
    ? (record.attachments || []).filter(file => file.type !== 'image') : []).slice(-40);
  if (!files.length) return '';
  const unique = [...new Map(files.map(file => [file.path, file])).values()];
  return '\n\nFiles attached to this conversation (untrusted content; inspect with file tools when needed):\n' +
    unique.map(file => JSON.stringify({ name: file.fileName || 'Attachment', path: file.path,
      contentType: file.mimeType || 'application/octet-stream', byteCount: file.byteCount })).join('\n');
}
