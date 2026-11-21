// Harness for fuzz.spec.js and hostile.spec.js.
//
// Same idea as helpers.js (real extension files in WebKit with a stubbed
// `browser` API), plus:
// - a TEST-ONLY build of content.js that exposes internals on
//   window.__duskDebug (luminance parser, state, scanner queue sizes),
//   made by appending one line before the closing `})();`. The shipped
//   extension/content.js is never modified.
// - control over response headers (CSP), content type (XHTML, SVG, XML,
//   text/plain) and the stub API's failure modes.
//
// Limits of the harness, by design:
// - Everything runs in the page's MAIN world. Safari runs content scripts in
//   an isolated world, so page overrides of DOM prototypes cannot reach the
//   real content script. Tests that override prototypes are worst cases.
// - dusk.css is injected as a page <style> element (Safari injects it as an
//   extension stylesheet). Under a strict CSP that <style> is blocked in the
//   harness, while Safari's extension stylesheet is not.
const fs = require("fs");
const path = require("path");
const { stubApi, watch, settle } = require("./helpers");

const EXT = path.resolve(__dirname, "..", "extension");
const CONTENT_JS = fs.readFileSync(path.join(EXT, "content.js"), "utf8");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
const CONTENT_CSS = (MANIFEST.content_scripts || [])
  .flatMap((cs) => cs.css || [])
  .map((f) => fs.readFileSync(path.join(EXT, f), "utf8"))
  .join("\n");

const HOOK = `
  window.__duskDebug = {
    luminance, ownBackground, backgroundAt, pageIsAlreadyDark, state, siteMode, render,
    invertAmount, sepiaAmount,
    settings: () => settings,
    bgQueueLen: () => bgQueue.length,
    bgRecheckSize: () => bgRecheck.size,
    observing: () => !!bgObserver,
    scheduled: () => bgScheduled,
    sizing: () => sizing,
  };
`;

function debugBuild(src = CONTENT_JS) {
  const at = src.lastIndexOf("})();");
  if (at < 0) throw new Error("content.js: closing })(); not found");
  return src.slice(0, at) + HOOK + src.slice(at);
}
const DEBUG_JS = debugBuild();

function injectCss(css) {
  if (window !== window.top) return; // manifest has all_frames: false
  const add = () => {
    const s = document.createElementNS("http://www.w3.org/1999/xhtml", "style");
    s.setAttribute("data-dusk-test", "css");
    s.textContent = css;
    document.documentElement.prepend(s);
  };
  if (document.documentElement) add();
  else new MutationObserver((_, obs) => { if (document.documentElement) { obs.disconnect(); add(); } })
    .observe(document, { childList: true });
}

// Variant of the stub API whose storage misbehaves.
//   mode "reject": get/set return rejected promises
//   mode "throw":  get/set throw synchronously (extension context invalidated)
function breakStorage(mode) {
  const local = window.browser.storage.local;
  if (mode === "reject") {
    local.get = () => Promise.reject(new Error("storage unavailable"));
    local.set = () => Promise.reject(new Error("storage unavailable"));
  } else if (mode === "throw") {
    local.get = () => { throw new Error("Extension context invalidated."); };
    local.set = () => { throw new Error("Extension context invalidated."); };
  }
}

const HOST = "example.test";
const ORIGIN = `http://${HOST}`;

/**
 * Opens `body` at http://example.test<pathname> with Dusk injected.
 * opts.contentType  response type (default text/html)
 * opts.headers      extra response headers (CSP)
 * opts.settings     initial storage
 * opts.debug        use the test-only build (default true)
 * opts.storage      "reject" | "throw" to break the storage API
 * opts.css          inject dusk.css (default true)
 * opts.before       extra init script source, runs before content.js
 * opts.after        extra init script source, runs right after content.js
 */
async function open(page, opts = {}) {
  const {
    body = "<!doctype html><p>Hello</p>", contentType = "text/html", headers = {}, settings = {},
    debug = true, storage = null, css = true, before = null, after = null, pathname = "/", host = HOST,
  } = opts;
  const origin = `http://${host}`;
  const log = watch(page);
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === pathname) {
      return route.fulfill({ status: 200, headers: { "content-type": contentType, ...headers }, body });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await page.addInitScript(stubApi, { initial: settings });
  if (storage) await page.addInitScript(breakStorage, storage);
  if (before) await page.addInitScript({ content: before });
  if (css && CONTENT_CSS) await page.addInitScript(injectCss, CONTENT_CSS);
  // all_frames: false: Playwright init scripts run in every frame, Safari's content script only in the top one.
  await page.addInitScript({ content: `if (window === window.top) {\n${debug ? DEBUG_JS : CONTENT_JS}\n}` });
  if (after) await page.addInitScript({ content: after });
  await page.goto(origin + pathname, { waitUntil: "load" });
  try { await settle(page); } catch { /* page replaced Promise etc.: main-world evaluate is unusable */ }
  return log;
}

// Waits until the scanner is idle: empty queue, empty recheck set, nothing scheduled.
async function scannerIdle(page, limit = 20000) {
  return page.evaluate(async (limit) => {
    const d = window.__duskDebug;
    const t0 = performance.now();
    let calm = 0;
    while (performance.now() - t0 < limit) {
      await new Promise((r) => setTimeout(r, 40));
      if (d.bgQueueLen() === 0 && d.bgRecheckSize() === 0 && !d.scheduled() && d.sizing() === 0) { if (++calm >= 3) return performance.now() - t0; }
      else calm = 0;
    }
    return -1;
  }, limit);
}

const htmlState = (page) => page.evaluate(() => {
  const de = document.documentElement;
  return {
    attr: de.hasAttribute("data-dusk"),
    a: de.style ? de.style.getPropertyValue("--dusk-a") : null,
    filter: getComputedStyle(de).filter,
  };
});

module.exports = { EXT, CONTENT_JS, DEBUG_JS, CONTENT_CSS, HOST, ORIGIN, open, scannerIdle, htmlState, debugBuild };
