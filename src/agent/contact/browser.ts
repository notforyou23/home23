import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserController } from '../../browser/cdp.js';

export interface BrowserSnapshot {
  url: string;
  title: string;
  text: string;
}

export type BrowserWorkflowAction = 'open' | 'click' | 'submit';

export interface BrowserWorkflowResult {
  before: BrowserSnapshot | null;
  after: BrowserSnapshot;
  selector?: string;
  clicked?: boolean;
  submitted?: boolean;
  screenshotPath?: string;
}

const BLOCKED = /^(file|javascript|data|chrome|about):/i;
const MAX_WAIT_MS = 30_000;

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

// A fixed in-page function. The selector and mode reach it only as
// JSON-encoded arguments, never as code. submit uses the element's form
// (requestSubmit runs validation and submit handlers like a real press);
// anything else is a click.
export const BROWSER_INTERACTION_FUNCTION = `function (selector, mode) {
  var element;
  try { element = document.querySelector(selector); } catch (e) { return { found: false, invalid: true }; }
  if (!element) return { found: false };
  var tag = String(element.tagName || '').toLowerCase();
  if (mode === 'submit') {
    var form = tag === 'form' ? element : (element.form || (element.closest && element.closest('form')));
    if (form) {
      var type = String(element.type || '').toLowerCase();
      var submitter = element !== form && element.form === form && (type === 'submit' || type === 'image') ? element : undefined;
      if (typeof form.requestSubmit === 'function') form.requestSubmit(submitter); else form.submit();
      return { found: true, submitted: true, tag: tag };
    }
  }
  element.click();
  return { found: true, clicked: true, tag: tag };
}`;

export function browserInteractionExpression(selector: string, mode: 'click' | 'submit'): string {
  return `(${BROWSER_INTERACTION_FUNCTION})(${JSON.stringify(selector)}, ${JSON.stringify(mode)})`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runBrowserWorkflow(input: {
  browser: BrowserController;
  url: string;
  waitMs?: number;
  /** Save a PNG of the final page under screenshotDir. */
  screenshot?: boolean;
  screenshotDir?: string;
  /** click and submit act on a live page, so they need confirm. */
  confirm?: boolean;
  allowlist?: string[];
  action?: BrowserWorkflowAction;
  selector?: string;
}): Promise<BrowserWorkflowResult> {
  const action = input.action ?? 'open';
  const selector = input.selector?.trim() ?? '';
  assertBrowserUrl(input.url, input.allowlist);
  if (action !== 'open') {
    if (!selector) throw new Error(`selector_required: browser ${action} needs a CSS selector`);
    if (!input.confirm) throw new Error(`browser ${action} requires confirm=true`);
  }
  if (input.screenshot && !input.screenshotDir) throw new Error('screenshot requires a screenshot directory');
  const waitMs = Math.min(Math.max(Number(input.waitMs ?? 2500) || 0, 0), MAX_WAIT_MS);

  await input.browser.connect();
  const tab = await input.browser.newTab();
  try {
    await input.browser.navigate(tab.id, input.url);
    await wait(waitMs);
    let result: BrowserWorkflowResult;
    if (action === 'open') {
      result = { before: null, after: await snapshotPage(input.browser, tab.id) };
    } else {
      const before = await snapshotPage(input.browser, tab.id);
      const outcome = await input.browser.evaluate(tab.id, browserInteractionExpression(selector, action)) as
        { found?: boolean; invalid?: boolean; clicked?: boolean; submitted?: boolean } | undefined;
      if (outcome?.invalid) throw new Error(`invalid_selector: ${selector} is not a valid CSS selector`);
      if (!outcome?.found) throw new Error(`selector_not_found: no element matches ${selector} on ${before.url}`);
      await wait(waitMs);
      result = {
        before,
        after: await snapshotPage(input.browser, tab.id),
        selector,
        clicked: Boolean(outcome.clicked),
        submitted: Boolean(outcome.submitted),
      };
    }
    if (input.screenshot && input.screenshotDir) {
      mkdirSync(input.screenshotDir, { recursive: true });
      const screenshotPath = join(input.screenshotDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.png`);
      writeFileSync(screenshotPath, await input.browser.screenshot(tab.id));
      result.screenshotPath = screenshotPath;
    }
    return result;
  } finally {
    try { await input.browser.closeTab(tab.id); } catch { /* ignore */ }
  }
}
