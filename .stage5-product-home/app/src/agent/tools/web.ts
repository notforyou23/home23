/**
 * Web tools — browse pages via CDP, search via searxng + Brave fallback.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

export interface WebToolsConfig {
  braveApiKey?: string;
  searxngUrl?: string;
}

export const webBrowseTool: ToolDefinition = {
  name: 'web_browse',
  description: 'Navigate to a URL and extract the page text content. Requires Chrome running with --remote-debugging-port. Can also take screenshots.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to navigate to' },
      screenshot: { type: 'boolean', description: 'Take a screenshot instead of extracting text (default: false)' },
    },
    required: ['url'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const url = input.url as string;
    const screenshot = (input.screenshot as boolean) || false;

    if (!ctx.browser) {
      return {
        content: 'Browser not available. Chrome must be running with --remote-debugging-port=9222. Start Chrome and restart the agent.',
        is_error: true,
      };
    }

    let tabId: string | null = null;
    try {
      // Try to connect if not yet connected
      await ctx.browser.connect();

      // Open blank tab, then navigate (newTab's URL passing is unreliable)
      const tab = await ctx.browser.newTab();
      tabId = tab.id;
      await ctx.browser.navigate(tab.id, url);

      // Wait for page to load
      await new Promise(resolve => setTimeout(resolve, 3000));

      if (screenshot) {
        const { join } = await import('node:path');
        const { writeFileSync } = await import('node:fs');
        const buf = await ctx.browser.screenshot(tab.id);
        const filePath = join(ctx.tempDir, `screenshot-${Date.now()}.png`);
        writeFileSync(filePath, buf);
        await ctx.browser.closeTab(tab.id);
        return {
          content: `Screenshot saved to ${filePath}`,
          media: [{ type: 'image', path: filePath, mimeType: 'image/png' }],
        };
      }

      // Extract text content
      const text = await ctx.browser.evaluate(tab.id,
        'document.body.innerText || document.documentElement.textContent || ""'
      ) as string;

      await ctx.browser.closeTab(tab.id);
      return { content: (text || '').slice(0, 6000) || 'Page loaded but no text content extracted.' };
    } catch (err) {
      // Clean up tab on error to prevent leak
      if (tabId) {
        try { await ctx.browser!.closeTab(tabId); } catch { /* ignore cleanup error */ }
      }
      return { content: `Browse error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

export function createWebSearchTool(cfg: WebToolsConfig = {}): ToolDefinition {
  const searxngUrl = cfg.searxngUrl || process.env.SEARXNG_URL || 'http://localhost:8888';
  const braveApiKey = cfg.braveApiKey || process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY || '';

  return {
    name: 'web_search',
    description: 'Search the internet via local searxng instance with Brave Search API fallback. Returns top results with title, URL, and snippet.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Number of results (default: 10, max: 20)' },
      },
      required: ['query'],
    },

    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const query = input.query as string;
      const count = Math.min((input.count as number) || 10, 20);

      // ── Try searxng first (local, no API key needed) ──
      let searxngStatus: 'ok' | 'zero_results' | 'degraded' | 'unreachable' | 'http_error' = 'unreachable';
      let searxngDetail = '';
      try {
        const url = `${searxngUrl}/search?q=${encodeURIComponent(query)}&format=json&pageno=1`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });

        if (!res.ok) {
          searxngStatus = 'http_error';
          searxngDetail = `HTTP ${res.status}`;
        } else {
          const data = await res.json() as {
            results?: Array<{ title: string; url: string; content: string }>;
            unresponsive_engines?: Array<[string, string]>;
          };
          const results = (data.results ?? []).slice(0, count);
          const blocked = (data.unresponsive_engines ?? []).map(([n, r]) => `${n}: ${r}`).join('; ');

          if (results.length > 0) {
            const formatted = results
              .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content}`)
              .join('\n\n');
            return { content: formatted };
          }

          searxngStatus = 'zero_results';
          searxngDetail = blocked ? `no results; blocked engines: ${blocked}` : 'no results';
        }
      } catch (err) {
        searxngStatus = 'unreachable';
        searxngDetail = err instanceof Error ? err.message : String(err);
      }

      // ── Fallback to Brave Search ──
      if (!braveApiKey) {
        return {
          content: `Web search unavailable — searxng at ${searxngUrl} returned ${searxngStatus} (${searxngDetail}); Brave fallback has no key configured (providers.brave.apiKey).`,
          is_error: true,
        };
      }

      try {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
        const res = await fetch(url, {
          headers: { 'X-Subscription-Token': braveApiKey, 'Accept': 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });

        if (!res.ok) {
          return {
            content: `Search fallback failed — searxng: ${searxngStatus} (${searxngDetail}); Brave: HTTP ${res.status}`,
            is_error: true,
          };
        }

        const data = await res.json() as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
        const results = data.web?.results ?? [];

        if (results.length === 0) {
          return { content: `No search results found (searxng: ${searxngStatus}; Brave: empty).` };
        }

        const formatted = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`)
          .join('\n\n');

        return { content: formatted };
      } catch (err) {
        return {
          content: `Search fallback failed — searxng: ${searxngStatus} (${searxngDetail}); Brave error: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        };
      }
    },
  };
}

/** Env/default-only web_search — retained for callers that don't thread config. */
export const webSearchTool: ToolDefinition = createWebSearchTool();
