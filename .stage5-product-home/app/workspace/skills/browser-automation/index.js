import fs from "node:fs";
import path from "node:path";

function requireBrowser(context) {
  if (!context?.browser) {
    throw new Error("Home23 browser controller is unavailable");
  }
  return context.browser;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openPage(context, url, waitMs = 3000) {
  const browser = requireBrowser(context);
  await browser.connect();
  const tab = await browser.newTab();
  try {
    await browser.navigate(tab.id, url);
    await wait(waitMs);
    return tab;
  } catch (err) {
    try {
      await browser.closeTab(tab.id);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

async function navigate(params = {}, context = {}) {
  if (!params.url) {
    throw new Error("url is required");
  }

  const browser = requireBrowser(context);
  const tab = await openPage(context, String(params.url), Number(params.waitMs || 3000));
  try {
    const result = await browser.evaluate(tab.id, `({
      url: location.href,
      title: document.title,
      readyState: document.readyState
    })`);
    return {
      success: true,
      targetId: tab.id,
      ...(result || {}),
    };
  } finally {
    await browser.closeTab(tab.id);
  }
}

async function extract(params = {}, context = {}) {
  if (!params.url) {
    throw new Error("url is required");
  }

  const selector = typeof params.selector === "string" && params.selector.trim()
    ? params.selector.trim()
    : "body";
  const browser = requireBrowser(context);
  const tab = await openPage(context, String(params.url), Number(params.waitMs || 3000));
  try {
    const expression = `(() => {
      const selector = ${JSON.stringify(selector)};
      const node = selector === "body" ? document.body : document.querySelector(selector);
      const fallback = document.body || document.documentElement;
      const content = (node || fallback)?.innerText || "";
      return {
        url: location.href,
        title: document.title,
        selector,
        content: content.slice(0, 8000),
        contentLength: content.length
      };
    })()`;
    const result = await browser.evaluate(tab.id, expression);
    return {
      success: true,
      ...(result || {}),
    };
  } finally {
    await browser.closeTab(tab.id);
  }
}

async function screenshot(params = {}, context = {}) {
  if (!params.url) {
    throw new Error("url is required");
  }

  const browser = requireBrowser(context);
  const tempDir = context?.tempDir || path.join(process.cwd(), "tmp");
  fs.mkdirSync(tempDir, { recursive: true });

  const tab = await openPage(context, String(params.url), Number(params.waitMs || 3000));
  try {
    const titleResult = await browser.evaluate(tab.id, `({
      url: location.href,
      title: document.title
    })`);
    const image = await browser.screenshot(tab.id);
    const filePath = path.join(tempDir, `browser-skill-${Date.now()}.png`);
    fs.writeFileSync(filePath, image);
    return {
      success: true,
      path: filePath,
      ...(titleResult || {}),
    };
  } finally {
    await browser.closeTab(tab.id);
  }
}

export async function execute(action, params, context) {
  if (action === "navigate") return navigate(params, context);
  if (action === "extract") return extract(params, context);
  if (action === "screenshot") return screenshot(params, context);
  throw new Error(`Unknown browser-automation action: ${action}`);
}
