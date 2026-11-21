// Visual QA on real sites: loads public pages in WebKit with Dusk injected
// the way Safari does, screenshots them with Dusk on (100%), off, and on
// (90%), and flags rendering defects by measuring real pixels.
//
//   npm run visual                    all sites
//   npm run visual -- reddit linkedin only sites whose name contains a filter
//   VISUAL_OUT=/some/dir npm run visual
//
// Uses the real network. Never logs in, clicks or submits anything.
const fs = require("fs");
const path = require("path");
const { webkit } = require("@playwright/test");
const { PNG } = require("pngjs");
const { stubApi } = require("../helpers");
const SITES = require("./sites");

const EXT = process.env.DUSK_EXT || path.resolve(__dirname, "..", "..", "extension");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
const JS_RAW = fs.readFileSync(path.join(EXT, "content.js"), "utf8");
const CSS = (MANIFEST.content_scripts || []).flatMap((c) => c.css || [])
  .map((f) => fs.readFileSync(path.join(EXT, f), "utf8")).join("\n");
// Instrumented copy of content.js: records time spent inside Dusk's own
// callbacks (scanner slices, dark check, render, mutation observer) in
// window.__duskCost. Set DUSK_RAW=1 to inject the unmodified file.
function instrument(src) {
  const cost = "(window.__duskCost ||= { ms: 0, max: 0, calls: 0, byFn: {} })";
  const tail = (name) => `const d = performance.now() - __t0; __c.ms += d; __c.calls++; __c.max = Math.max(__c.max, d); __c.byFn.${name} = (__c.byFn.${name} || 0) + d; __c.maxFn ||= {}; __c.maxFn.${name} = Math.max(__c.maxFn.${name} || 0, d);`;
  let out = src;
  for (const name of ["bgSlice", "checkDark", "render"]) {
    const head = `function ${name}() {`;
    if (out.includes(head)) {
      out = out.replace(head, `function ${name}() { const __c = ${cost}; const __t0 = performance.now(); try { return __${name}.apply(this, arguments); } finally { ${tail(name)} } }\n  function __${name}() {`);
    }
  }
  // Time mutation observer callbacks with a block-scoped wrapper class, so
  // page scripts keep the real MutationObserver.
  const MO = `class extends window.MutationObserver { constructor(cb) { super(function (records, o) { const __c = ${cost}; const __t0 = performance.now(); try { return cb.call(this, records, o); } finally { ${tail("observer")} } }); } }`;
  return `{ const MutationObserver = ${MO};\n${out}\n}`;
}
const JS = process.env.DUSK_RAW ? JS_RAW : instrument(JS_RAW);
const OUT = process.env.VISUAL_OUT || path.join(__dirname, "out");
const VIEWPORT = { width: 1280, height: 900 };
const CONCURRENCY = Number(process.env.VISUAL_JOBS || 4);

function injectCss(css) {
  const add = () => {
    const s = document.createElement("style");
    s.dataset.duskTest = "css";
    s.textContent = css;
    document.documentElement.prepend(s);
  };
  if (document.documentElement) add();
  else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); add(); } })
    .observe(document, { childList: true });
}

// Runs in the page: what is on screen, with element descriptions.
function collect() {
  const vw = innerWidth, vh = innerHeight;
  const MEDIA = "img, picture, video, canvas, svg image, iframe, embed, object";
  const desc = (el) => {
    if (!el || el.nodeType !== 1) return "?";
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const cls = (typeof el.className === "string" ? el.className : el.getAttribute("class") || "")
      .trim().split(/\s+/).filter(Boolean).slice(0, 3);
    if (cls.length) s += "." + cls.join(".");
    return s.slice(0, 90);
  };
  const path = (el) => {
    const parts = [];
    for (let e = el, i = 0; e && e.nodeType === 1 && i < 4; e = e.parentElement, i++) parts.unshift(desc(e));
    return parts.join(" > ");
  };
  const visible = (el, r) => {
    if (r.width < 12 || r.height < 12) return false;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && Number(cs.opacity) > 0.05 && cs.display !== "none";
  };
  const box = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });

  const images = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(MEDIA + ", [data-dusk-bg]")) {
    if (seen.has(el) || images.length >= 200) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const cs = getComputedStyle(el);
    const bg = cs.backgroundImage.match(/url\(["']?([^"')]+)/);
    const src = el.currentSrc || el.src || el.getAttribute("href") || (bg && bg[1]) || "";
    images.push({
      kind: el.hasAttribute("data-dusk-bg") && !el.matches(MEDIA) ? "bg" : el.tagName.toLowerCase(),
      marked: el.hasAttribute("data-dusk-bg"),
      svg: /\.svg(\?|#|$)|^data:image\/svg/i.test(src),
      src: src.slice(0, 120),
      filter: cs.filter.slice(0, 80),
      path: path(el),
      text: (el.textContent || "").trim().length,
      ...box(r),
    });
  }

  // Text samples: rect of the text node itself, not its box.
  const texts = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  const all = [];
  for (let n = walker.nextNode(); n && all.length < 4000; n = walker.nextNode()) {
    if (n.data.trim().length < 3) continue;
    const el = n.parentElement;
    if (!el || el.closest("script,style,noscript,svg")) continue;
    all.push(n);
  }
  const step = Math.max(1, Math.floor(all.length / 150));
  for (let i = 0; i < all.length && texts.length < 150; i += step) {
    const n = all[i];
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getClientRects()[0];
    if (!r || r.width < 8 || r.height < 6 || r.bottom <= 0 || r.top >= vh || r.left >= vw || r.right <= 0) continue;
    const el = n.parentElement;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || Number(cs.opacity) < 0.3) continue;
    texts.push({
      text: n.data.trim().slice(0, 40),
      color: cs.color,
      size: cs.fontSize,
      inMarked: !!el.closest("[data-dusk-bg]"),
      inMedia: !!el.closest("picture,video,iframe,object,embed"),
      path: path(el),
      ...box(r),
    });
  }

  // What sits under each 32px cell.
  const CELL = 32;
  const grid = [];
  const ids = new Map();
  const table = [];
  for (let y = CELL / 2; y < vh; y += CELL) {
    for (let x = CELL / 2; x < vw; x += CELL) {
      const el = document.elementFromPoint(x, y);
      if (!el) { grid.push(-1); continue; }
      if (!ids.has(el)) {
        ids.set(el, table.length);
        const own = Array.from(el.childNodes).some((c) => c.nodeType === 3 && c.data.trim());
        table.push({
          path: path(el),
          media: !!el.closest(MEDIA) || el.matches(MEDIA),
          marked: !!el.closest("[data-dusk-bg]"),
          text: own,
          shadow: !!el.shadowRoot,
        });
      }
      grid.push(ids.get(el));
    }
  }
  const shadowHosts = Array.from(document.querySelectorAll("*")).filter((e) => e.shadowRoot).length;
  return { images, texts, grid, table, cell: CELL, shadowHosts, marked: document.querySelectorAll("[data-dusk-bg]").length };
}

// ---------- pixel analysis ----------
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lumOf = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

function img(buf) {
  const p = PNG.sync.read(buf);
  return {
    w: p.width, h: p.height,
    px(x, y) {
      x = Math.min(p.width - 1, Math.max(0, Math.round(x)));
      y = Math.min(p.height - 1, Math.max(0, Math.round(y)));
      const i = (y * p.width + x) * 4;
      return [p.data[i], p.data[i + 1], p.data[i + 2]];
    },
  };
}

function clip(b, I) {
  const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y);
  const x1 = Math.min(I.w, b.x + b.w), y1 = Math.min(I.h, b.y + b.h);
  return x1 - x0 >= 6 && y1 - y0 >= 6 ? { x0, y0, x1, y1 } : null;
}

function samples(I, c, n = 16, inset = 0.1) {
  const out = [];
  const dx = (c.x1 - c.x0), dy = (c.y1 - c.y0);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    out.push(I.px(c.x0 + dx * (inset + (1 - 2 * inset) * (i + 0.5) / n), c.y0 + dy * (inset + (1 - 2 * inset) * (j + 0.5) / n)));
  }
  return out;
}

function ring(I, c, gap = 3) {
  const out = [];
  const xs = 24;
  for (let i = 0; i < xs; i++) {
    const x = c.x0 + (c.x1 - c.x0) * (i + 0.5) / xs;
    const y = c.y0 + (c.y1 - c.y0) * (i + 0.5) / xs;
    out.push(I.px(x, c.y0 - gap), I.px(x, c.y1 + gap), I.px(c.x0 - gap, y), I.px(c.x1 + gap, y));
  }
  return out;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);

function corr(a, b) {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da < 1e-6 || db < 1e-6 ? null : n / Math.sqrt(da * db);
}

// Strongest contrast inside a region against a reference luminance (98th pct).
function peakContrast(pixels, refL) {
  const r = pixels.map((p) => ratio(lumOf(...p), refL)).sort((a, b) => a - b);
  return r[Math.floor(r.length * 0.98)] || 1;
}

function analyze(site, info, on, off, on90, state) {
  const defects = [];
  const area = (on.w * on.h) || 1;

  // 1. Images: should look the same with Dusk on as off.
  for (const m of info.images) {
    const c = clip(m, on);
    if (!c) continue;
    const a = samples(on, c), b = samples(off, c);
    const diff = mean(a.map((p, i) => (Math.abs(p[0] - b[i][0]) + Math.abs(p[1] - b[i][1]) + Math.abs(p[2] - b[i][2])) / 3));
    const invDiff = mean(a.map((p, i) => (Math.abs(p[0] - (255 - b[i][0])) + Math.abs(p[1] - (255 - b[i][1])) + Math.abs(p[2] - (255 - b[i][2]))) / 3));
    const la = a.map((p) => lumOf(...p)), lb = b.map((p) => lumOf(...p));
    const k = corr(la, lb);
    let verdict = null;
    // Transparent images (icons, logos) show the page through: only judge
    // opaque ones for inversion, judge the rest by legibility.
    const rOn = ring(on, c), rOff = ring(off, c);
    const ringOff = [0, 1, 2].map((ch) => median(rOff.map((p) => p[ch])));
    const opaque = b.filter((p) => Math.abs(p[0] - ringOff[0]) + Math.abs(p[1] - ringOff[1]) + Math.abs(p[2] - ringOff[2]) > 60).length / b.length;
    if (opaque >= 0.6) {
      if (diff > 35 && invDiff < diff * 0.6) verdict = "INVERTED";
      else if (diff > 35 && k !== null && k < 0) verdict = "INVERTED";
      else if (diff > 45) verdict = "CHANGED";
    }
    const bgOn = median(rOn.map((p) => lumOf(...p))), bgOff = median(rOff.map((p) => lumOf(...p)));
    const cOn = peakContrast(a, bgOn), cOff = peakContrast(b, bgOff);
    if (!verdict && opaque < 0.6 && cOff >= 3 && cOn < 2) verdict = "VANISHED";
    if (verdict) defects.push({ check: "image", verdict, opaque: +opaque.toFixed(2), diff: +diff.toFixed(1), invDiff: +invDiff.toFixed(1), corr: k && +k.toFixed(2), contrastOff: +cOff.toFixed(2), contrastOn: +cOn.toFixed(2), ...m });
  }

  // 2. Text contrast: rendered pixels, Dusk on vs off.
  for (const t of info.texts) {
    const c = clip(t, on);
    if (!c) continue;
    const a = samples(on, c, 24, 0), b = samples(off, c, 24, 0);
    const bgOn = median(a.map((p) => lumOf(...p))), bgOff = median(b.map((p) => lumOf(...p)));
    const cOn = peakContrast(a, bgOn), cOff = peakContrast(b, bgOff);
    const bad = (cOn < 4.5 && cOff >= 4.5 && cOn < cOff * 0.7) || (cOn < 2.5 && cOff >= 3.5);
    if (bad) defects.push({ check: "text", verdict: "LOW-CONTRAST", contrastOff: +cOff.toFixed(2), contrastOn: +cOn.toFixed(2), bgOnL: +bgOn.toFixed(3), ...t });
  }

  // 3. Light patches left on a darkened page (not media, which is meant to stay natural).
  const patches = new Map();
  if (state === "active" || state === "forced") {
    const cols = Math.ceil(on.w / info.cell);
    info.grid.forEach((id, i) => {
      if (id < 0) return;
      const el = info.table[id];
      if (el.media || el.marked && !el.text) return;
      const cx = (i % cols) * info.cell + info.cell / 2, cy = Math.floor(i / cols) * info.cell + info.cell / 2;
      const p = samples(on, { x0: cx - 12, y0: cy - 12, x1: cx + 12, y1: cy + 12 }, 4, 0);
      const L = median(p.map((q) => lumOf(...q)));
      if (L > 0.45) {
        const e = patches.get(id) || { cells: 0, L: 0, ...el };
        e.cells++; e.L = Math.max(e.L, L);
        patches.set(id, e);
      }
    });
  }
  for (const p of patches.values()) {
    if (p.cells >= 3) defects.push({ check: "patch", verdict: p.marked ? "LIGHT-MARKED" : "LIGHT", areaPx: p.cells * info.cell * info.cell, maxL: +p.L.toFixed(2), path: p.path, text: p.text, marked: p.marked });
  }

  // 4. Dark-site handling.
  const pageL = (I) => mean(samples(I, { x0: 0, y0: 0, x1: I.w, y1: I.h }, 40, 0).map((p) => lumOf(...p)));
  const Loff = pageL(off), Lon = pageL(on), Lon90 = pageL(on90);
  if (site.dark && (state === "active")) defects.push({ check: "dark-site", verdict: "DARK-SITE-INVERTED", Loff: +Loff.toFixed(3), Lon: +Lon.toFixed(3) });
  if (!site.dark && state === "already-dark" && Loff > 0.35) defects.push({ check: "dark-site", verdict: "LIGHT-SITE-SKIPPED", Loff: +Loff.toFixed(3) });
  return { defects, Loff, Lon, Lon90, area };
}

// ---------- runner ----------
async function navTiming(page) {
  return page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    return n ? { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) } : null;
  }).catch(() => null);
}

async function frameGaps(page, ms = 2000) {
  return page.evaluate((ms) => new Promise((res) => {
    let last = performance.now(), worst = 0, frames = 0;
    const t0 = last;
    (function f() {
      const t = performance.now(); worst = Math.max(worst, t - last); last = t; frames++;
      if (t - t0 < ms) requestAnimationFrame(f); else res({ worst: Math.round(worst), fps: Math.round(frames / (ms / 1000)) });
    })();
  }), ms).catch(() => null);
}

async function goto(page, url) {
  try { await page.goto(url, { waitUntil: "load", timeout: 40000 }); return "load"; }
  catch { try { await page.waitForLoadState("domcontentloaded", { timeout: 5000 }); return "dcl"; } catch { return "timeout"; } }
}

async function runSite(browser, site) {
  const base = { viewport: VIEWPORT, bypassCSP: true, colorScheme: site.scheme || "light", locale: "en-US" };
  const result = { name: site.name, url: site.url };
  try {
    // Plain load for timing.
    const plainCtx = await browser.newContext(base);
    const plain = await plainCtx.newPage();
    result.plainNav = await goto(plain, site.url);
    result.plainTiming = await navTiming(plain);
    await plain.waitForTimeout(1500);
    result.plainFrames = await frameGaps(plain);
    await plainCtx.close();

    const ctx = await browser.newContext(base);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => { if (/dusk|content\.js/i.test(String(e.stack || e))) errors.push(String(e)); });
    await page.addInitScript(stubApi, { initial: { intensity: 100 } });
    await page.addInitScript(injectCss, CSS);
    await page.addInitScript({ content: JS });
    result.nav = await goto(page, site.url);
    result.timing = await navTiming(page);
    await page.waitForTimeout(1500);
    result.frames = await frameGaps(page);
    await page.waitForTimeout(1500);
    await page.waitForFunction(() => typeof window.__duskSet === "function", null, { timeout: 15000 }).catch(() => {});
    result.finalUrl = page.url();
    result.cost = await page.evaluate(() => window.__duskCost && { ms: Math.round(window.__duskCost.ms), max: Math.round(window.__duskCost.max), calls: window.__duskCost.calls, byFn: Object.fromEntries(Object.entries(window.__duskCost.byFn).map(([k, v]) => [k, Math.round(v)])), maxFn: Object.fromEntries(Object.entries(window.__duskCost.maxFn || {}).map(([k, v]) => [k, Math.round(v)])) }).catch(() => null);
    result.state = await page.evaluate(() => window.__duskSend({ type: "dusk:state" })).then((r) => r && r.state).catch(() => "no-response");
    const info = await page.evaluate(collect);
    result.shadowHosts = info.shadowHosts;
    result.marked = info.marked;
    result.images = info.images.length;
    const shot = () => page.screenshot({ animations: "disabled", timeout: 20000 });
    const onBuf = await shot();
    await page.evaluate(() => window.__duskSet({ enabled: false }));
    await page.waitForTimeout(500);
    const offBuf = await shot();
    await page.evaluate(() => window.__duskSet({ enabled: true, intensity: 90 }));
    await page.waitForTimeout(1500);
    const on90Buf = await shot();
    for (const [k, b] of [["on100", onBuf], ["off", offBuf], ["on90", on90Buf]]) fs.writeFileSync(path.join(OUT, `${site.name}.${k}.png`), b);
    const a = analyze(site, info, img(onBuf), img(offBuf), img(on90Buf), result.state);
    Object.assign(result, { defects: a.defects, Loff: +a.Loff.toFixed(3), Lon: +a.Lon.toFixed(3), Lon90: +a.Lon90.toFixed(3), duskErrors: errors });
    fs.writeFileSync(path.join(OUT, `${site.name}.info.json`), JSON.stringify(info, null, 1));
    await ctx.close();
  } catch (e) {
    result.error = String(e).slice(0, 300);
  }
  return result;
}

module.exports = { collect, analyze, img, injectCss, instrument, JS, CSS, OUT, lumOf, ratio, samples, median, mean, clip, ring, peakContrast, frameGaps };

if (require.main === module) (async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const filters = process.argv.slice(2);
  const sites = filters.length ? SITES.filter((s) => filters.some((f) => s.name.includes(f))) : SITES;
  const browser = await webkit.launch();
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sites.length) }, async () => {
    while (next < sites.length) {
      const site = sites[next++];
      const r = await runSite(browser, site);
      results.push(r);
      const counts = {};
      for (const d of r.defects || []) counts[d.verdict] = (counts[d.verdict] || 0) + 1;
      console.log(`${r.name.padEnd(24)} ${String(r.state).padEnd(13)} L off/on ${r.Loff}/${r.Lon}  marked ${r.marked ?? "-"}  shadow ${r.shadowHosts ?? "-"}  ${JSON.stringify(counts)}  cost ${r.cost ? r.cost.ms + "ms max " + r.cost.max + "ms" : "-"}${r.error ? "  ERROR " + r.error : ""}`);
    }
  }));
  await browser.close();
  results.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 1));
  console.log(`\nResults: ${path.join(OUT, "results.json")}`);
})();
