// Dusk performance benchmark in real WebKit.
//
//   npm run perf                 all scenarios, 5 runs each, prints a median table
//   npm run perf -- --runs 3     fewer runs
//   npm run perf -- --label after  also writes perf/results-after.json
//
// Conditions: "none" (no extension), "on" (Dusk active), "off" (Dusk off for
// this site). The content script is an instrumented copy built in memory; the
// shipped extension/content.js is never modified.
"use strict";
const fs = require("fs");
const path = require("path");
const { webkit } = require("@playwright/test");
const { stubApi } = require("../helpers");
const { heavy, article } = require("./fixtures");

const EXT = path.resolve(__dirname, "..", "..", "extension");
const ORIGIN = "http://bench.test";
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : def; };
const RUNS = Number(opt("runs", 5));
const LABEL = opt("label", "");
const ONLY = opt("only", "");

// ---------- instrumentation (in memory only) ----------
const WRAP = ["render", "apply", "remove", "checkDark", "pageIsAlreadyDark", "bgSlice", "hasUrlBackground", "bgTooBig", "measureAndMark", "loadSettings"];
const PRELUDE = `
window.__dp = { total: 0, depth: 0, t: {}, n: {}, max: {}, moRecords: 0, moCalls: 0 };
function __acc(k, d) { const p = window.__dp; p.t[k] = (p.t[k] || 0) + d; p.n[k] = (p.n[k] || 0) + 1; p.max[k] = Math.max(p.max[k] || 0, d); }
function __w(k, fn) {
  return function (...a) {
    const p = window.__dp, t0 = performance.now();
    p.depth++;
    try { return fn.apply(this, a); }
    finally { p.depth--; const d = performance.now() - t0; __acc(k, d); if (p.depth === 0) p.total += d; }
  };
}
class __PerfIO extends IntersectionObserver {
  constructor(cb, o) {
    super((entries, obs) => {
      const p = window.__dp; const t0 = performance.now(); p.depth++;
      try { cb(entries, obs); }
      finally { p.depth--; const d = performance.now() - t0; __acc("sizer", d); if (p.depth === 0) p.total += d; }
    }, o);
  }
}
class __PerfMO extends MutationObserver {
  constructor(cb) {
    super((records, obs) => {
      const p = window.__dp; p.moCalls++; p.moRecords += records.length;
      const t0 = performance.now(); p.depth++;
      try { cb(records, obs); }
      finally { p.depth--; const d = performance.now() - t0; __acc("observer", d); if (p.depth === 0) p.total += d; }
    });
  }
}
`;
function instrumented() {
  let src = fs.readFileSync(path.join(EXT, "content.js"), "utf8");
  src = src.replace(/new MutationObserver\(/g, "new __PerfMO(").replace(/new IntersectionObserver\(/g, "new __PerfIO(");
  const wraps = WRAP.map((n) => `if (typeof ${n} === "function") ${n} = __w(${JSON.stringify(n)}, ${n});`).join("\n");
  src = src.replace('"use strict";', '"use strict";\n' + wraps);
  // Debug hook: how many DOM references Dusk still holds, and how many are detached.
  const hook = `
  window.__duskDebug = () => {
    const out = {};
    try { out.queue = bgQueue.length; out.queueDetached = bgQueue.filter((w) => !(w.root || w).isConnected).length; } catch (e) {}
    try { out.recheck = bgRecheck.size; out.recheckDetached = [...bgRecheck].filter((e) => !e.isConnected).length; } catch (e) {}
    return out;
  };
})();`;
  const end = src.lastIndexOf("})();");
  src = src.slice(0, end) + hook + src.slice(end + 5);
  return PRELUDE + src;
}

const CSS = (() => {
  const m = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  return m.content_scripts.flatMap((c) => c.css || []).map((f) => fs.readFileSync(path.join(EXT, f), "utf8")).join("\n");
})();
function injectCss(css) {
  const add = () => { const s = document.createElement("style"); s.textContent = css; document.documentElement.prepend(s); };
  if (document.documentElement) add();
  else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); add(); } }).observe(document, { childList: true });
}

// Frame probe, installed first in every condition.
function probe() {
  const f = { worst: 0, over50: 0, frames: 0, gaps: [] };
  window.__frames = f;
  let last = 0;
  function tick(t) {
    if (last) { const g = t - last; f.frames++; f.gaps.push(g); if (g > f.worst) f.worst = g; if (g > 50) f.over50++; }
    last = t;
    if (!(window.__bench && window.__bench.done && window.__bench.stopFrames)) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  // Avatar latency: time from avatars being set until Dusk marked all 50.
  const poll = setInterval(() => {
    const b = window.__bench;
    if (!b || !b.avatarsSetAt) return;
    if (performance.now() < b.avatarsSetAt) return;
    if (document.querySelectorAll(".row .ph[data-dusk-bg]").length === 50) {
      b.avatarsMarked = performance.now() - b.avatarsSetAt;
      clearInterval(poll);
    }
  }, 8);
  const me = setInterval(() => {
    const el = document.getElementById("me");
    if (el && el.classList.contains("loaded") && !window.__meLoadedAt) window.__meLoadedAt = performance.now();
    if (el && el.hasAttribute("data-dusk-bg")) { window.__meMarked = performance.now() - (window.__meLoadedAt || 0); clearInterval(me); }
  }, 8);
}

const SCENARIOS = {
  heavy: { html: () => heavy({ storm: false }) },
  storm: { html: () => heavy({ storm: true }) },
  article: { html: () => article() },
  scroll: { html: () => heavy({ storm: false }), scroll: true, conditions: ["none", "on"] },
};

async function runOnce(browser, scenario, condition) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  const html = scenario.html();
  await page.route("**/*", (r) => {
    const u = new URL(r.request().url());
    if (u.origin === ORIGIN && u.pathname === "/") return r.fulfill({ status: 200, contentType: "text/html", body: html });
    return r.fulfill({ status: 404, body: "" });
  });
  await page.addInitScript(probe);
  if (condition !== "none") {
    const settings = condition === "off" ? { siteModes: { "bench.test": "off" } } : {};
    await page.addInitScript(stubApi, { initial: settings });
    await page.addInitScript(injectCss, CSS);
    await page.addInitScript({ content: instrumented() });
  }
  await page.goto(ORIGIN + "/", { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => window.__bench && window.__bench.done, null, { timeout: 60000, polling: 50 });

  let scroll = null;
  if (scenario.scroll) {
    await page.waitForTimeout(1500); // let the scanner finish
    scroll = await page.evaluate(() => new Promise((res) => {
      const gaps = []; let last = 0; const t0 = performance.now();
      function step(t) {
        if (last) gaps.push(t - last);
        last = t;
        window.scrollBy(0, 40);
        if (t - t0 < 2000) requestAnimationFrame(step);
        else {
          gaps.sort((a, b) => a - b);
          res({ avg: gaps.reduce((a, b) => a + b, 0) / gaps.length, p95: gaps[Math.floor(gaps.length * 0.95)], max: gaps[gaps.length - 1] });
        }
      }
      requestAnimationFrame(step);
    }));
  }

  // Cost of one full-document style recalculation (selector matching for
  // every element), forced by toggling a class on <body> that no rule uses
  // except a universal one. Median of 7.
  const recalc = await page.evaluate(() => {
    const st = document.createElement("style");
    st.textContent = "body.__x * { --bench: 1; }";
    document.head.appendChild(st);
    const last = document.body.lastElementChild;
    const ts = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      document.body.classList.toggle("__x");
      getComputedStyle(last).getPropertyValue("--bench");
      ts.push(performance.now() - t0);
    }
    st.remove();
    ts.sort((a, b) => a - b);
    return ts[3];
  });

  const debugNow = await page.evaluate(() => (window.__duskDebug ? window.__duskDebug() : null));
  await page.waitForTimeout(1500);
  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const b = window.__bench || {};
    const dp = window.__dp;
    return {
      dcl: nav.domContentLoadedEventEnd,
      load: nav.loadEventEnd,
      worstFrame: window.__frames.worst,
      over50: window.__frames.over50,
      overlay: b.overlayRendered ?? null,
      avatarsMarked: b.avatarsMarked ?? null,
      meMarked: window.__meMarked ?? null,
      duskTotal: dp ? dp.total : 0,
      dusk: dp ? { t: dp.t, n: dp.n, max: dp.max, moRecords: dp.moRecords, moCalls: dp.moCalls } : null,
      retainedLater: window.__duskDebug ? window.__duskDebug() : null,
      elements: document.getElementsByTagName("*").length,
      marked: document.querySelectorAll("[data-dusk-bg]").length,
    };
  });
  m.retainedNow = debugNow;
  m.recalc = recalc;
  m.scroll = scroll;
  await ctx.close();
  return m;
}

const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const fmt = (x, d = 1) => (x === null || x === undefined ? "-" : Number(x).toFixed(d));

(async () => {
  const browser = await webkit.launch();
  const results = {};
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    if (ONLY && !ONLY.split(",").includes(name)) continue;
    for (const cond of sc.conditions || ["none", "on", "off"]) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) runs.push(await runOnce(browser, sc, cond));
      const pick = (f) => median(runs.map(f));
      const keys = new Set(runs.flatMap((r) => (r.dusk ? Object.keys(r.dusk.t) : [])));
      const breakdown = {};
      for (const k of keys) breakdown[k] = { ms: pick((r) => r.dusk.t[k] || 0), calls: pick((r) => r.dusk.n[k] || 0), maxMs: pick((r) => r.dusk.max[k] || 0) };
      results[`${name}/${cond}`] = {
        dcl: pick((r) => r.dcl), load: pick((r) => r.load),
        worstFrame: pick((r) => r.worstFrame), over50: pick((r) => r.over50),
        overlay: pick((r) => r.overlay), avatarsMarked: pick((r) => r.avatarsMarked), meMarked: pick((r) => r.meMarked),
        duskTotal: pick((r) => r.duskTotal), recalc: pick((r) => r.recalc),
        moRecords: pick((r) => (r.dusk ? r.dusk.moRecords : 0)),
        retainedNow: runs[0].retainedNow, retainedLater: runs[0].retainedLater,
        elements: pick((r) => r.elements), marked: pick((r) => r.marked),
        scroll: sc.scroll ? { avg: pick((r) => r.scroll.avg), p95: pick((r) => r.scroll.p95), max: pick((r) => r.scroll.max) } : undefined,
        breakdown,
      };
      process.stderr.write(`done ${name}/${cond}\n`);
    }
  }
  await browser.close();

  console.log(`\nMedian of ${RUNS} runs, WebKit headless. Times in ms.`);
  console.log("scenario/cond     DCL    load  worstFrm >50ms overlay avatars  me   duskTotal recalc moRecs  marked  retained(now->later)");
  for (const [k, r] of Object.entries(results)) {
    const ret = (d) => (d ? `${d.queue ?? "?"}q/${d.recheck ?? "?"}r det ${(d.queueDetached ?? 0) + (d.recheckDetached ?? 0)}` : "-");
    console.log(
      k.padEnd(16),
      fmt(r.dcl).padStart(6), fmt(r.load).padStart(7), fmt(r.worstFrame).padStart(8), String(r.over50 ?? "-").padStart(5),
      fmt(r.overlay).padStart(7), fmt(r.avatarsMarked).padStart(7), fmt(r.meMarked).padStart(5),
      fmt(r.duskTotal).padStart(10), fmt(r.recalc).padStart(6), String(r.moRecords ?? "-").padStart(7), String(r.marked ?? "-").padStart(7),
      `  ${ret(r.retainedNow)} -> ${ret(r.retainedLater)}`,
    );
    if (r.scroll) console.log(" ".repeat(17), `scroll frame gap avg ${fmt(r.scroll.avg)} p95 ${fmt(r.scroll.p95)} max ${fmt(r.scroll.max)}`);
  }
  console.log("\nDusk breakdown (median ms / calls / worst single call):");
  for (const [k, r] of Object.entries(results)) {
    if (!r.breakdown || !Object.keys(r.breakdown).length) continue;
    console.log(" ", k, Object.entries(r.breakdown).map(([f, v]) => `${f} ${fmt(v.ms)}/${v.calls}/${fmt(v.maxMs)}`).join(", "));
  }
  if (LABEL) fs.writeFileSync(path.join(__dirname, `results-${LABEL}.json`), JSON.stringify(results, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
