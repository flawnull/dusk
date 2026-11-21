// Test harness: runs the real extension files in WebKit with a stubbed
// `browser` extension API. No real network: every request is answered by
// page.route, and anything unexpected is recorded so tests can assert on it.
const fs = require("fs");
const path = require("path");

const EXT = path.resolve(__dirname, "..", "extension");
const CONTENT_JS = fs.readFileSync(path.join(EXT, "content.js"), "utf8");

// If the manifest declares content_scripts[].css, inject those files at
// document start the way Safari does (before any page style or script).
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
const CONTENT_CSS = (MANIFEST.content_scripts || [])
  .flatMap((cs) => cs.css || [])
  .map((f) => fs.readFileSync(path.join(EXT, f), "utf8"))
  .join("\n");

function injectCss(css) {
  const add = () => {
    const s = document.createElement("style");
    s.dataset.duskTest = "css";
    s.textContent = css;
    document.documentElement.prepend(s);
  };
  if (document.documentElement) add();
  else new MutationObserver((_, obs) => { if (document.documentElement) { obs.disconnect(); add(); } })
    .observe(document, { childList: true });
}
const HOST = "example.test";
const ORIGIN = `http://${HOST}`;

// Installed before content.js. Mimics browser.storage.local, storage.onChanged,
// runtime.onMessage and (for the popup) tabs.query / tabs.sendMessage.
function stubApi({ initial, tab, sendMessage }) {
  const store = JSON.parse(JSON.stringify(initial || {}));
  const changeListeners = [];
  const messageListeners = [];
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  window.__duskWrites = [];
  window.__duskStore = store;

  const local = {
    get(keys) {
      const out = {};
      if (keys && typeof keys === "object" && !Array.isArray(keys)) {
        for (const [k, def] of Object.entries(keys)) out[k] = k in store ? clone(store[k]) : clone(def);
      } else if (Array.isArray(keys)) {
        for (const k of keys) if (k in store) out[k] = clone(store[k]);
      } else if (typeof keys === "string") {
        if (keys in store) out[keys] = clone(store[keys]);
      } else {
        Object.assign(out, clone(store));
      }
      return Promise.resolve(out);
    },
    set(items) {
      window.__duskWrites.push(clone(items));
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: clone(store[k]), newValue: clone(v) };
        store[k] = clone(v);
      }
      // Real browsers deliver onChanged asynchronously.
      setTimeout(() => changeListeners.forEach((fn) => fn(clone(changes), "local")), 0);
      return Promise.resolve();
    },
  };

  window.browser = {
    storage: {
      local,
      onChanged: { addListener: (fn) => changeListeners.push(fn) },
    },
    runtime: {
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
    },
    tabs: {
      query: () => Promise.resolve(tab ? [tab] : []),
      sendMessage: () =>
        sendMessage && sendMessage.reject
          ? Promise.reject(new Error("Could not establish connection"))
          : Promise.resolve(sendMessage ? sendMessage.value : undefined),
    },
  };

  // Lets a test emit a storage change from "another context" (the popup).
  window.__duskSet = (items) => local.set(items);
  // Lets a test send a runtime message the way the popup would.
  window.__duskSend = async (msg) => {
    for (const fn of messageListeners) {
      const res = fn(msg, {}, () => {});
      if (res !== undefined) return await res;
    }
    return undefined;
  };
}

function watch(page) {
  const log = { requests: [], errors: [] };
  page.on("request", (r) => log.requests.push(r.url()));
  page.on("console", (m) => { if (m.type() === "error") log.errors.push(m.text()); });
  page.on("pageerror", (e) => log.errors.push(String(e)));
  return log;
}

// Loads `html` at http://example.test/<pathname> with the content script
// injected at document start, the way Safari does with run_at document_start.
async function openPage(page, { html = "<!doctype html><p>Hello</p>", settings = {}, pathname = "/" } = {}) {
  const log = watch(page);
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === ORIGIN && url.pathname === pathname) {
      return route.fulfill({ status: 200, contentType: "text/html", body: html });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await page.addInitScript(stubApi, { initial: settings });
  if (CONTENT_CSS) await page.addInitScript(injectCss, CONTENT_CSS);
  await page.addInitScript({ content: CONTENT_JS });
  await page.goto(ORIGIN + pathname, { waitUntil: "load" });
  await settle(page);
  return log;
}

// Lets queued promise callbacks, timers and storage events run.
async function settle(page) {
  await page.evaluate(() => new Promise((r) => setTimeout(r, 30)));
}

async function duskState(page) {
  const res = await page.evaluate(() => window.__duskSend({ type: "dusk:state" }));
  return res && res.state;
}

// Behavior, not implementation: reads what the page actually renders with.
// `count` is 1 when the root is filtered (Dusk active), else 0. `styleTags`
// counts Dusk <style> elements, if the implementation uses one at all.
async function styleInfo(page) {
  return page.evaluate(() => {
    const rootFilter = getComputedStyle(document.documentElement).filter;
    const probe = document.createElement("img");
    (document.body || document.documentElement).appendChild(probe);
    const mediaFilter = getComputedStyle(probe).filter;
    probe.remove();
    const page = rootFilter.match(/invert\(([\d.]+)\)/);
    const media = mediaFilter.match(/invert\(1\) contrast\(([\d.]+)\)/);
    return {
      count: rootFilter && rootFilter !== "none" ? 1 : 0,
      styleTags: document.querySelectorAll("#dusk-dark-style").length,
      rootFilter,
      mediaFilter,
      pageInvert: page ? parseFloat(page[1]) : null,
      mediaContrast: media ? parseFloat(media[1]) : null,
    };
  });
}

// Every CSS rule selector Dusk contributes, from whichever sheet holds them.
async function duskSelectors(page) {
  return page.evaluate(() => {
    const out = [];
    for (const sheet of Array.from(document.styleSheets)) {
      const owner = /** @type {any} */ (sheet.ownerNode);
      if (!owner || !(owner.id === "dusk-dark-style" || owner.dataset?.duskTest === "css")) continue;
      for (const r of Array.from(sheet.cssRules)) out.push(/** @type {any} */ (r).selectorText || r.cssText);
    }
    return out;
  });
}

async function setSettings(page, items) {
  await page.evaluate((i) => window.__duskSet(i), items);
  await settle(page);
}

module.exports = { EXT, HOST, ORIGIN, stubApi, watch, openPage, settle, duskState, styleInfo, duskSelectors, setSettings };
