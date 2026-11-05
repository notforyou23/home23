import type { BrowserController } from '../../browser/cdp.js';

export interface BrowserSnapshot {
  url: string;
  title: string;
  text: string;
}

const BLOCKED = /^(file|javascript|data|chrome|about):/i;

export function assertBrowserUrl(url: string, allowlist: string[] = []): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid url: ${url}`);
  }
  if (BLOCKED.test(parsed.protocol)) throw new Error(`blocked url scheme: ${parsed.protocol}`);
  if (allowlist.length > 0) {
    const host = parsed.hostname.toLowerCase();
    const ok = allowlist.some((entry) => host === entry.toLowerCase() || host.endsWith(`.${entry.toLowerCase()}`));
    if (!ok) throw new Error(`host ${host} is not on the browser allowlist`);
  }
}

export async function snapshotPage(browser: BrowserController, targetId: string): Promise<BrowserSnapshot> {
  const result = await browser.evaluate(targetId, `({
    url: location.href,
    title: document.title,
    text: (document.body && document.body.innerText || document.documentElement.textContent || '').slice(0, 8000)
  })`) as BrowserSnapshot;
  return {
    url: String(result?.url ?? ''),
    title: String(result?.title ?? ''),
    text: String(result?.text ?? ''),
  };
}

export async function runBrowserWorkflow(input: {
  browser: BrowserController;
  url: string;
  waitMs?: number;
  screenshot?: boolean;
  confirmSubmit?: boolean;
  allowlist?: string[];
  action?: 'open' | 'submit';
}): Promise<{ before: BrowserSnapshot | null; after: BrowserSnapshot; screenshotPath?: string }> {
  assertBrowserUrl(input.url, input.allowlist);
  if (input.action === 'submit' && !input.confirmSubmit) {
    throw new Error('browser submit requires confirm=true');
  }
  await input.browser.connect();
  const tab = await input.browser.newTab();
  try {
    await input.browser.navigate(tab.id, input.url);
    await new Promise((resolve) => setTimeout(resolve, input.waitMs ?? 2500));
    const after = await snapshotPage(input.browser, tab.id);
    return { before: null, after };
  } finally {
    try { await input.browser.closeTab(tab.id); } catch { /* ignore */ }
  }
}
