import { HF_ID } from './recipe.mjs';

export async function loadOwnedExtractor(cacheDir) {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = cacheDir;
  env.allowRemoteModels = false;
  return pipeline('feature-extraction', HF_ID, { dtype: 'fp32', local_files_only: true });
}

export async function embedOwned(extractor, text) {
  const output = await extractor(text, { pooling: 'mean', normalize: false });
  const embedding = Array.from(output?.tolist?.()?.[0] ?? output?.data ?? []);
  return embedding;
}

export function createQueue({ concurrency = 1, maxWaiting = 32 } = {}) {
  let active = 0;
  const waiting = [];

  function kick() {
    while (active < concurrency && waiting.length) {
      const job = waiting.shift();
      if (job.expired()) {
        job.reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
        continue;
      }
      active += 1;
      Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          kick();
        });
    }
  }

  return {
    enqueue(run, { timeoutMs = 30_000, priority = 0 } = {}) {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const job = {
          priority,
          run,
          resolve,
          reject,
          expired: () => Date.now() - started > timeoutMs,
        };
        const pending = waiting.filter((item) => !item.expired()).length;
        if (active >= concurrency && pending >= maxWaiting) {
          reject(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
          return;
        }
        waiting.push(job);
        waiting.sort((a, b) => b.priority - a.priority);
        kick();
      });
    },
  };
}
