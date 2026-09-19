import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export async function atomicWrite(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
    const directory = await open(dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temp).catch(() => {}); }
}
