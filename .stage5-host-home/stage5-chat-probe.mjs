import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const homeRoot = '/Users/jtr/_JTR23_/development/home23/.home23-worktrees/owned-embedder-stage5-verify/.stage5-product-home';
const receiptPath = '/Users/jtr/_JTR23_/development/home23/.home23-worktrees/owned-embedder-stage5-verify/.stage5-host-home/stage5-chat3b-receipt.json';
const note = readFileSync('/Users/jtr/_JTR23_/development/home23/.home23-worktrees/owned-embedder-stage5-verify/.stage5-host-import/usgs-style-hydrologic-cycle.txt', 'utf8').trim();
const paraphrase = 'How does sunshine lift moisture that later falls as weather and replenishes hidden reservoirs?';
const channelId = 'chn_01a08e42-8e19-734d-9d6d-1f35cb5edae9';
const coord = 'http://127.0.0.1:32584';
const dash = 'http://127.0.0.1:32586';

function phrasesFrom(text) {
  const lower = String(text || '').toLowerCase();
  return {
    hydrologic: lower.includes('hydrologic') || lower.includes('h2o'),
    granite: lower.includes('granite') || lower.includes('magma'),
    solar: lower.includes('solar energy') || lower.includes('solar'),
    vapor: lower.includes('vapor'),
    seas: lower.includes('seas') || lower.includes('sea'),
    storms: lower.includes('storm'),
    porous: lower.includes('porous') || lower.includes('underground'),
    inventedCloserQuote: lower.includes('sunlight energy heats water molecules'),
  };
}

async function json(url, { method = 'GET', body, token, timeoutMs = 60_000 } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['idempotency-key'] = randomUUID();
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`${url} ${response.status} ${value.code || ''} ${value.message || value.error || ''}`.trim());
    error.status = response.status;
    error.code = value.code;
    throw error;
  }
  return value;
}

const sessionPath = join(homeRoot, 'runtime', 'host-session.json');
const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
const refreshed = await json(`${coord}/api/v1/sessions/refresh`, {
  method: 'POST',
  body: { refreshToken: session.refreshToken },
});
if (!refreshed.accessToken) throw new Error('refresh did not return access');
writeFileSync(sessionPath, JSON.stringify({
  accessToken: refreshed.accessToken,
  refreshToken: refreshed.refreshToken,
  accessExpiresAt: refreshed.accessExpiresAt,
  refreshExpiresAt: refreshed.refreshExpiresAt,
}, null, 2) + '\n', { mode: 0o600 });
const token = refreshed.accessToken;

const ready = await fetch('http://127.0.0.1:32591/ready', {
  headers: { host: '127.0.0.1:32591' },
  signal: AbortSignal.timeout(15000),
}).then(r => r.json());

let search;
for (let attempt = 0; attempt < 20; attempt += 1) {
  try {
    search = await json(`${dash}/api/memory/search`, {
      method: 'POST',
      body: { query: paraphrase, topK: 5, mode: 'context' },
      timeoutMs: 15_000,
    });
    if (search.results?.length) break;
  } catch (error) {
    search = { error: error.message };
  }
  await new Promise(r => setTimeout(r, 2000));
}

const { generateCoordinationId } = await import(pathToFileURL(join(homeRoot, 'app/dist/coordination/ids/index.js')));
const messageId = generateCoordinationId('message');
const postedAt = Date.now();
await json(`${coord}/api/v1/channels/${channelId}/messages`, {
  method: 'POST',
  token,
  body: {
    messageId,
    clientMessageId: randomUUID(),
    text: paraphrase,
    attachmentIds: [],
    mentions: [],
    replyToMessageId: null,
  },
});

const knownOld = new Set([
  'msg_01a08e5f-6e5f-7f44-a603-282dd1814528',
  'msg_01a08e5d-7822-7c18-993b-04ce276851d9',
  'msg_01a08e6e-39f9-7d41-ab0f-1ccaf597acda',
  'msg_01a08e7c-0b8e-722d-9855-2cd0e292d1fd',
  'msg_01a08e7e-9923-7751-8c0f-cc4e95da27b7',
  'msg_01a08e8b-7d08-7962-b22c-af2b1c934c8d',
  'msg_01a08eb9-13b1-741d-a43d-f5d075b3977f',
  'msg_01a08eb9-1461-7bb3-a7fd-5244feddfb92',
  'msg_01a0909b-2325-7852-9db7-d06a7378c5be',
  'msg_01a0909b-234f-721d-9c1a-a446b31baccb',
  'msg_01a090b1-b522-7f3b-a827-0bc6c9a20223',
]);
let answer = null;
const until = Date.now() + 240_000;
while (Date.now() < until) {
  const page = await json(`${coord}/api/v1/channels/${channelId}/messages`, { token });
  const results = (page.messages || []).filter((m) => {
    if (m.kind !== 'result' || knownOld.has(m.id)) return false;
    const created = Date.parse(m.createdAt || m.created_at || 0);
    return Number.isFinite(created) && created >= postedAt - 1000;
  });
  const newest = results.at(-1);
  if (newest) {
    answer = newest;
    break;
  }
  await new Promise(r => setTimeout(r, 2000));
}

const answerText = answer?.text || '';
const marks = phrasesFrom(answerText);
const usedNote = [marks.solar, marks.vapor, marks.seas, marks.storms, marks.porous].filter(Boolean).length >= 2
  && !marks.inventedCloserQuote
  && !marks.granite;
const hits = (search?.results || []).map(row => ({
  id: row.id,
  similarity: row.similarity,
  retrievalScore: row.retrievalScore,
  conceptPrefix: String(row.concept || '').slice(0, 120),
  source: row.source || row.path || row.tag || null,
}));
const hydro = hits.find(h => String(h.conceptPrefix).toLowerCase().includes('hydrologic'));
const granite = hits.find(h => String(h.conceptPrefix).toLowerCase().includes('granite'));
const receipt = {
  schema: 'home23.embedder-stage5-chat3b-receipt.v1',
  closedAt: new Date().toISOString(),
  model: 'openai/gpt-5.5',
  ready: { warm: ready.warm === true, recipeId: ready.recipeId, pid: ready.pid, dimension: ready.dimension },
  productSearch: {
    retrievalMode: search?.retrievalMode || search?.sourceEvidence?.retrievalMode || null,
    sourceHealth: search?.sourceEvidence?.sourceHealth || search?.sourceHealth || null,
    hits,
    hydrologicBeatsGranite: hydro && granite ? Number(hydro.similarity) > Number(granite.similarity) : null,
  },
  chat: {
    messageId,
    answerId: answer?.id || null,
    answerExcerpt: answerText.slice(0, 800),
    marks,
    usedImportedNote: usedNote,
    noteMustContain: 'Solar energy drives vapor from seas',
  },
  importedNoteChars: note.length,
};
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({
  searchOk: Boolean(hydro && granite && Number(hydro.similarity) > Number(granite.similarity)),
  hydro: hydro?.similarity,
  granite: granite?.similarity,
  answerId: answer?.id || null,
  usedImportedNote: usedNote,
  marks,
  excerpt: answerText.slice(0, 400),
}, null, 2));
if (!usedNote) process.exitCode = 2;
