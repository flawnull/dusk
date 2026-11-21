// @ts-check
// Idle-time scanner that marks stylesheet background images with data-dusk-bg.
const { test, expect } = require("@playwright/test");
const { openPage, settle, setSettings, duskState } = require("../helpers");

const IMG = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";

const doc = (css, body) =>
  `<!doctype html><html><head><style>body{margin:0;background:#fff}${css}</style></head><body>${body}</body></html>`;

// Waits until the scanner has finished (no change in marked count for a while).
async function scanDone(page, ms = 2500) {
  await page.evaluate(async (limit) => {
    const t0 = performance.now();
    let last = -1, stable = 0;
    while (performance.now() - t0 < limit) {
      await new Promise((r) => setTimeout(r, 60));
      const n = document.querySelectorAll("[data-dusk-bg]").length;
      if (n === last) { if (++stable >= 4) return; } else { stable = 0; last = n; }
    }
  }, ms);
}

const marked = (page, sel) => page.evaluate((s) => document.querySelector(s).hasAttribute("data-dusk-bg"), sel);
const filterOf = (page, sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).filter, sel);
const REINVERT = /^invert\(1\) contrast\([\d.]+\) hue-rotate\(180deg\)$/;

test("stylesheet (class-based) bg image gets marked and re-inverted", async ({ page }) => {
  await openPage(page, { html: doc(`.hero{width:200px;height:100px;background-image:url(${IMG})}`, '<div class="hero" id="h"></div>') });
  await scanDone(page);
  expect(await marked(page, "#h")).toBe(true);
  expect(await filterOf(page, "#h")).toMatch(REINVERT);
});

test("inline background-image is still re-inverted", async ({ page }) => {
  await openPage(page, { html: doc("", `<div id="i" style="width:50px;height:50px;background-image:url(${IMG})"></div>`) });
  await scanDone(page); // marked by the scanner since 1.2, not by a selector
  expect(await filterOf(page, "#i")).toMatch(REINVERT);
});

test("inline `background:` shorthand with url() gets marked by the scanner", async ({ page }) => {
  await openPage(page, { html: doc("", `<div id="i" style="width:50px;height:50px;background:url(${IMG})"></div>`) });
  await scanDone(page);
  expect(await filterOf(page, "#i")).toMatch(REINVERT);
});

test("full-viewport wallpaper is NOT marked", async ({ page }) => {
  await openPage(page, { html: doc(`#w{position:fixed;inset:0;background-image:url(${IMG})}`, '<div id="w"></div>') });
  await scanDone(page);
  expect(await marked(page, "#w")).toBe(false);
});

test("bg image on <body> is NOT marked", async ({ page }) => {
  await openPage(page, { html: doc(`body{background-image:url(${IMG})}`, "<p>x</p>") });
  await scanDone(page);
  expect(await page.evaluate(() => document.body.hasAttribute("data-dusk-bg"))).toBe(false);
});

test("nested bg inside a bg, and media inside a bg, are not double-flipped", async ({ page }) => {
  await openPage(page, {
    html: doc(`.a{width:300px;height:200px;background-image:url(${IMG})}.b{width:100px;height:50px;background-image:url(${IMG})}`,
      `<div class="a" id="a"><div class="b" id="b"></div><img id="m" src="${IMG}"><span id="s" style="background-image:url(${IMG})">x</span></div>`),
  });
  await scanDone(page);
  expect(await marked(page, "#a")).toBe(true);
  expect(await filterOf(page, "#a")).toMatch(REINVERT);
  expect(await filterOf(page, "#b")).toBe("none");
  expect(await filterOf(page, "#m")).toBe("none");
  expect(await filterOf(page, "#s")).toBe("none");
});

test("background-image none and gradients are not marked", async ({ page }) => {
  await openPage(page, {
    html: doc(".n{background-image:none;width:50px;height:50px}.g{width:50px;height:50px;background-image:linear-gradient(#fff,#eee)}.r{width:50px;height:50px;background:radial-gradient(#fff,#000)}",
      '<div class="n" id="n"></div><div class="g" id="g"></div><div class="r" id="r"></div>'),
  });
  await scanDone(page);
  for (const id of ["#n", "#g", "#r"]) {
    expect(await marked(page, id), id).toBe(false);
    expect(await filterOf(page, id), id).toBe("none");
  }
});

// BUG: dusk.css `[style*="background-image"]` re-inverts every inline
// background-image, including gradients, `none`, and full-viewport ones,
// bypassing the scanner's url()/size checks.
test("inline gradient background-image is not re-inverted", async ({ page }) => {
  await openPage(page, { html: doc("", '<div id="g" style="width:50px;height:50px;background-image:linear-gradient(#fff,#eee)"></div>') });
  expect(await filterOf(page, "#g")).toBe("none");
});

test("inline full-viewport wallpaper is not re-inverted", async ({ page }) => {
  await openPage(page, { html: doc("", `<div id="w" style="position:fixed;inset:0;background-image:url(${IMG})"></div>`) });
  expect(await filterOf(page, "#w")).toBe("none");
});

test("nodes added after load get marked", async ({ page }) => {
  await openPage(page, { html: doc(`.late{width:60px;height:60px;background-image:url(${IMG})}`, '<div id="root"></div>') });
  await scanDone(page);
  await page.evaluate(() => {
    const wrap = document.createElement("section");
    wrap.innerHTML = '<div><div class="late" id="late"></div></div>';
    document.getElementById("root").appendChild(wrap);
  });
  await scanDone(page);
  expect(await marked(page, "#late")).toBe(true);
});

test("2000 bg elements added at once all get marked, no slice or frame over 50 ms", async ({ page }) => {
  // Time every scanner slice (the content script passes bgSlice by name to
  // requestIdleCallback / setTimeout) before content.js runs.
  await page.addInitScript(() => {
    window.__slices = [];
    const wrap = (orig) => function (cb, ...rest) {
      if (typeof cb === "function" && cb.name === "bgSlice") {
        const inner = cb;
        cb = function (...a) { const t = performance.now(); try { return inner.apply(this, a); } finally { window.__slices.push(performance.now() - t); } };
      }
      return orig.call(this, cb, ...rest);
    };
    if (window.requestIdleCallback) window.requestIdleCallback = wrap(window.requestIdleCallback);
    window.setTimeout = wrap(window.setTimeout);
  });
  await openPage(page, { html: doc(`.t{width:20px;height:20px;display:inline-block;background-image:url(${IMG})}`, '<div id="root"></div>') });
  await scanDone(page);

  const res = await page.evaluate(async () => {
    window.__slices = [];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 2000; i++) {
      const d = document.createElement("div");
      d.className = "t";
      frag.appendChild(d);
    }
    document.getElementById("root").appendChild(frag);
    // Watch frame gaps from the next frame on (the insertion itself is ours).
    await new Promise((r) => requestAnimationFrame(r));
    let last = performance.now(), maxGap = 0;
    const t0 = last;
    await new Promise((resolve) => {
      const tick = () => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        const done = document.querySelectorAll(".t[data-dusk-bg]").length === 2000;
        if (done || now - t0 > 8000) resolve(); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return {
      marked: document.querySelectorAll(".t[data-dusk-bg]").length,
      maxSlice: Math.max(0, ...window.__slices),
      slices: window.__slices.length,
      maxGap,
      took: performance.now() - t0,
    };
  });
  console.log("BGSCAN2000 " + JSON.stringify(res));
  expect(res.marked).toBe(2000);
  expect(res.maxSlice).toBeLessThan(50);
  expect(res.maxGap).toBeLessThan(50);
});

test("toggling off then on rescans the page", async ({ page }) => {
  await openPage(page, { html: doc(`.x{width:60px;height:60px;background-image:url(${IMG})}`, '<div id="root"></div>') });
  await scanDone(page);
  await setSettings(page, { enabled: false });
  expect(await duskState(page)).toBe("disabled");
  // Added while off: the observer is disconnected, so only a rescan finds it.
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.className = "x"; d.id = "off";
    document.getElementById("root").appendChild(d);
  });
  await scanDone(page, 800);
  expect(await marked(page, "#off")).toBe(false);
  await setSettings(page, { enabled: true });
  await scanDone(page);
  expect(await marked(page, "#off")).toBe(true);
});

test("bg image on a ::before pseudo-element is re-inverted (documented gap)", async ({ page }) => {
  test.fail(true, "GAP content.js:176 — scanner reads only the element's own background, not ::before/::after (common for icons)");
  await openPage(page, { html: doc(`.ic::before{content:"";display:block;width:20px;height:20px;background-image:url(${IMG})}`, '<span class="ic" id="ic"></span>') });
  await scanDone(page);
  const f = await page.evaluate(() => getComputedStyle(document.getElementById("ic"), "::before").filter);
  expect(f).toMatch(REINVERT);
});

test("scanner stops (no observer work) while Dusk is off", async ({ page }) => {
  await openPage(page, { settings: { enabled: false }, html: doc(`.x{width:60px;height:60px;background-image:url(${IMG})}`, '<div id="root"><div class="x" id="pre"></div></div>') });
  await scanDone(page, 800);
  expect(await marked(page, "#pre")).toBe(false);
});
