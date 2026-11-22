// @ts-check
// Performance contracts: Dusk must not delay the page, must do nothing when
// it is off for a site, and must hold no DOM references while a tab is hidden.
// Timing-heavy numbers live in `npm run perf`; these tests pin the behaviour.
const { test, expect } = require("@playwright/test");
const { openPage, settle, setSettings, duskState, HOST } = require("../helpers");

const IMG = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
const doc = (css, body, script = "") =>
  `<!doctype html><html><head><style>body{margin:0;background:#fff}${css}</style></head><body>${body}<script>${script}</script></body></html>`;

// Counts layout-forcing probes Dusk makes, and when.
const countProbes = () => {
  window.__efp = 0;
  const orig = Document.prototype.elementFromPoint;
  Document.prototype.elementFromPoint = function (...a) { window.__efp++; return orig.apply(this, a); };
};

const marked = (page, sel) => page.evaluate((s) => document.querySelector(s).hasAttribute("data-dusk-bg"), sel);
const frames = (page, n) => page.evaluate((n) => new Promise((r) => {
  let i = 0; (function f() { if (++i > n) r(); else requestAnimationFrame(f); })();
}), n);

test("off for this site: no dark-site check at all (no forced layout)", async ({ page }) => {
  await page.addInitScript(countProbes);
  await openPage(page, { settings: { siteModes: { [HOST]: "off" } } });
  await frames(page, 4);
  expect(await duskState(page)).toBe("site-off");
  expect(await page.evaluate(() => window.__efp)).toBe(0);
});

test("disabled: no dark-site check and no scanner", async ({ page }) => {
  await page.addInitScript(countProbes);
  await openPage(page, { settings: { enabled: false }, html: doc(`.a{width:40px;height:40px;background-image:url(${IMG})}`, '<div class="a" id="a"></div>') });
  await frames(page, 6);
  expect(await page.evaluate(() => window.__efp)).toBe(0);
  expect(await marked(page, "#a")).toBe(false);
});

test("dark check runs after the page's own DOMContentLoaded handlers, not inside them", async ({ page }) => {
  await page.addInitScript(countProbes);
  const script = `document.addEventListener("DOMContentLoaded", () => { window.__efpAtDCL = window.__efp; });`;
  await openPage(page, { html: doc("", "<p>hi</p>", script) });
  await frames(page, 4);
  expect(await page.evaluate(() => window.__efpAtDCL)).toBe(0); // nothing forced before the page's handlers
  expect(await page.evaluate(() => window.__efp)).toBeGreaterThan(0); // but it did run
});

test("switching an Off site back to Auto runs the dark check then", async ({ page }) => {
  await openPage(page, { settings: { siteModes: { [HOST]: "off" } }, html: doc("html,body{background:#111}", "<p>dark</p>") });
  expect(await duskState(page)).toBe("site-off");
  await setSettings(page, { siteModes: {} });
  await frames(page, 3);
  expect(await duskState(page)).toBe("already-dark");
});

// Any change to <html> while the filter is on can restyle the whole page in
// WebKit (about 60 ms on MDN). Dark-site checks run at DOMContentLoaded,
// 0.3/0.8/1.6 s and load: a handful while a page loads, never every frame.
const recordRootChanges = (page) => page.addInitScript(() => {
  window.__rootChanges = [];
  let applied = false; // everything after Dusk's first apply is recorded
  // Watches the document, not <html>: the parser may create <html> later.
  new MutationObserver((recs) => {
    for (const r of recs) {
      if (r.target !== document.documentElement) continue;
      if (applied) window.__rootChanges.push(r.attributeName);
      else if (r.attributeName === "data-dusk") applied = true;
    }
  }).observe(document, { attributes: true, subtree: true });
});

test("a slow-loading page is checked a handful of times, not every frame", async ({ page }) => {
  await recordRootChanges(page);
  // Light page whose only background is on <html>, so every check reads it.
  await openPage(page, { html: doc("html{background:#fff} body{margin:0}", "<p>light</p><img src=/slow.png>"), slow: { "/slow.png": 2000 } });
  expect(await duskState(page)).toBe("active");
  const changes = await page.evaluate(() => window.__rootChanges.length);
  expect(changes).toBeLessThanOrEqual(2 * 6); // set + remove, at most 6 checks
});

test("a page that paints its own background is checked without touching <html>", async ({ page }) => {
  await recordRootChanges(page);
  await openPage(page, { html: doc("body{margin:0;min-height:100vh;background:#fff}", "<p>light</p>") });
  expect(await duskState(page)).toBe("active");
  expect(await page.evaluate(() => window.__rootChanges)).toEqual([]);
});

test("the page's own <html> background is still what detection reads", async ({ page }) => {
  await openPage(page, { html: doc("html{background:rgb(17,17,17)} body{margin:0}", "<p>dark</p>") });
  expect(await duskState(page)).toBe("already-dark");
});

test.describe("hidden tabs", () => {
  const setHidden = (page, hidden) => page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);

  test("hidden: nodes added are not scanned and not referenced; shown: caught up", async ({ page }) => {
    await openPage(page, { html: doc(`.a{width:40px;height:40px;background-image:url(${IMG})}`, '<div id="root"></div>') });
    await frames(page, 4);
    await setHidden(page, true);
    await page.evaluate(() => {
      for (let i = 0; i < 50; i++) { const d = document.createElement("div"); d.className = "a"; d.id = "h" + i; document.getElementById("root").appendChild(d); }
    });
    await frames(page, 6);
    expect(await marked(page, "#h0")).toBe(false); // nothing ran while hidden
    await setHidden(page, false);
    await page.waitForFunction(() => document.querySelectorAll("[data-dusk-bg]").length === 50, null, { timeout: 3000 });
  });
});

test.describe("mutation storms", () => {
  test("an element flipping its background every frame is not marked until it settles", async ({ page }) => {
    await openPage(page, { html: doc(`.a{width:40px;height:40px}.a.on{background-image:url(${IMG})}`, '<div class="a" id="f"></div>') });
    await frames(page, 3);
    const flips = await page.evaluate(async () => {
      const el = document.getElementById("f");
      let markedWhileFlipping = 0;
      for (let i = 0; i < 30; i++) {
        el.classList.toggle("on");
        await new Promise((r) => requestAnimationFrame(r));
        if (el.hasAttribute("data-dusk-bg")) markedWhileFlipping++;
      }
      el.classList.add("on"); // settle with the image
      return markedWhileFlipping;
    });
    expect(flips).toBe(0);
    await page.waitForFunction(() => document.getElementById("f").hasAttribute("data-dusk-bg"), null, { timeout: 2000 });
  });

  test("a lazy avatar that gets its photo once is marked within ~250 ms", async ({ page }) => {
    await openPage(page, { html: doc(`.ph{width:40px;height:40px;border-radius:50%;background:#ccc}.ph.loaded{background-image:url(${IMG})}`, '<div class="ph" id="p"></div>') });
    await frames(page, 3);
    const ms = await page.evaluate(() => new Promise((res) => {
      const el = document.getElementById("p");
      const t0 = performance.now();
      el.classList.add("loaded");
      (function f() { if (el.hasAttribute("data-dusk-bg")) res(performance.now() - t0); else requestAnimationFrame(f); })();
    }));
    expect(ms).toBeLessThan(250);
  });
});

// Software filters on every re-inverted image made scrolling stutter: on a
// page with 200 photos, p95 frame 41 ms and 3.4x the CPU of no Dusk. With
// will-change: filter WebKit composites them on the GPU: p95 17-18 ms, about
// 1.2x (no memory growth with 3,000 icons). Kept as a contract.
test("re-inverted media is GPU-composited (will-change: filter)", async ({ page }) => {
  const IMG2 = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
  await openPage(page, { html: doc(`.bg{width:40px;height:40px;background-image:url(${IMG2})}`,
    `<img id="i" src="${IMG2}" width=20 height=20><video id="v"></video><canvas id="c"></canvas><div class="bg" id="b"></div><div id="host"></div>`,
    `document.getElementById("host").attachShadow({mode:"open"}).innerHTML='<img id="si" src="${IMG2}" width=20 height=20>';`) });
  await page.waitForFunction(() => document.getElementById("b").hasAttribute("data-dusk-bg"), null, { timeout: 5000 });
  await page.waitForTimeout(200);
  const wc = await page.evaluate(() => {
    const w = (el) => getComputedStyle(el).willChange;
    return { img: w(document.getElementById("i")), video: w(document.getElementById("v")), canvas: w(document.getElementById("c")), bg: w(document.getElementById("b")),
      shadow: w(document.getElementById("host").shadowRoot.getElementById("si")) };
  });
  expect(wc).toEqual({ img: "filter", video: "filter", canvas: "filter", bg: "filter", shadow: "filter" });
});

test("Dusk off: no will-change left on media", async ({ page }) => {
  await openPage(page, { settings: { enabled: false }, html: doc("", `<img id="i" width=20 height=20>`) });
  expect(await page.evaluate(() => getComputedStyle(document.getElementById("i")).willChange)).toBe("auto");
});
