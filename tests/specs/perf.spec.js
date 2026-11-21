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

test("measuring <html> restyles only <html>, not the page", async ({ page }) => {
  await openPage(page);
  // An attribute that only <html> rules use must not invalidate descendants:
  // check that the measure rule is the only one mentioning data-dusk-measure
  // and that it targets html itself.
  const rules = await page.evaluate(() => {
    const out = [];
    for (const sheet of document.styleSheets) {
      try { for (const r of sheet.cssRules) if (r.selectorText && r.selectorText.includes("data-dusk-measure")) out.push(r.selectorText); } catch {}
    }
    return out;
  });
  expect(rules).toEqual(['html[data-dusk]:not([data-dusk-measure])']);
  // And it really reads the page's own <html> background while Dusk is on.
  await page.evaluate(() => { document.documentElement.style.background = "rgb(17, 17, 17)"; });
  const own = await page.evaluate(() => {
    const de = document.documentElement;
    de.setAttribute("data-dusk-measure", "");
    const c = getComputedStyle(de).backgroundColor;
    de.removeAttribute("data-dusk-measure");
    return [c, getComputedStyle(de).backgroundColor];
  });
  expect(own[0]).toBe("rgb(17, 17, 17)");
  expect(own[1]).toBe("rgb(255, 255, 255)");
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
