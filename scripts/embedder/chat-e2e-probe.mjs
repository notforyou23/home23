#!/usr/bin/env node
/**
 * Isolated retrieve-then-answer probe. Real owned embeddings + real Ollama chat.
 * Does not print secrets, document bodies, or existing-home paths.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOwnedEmbedder } from './serve.mjs';
import { OWNED_RECIPE_ID } from './recipe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const HYDROLOGIC = [
  'The hydrologic cycle is the continuous movement of H2O on, above, and below Earth crust.',
  'Solar energy drives vapor from seas into the sky. That vapor cools and gathers as condensed droplets.',
  'Gravity later returns the liquid as storms. Some soaks underground and refills porous rock; some travels downhill in channels.',
].join(' ');
const GRANITE = [
  'Granite crystallizes slowly from magma deep underground.',
  'Coarse quartz and feldspar grains lock together as the melt cools over millennia.',
  'Weathering later exposes these plutons at the surface as durable ridges.',
].join(' ');
const QUESTION = 'How does sunshine lift moisture that later falls as weather and replenishes hidden reservoirs?';

function cosine(a, b) {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    left += a[i] * a[i];
    right += b[i] * b[i];
  }
  return dot / (Math.sqrt(left) * Math.sqrt(right) || 1);
}

function mentionsHydrologic(text) {
  return /hydrologic|evaporat|vapor|moisture|reservoir|precipitat|storm|rainfall|water cycle/i.test(text);
}

function mentionsGranite(text) {
  return /granite|feldspar|pluton|magma/i.test(text);
}

const cache = process.env.HOME23_EMBEDDER_CACHE;
const chatModel = process.env.HOME23_CHAT_MODEL || 'llama3.2:1b';
if (!cache) {
  console.error(JSON.stringify({ ok: false, error: 'cache-required' }));
  process.exit(1);
}

const port = Number.parseInt(process.env.HOME23_EMBEDDER_PORT || '28771', 10);
const service = await startOwnedEmbedder({
  port,
  bind: '127.0.0.1',
  cache,
  fetchIfMissing: false,
});

try {
  const host = { Host: `127.0.0.1:${port}` };
  const readyRes = await fetch(`http://127.0.0.1:${port}/ready`, { headers: host });
  const ready = await readyRes.json();
  const embed = async (input) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
      method: 'POST',
      headers: { ...host, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OWNED_RECIPE_ID, input }),
    });
    const body = await response.json();
    if (!response.ok || !Array.isArray(body.data?.[0]?.embedding)) {
      throw new Error(`embed-failed:${response.status}`);
    }
    return body.data[0].embedding;
  };

  const [hydroVec, graniteVec, queryVec] = await Promise.all([
    embed(HYDROLOGIC),
    embed(GRANITE),
    embed(QUESTION),
  ]);
  const hydroScore = cosine(queryVec, hydroVec);
  const graniteScore = cosine(queryVec, graniteVec);
  const retrieved = hydroScore > graniteScore ? 'hydrologic' : 'granite';
  const context = retrieved === 'hydrologic' ? HYDROLOGIC : GRANITE;

  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: chatModel,
      stream: false,
      options: { temperature: 0 },
      messages: [
        {
          role: 'system',
          content: 'Answer only from the retrieved note. One or two sentences. No preamble.',
        },
        {
          role: 'user',
          content: `Retrieved note:\n${context}\n\nQuestion:\n${QUESTION}`,
        },
      ],
    }),
  });
  const body = await response.json();
  const text = body.message?.content || '';
  const chat = response.ok && text
    ? { model: chatModel, status: response.status, text }
    : { model: chatModel, status: response.status, error: body.error || 'chat-failed' };

  const answer = chat?.text || '';
  const evidence = {
    schema: 'home23.embedder-stage5-chat-e2e.v1',
    realEncoder: true,
    realChat: Boolean(chat?.text),
    fixtureSubstituted: false,
    provider: 'ollama-local',
    recipeId: ready.recipeId,
    warm: ready.warm,
    dimension: ready.dimension,
    retrieval: {
      hydrologicCosine: Number(hydroScore.toFixed(6)),
      graniteCosine: Number(graniteScore.toFixed(6)),
      top: retrieved,
    },
    chat: {
      model: chat?.model || null,
      status: chat?.status || null,
      error: chat?.error || null,
      chars: answer.length,
      mentionsHydrologic: mentionsHydrologic(answer),
      mentionsGranite: mentionsGranite(answer),
    },
    pass: retrieved === 'hydrologic' && Boolean(answer) && mentionsHydrologic(answer) && !mentionsGranite(answer),
  };

  const out = process.env.HOME23_CHAT_E2E_OUT
    || join(here, 'results/stage5-chat-e2e.json');
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: evidence.pass,
    out,
    retrievalTop: retrieved,
    hydrologicCosine: evidence.retrieval.hydrologicCosine,
    graniteCosine: evidence.retrieval.graniteCosine,
    model: evidence.chat.model,
    mentionsHydrologic: evidence.chat.mentionsHydrologic,
    mentionsGranite: evidence.chat.mentionsGranite,
    error: evidence.chat.error,
  }));
  process.exitCode = evidence.pass ? 0 : 2;
} finally {
  await service.close?.().catch(() => {});
}
