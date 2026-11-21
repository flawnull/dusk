// @ts-check
const { test, expect } = require("@playwright/test");
const { HOST, ORIGIN, openPage, settle, duskState, styleInfo, duskSelectors, setSettings } = require("../helpers");

const page100 = (css, body = "<p>Some text</p>", head = "") =>
  `<!doctype html><html><head>${head}<style>${css}</style></head><body>${body}</body></html>`;

test.describe("light pages", () => {
  test("style is applied on a plain light page", async ({ page }) => {
    const log = await openPage(page);
    const s = await styleInfo(page);
    expect(s.count).toBe(1);
    expect(await duskState(page)).toBe("active");
    const filter = await page.evaluate(() => getComputedStyle(document.documentElement).filter);
    expect(filter).toContain("invert");
    expect(log.errors).toEqual([]);
  });

  test("empty page is treated as light", async ({ page }) => {
    await openPage(page, { html: "" });
    expect(await duskState(page)).toBe("active");
    expect((await styleInfo(page)).count).toBe(1);
  });

  test("rgba background with alpha < 0.1 is ignored (white canvas shows through)", async ({ page }) => {
    await openPage(page, { html: page100("html,body{margin:0;height:100%;background:rgba(0,0,0,0.05)}") });
    expect(await duskState(page)).toBe("active");
  });

  test("color-scheme 'light dark' alone does not count as dark", async ({ page }) => {
    await openPage(page, { html: page100("body{background:#fff}", "<p>x</p>", '<meta name="color-scheme" content="light dark">') });
    expect(await duskState(page)).toBe("active");
  });
});

test.describe("intensity mapping", () => {
  const cases = [
    { intensity: 50, invert: 0.8 },
    { intensity: 90, invert: 0.96 },
    { intensity: 100, invert: 1 },
    { intensity: 200, invert: 1 },
    { intensity: "abc", invert: 0.96 },
    { intensity: undefined, invert: 0.96 },
    { intensity: "70", invert: 0.88 },
  ];
  for (const c of cases) {
    test(`intensity ${JSON.stringify(c.intensity)} -> invert ${c.invert}`, async ({ page }) => {
      const settings = c.intensity === undefined ? {} : { intensity: c.intensity };
      await openPage(page, { settings });
      const s = await styleInfo(page);
      expect(s.pageInvert).toBeCloseTo(c.invert, 3);
      // Media correction must be the exact inverse: contrast = 1 / (2a - 1).
      expect(s.mediaContrast).toBeCloseTo(1 / (2 * c.invert - 1), 2);
    });
  }

  // Regression (bug in 1.1: `Number(intensity) || 90` turned 0 into 90).
  test("intensity 0 clamps to the minimum (0.80), not the default", async ({ page }) => {
    await openPage(page, { settings: { intensity: 0 } });
    expect((await styleInfo(page)).pageInvert).toBeCloseTo(0.8, 3);
  });

  test("media filter includes the contrast correction", async ({ page }) => {
    await openPage(page, { settings: { intensity: 90 } });
    const filter = await page.evaluate(() => {
      const img = document.createElement("img");
      document.body.appendChild(img);
      return getComputedStyle(img).filter;
    });
    expect(filter).toMatch(/invert\(1\) contrast\(1\.08\d*\) hue-rotate\(180deg\)/);
  });

  test("live intensity change updates the rendered filter", async ({ page }) => {
    await openPage(page);
    await setSettings(page, { intensity: 60 });
    const s = await styleInfo(page);
    expect(s.count).toBe(1);
    expect(s.styleTags).toBeLessThanOrEqual(1);
    expect(s.pageInvert).toBeCloseTo(0.84, 3);
  });
});

test.describe("already-dark detection", () => {
  const dark = [
    ["dark body filling the viewport", page100("body{margin:0;min-height:100vh;background:#111;color:#eee}")],
    ["transparent body + dark wrapper div", page100("body{margin:0}#app{min-height:100vh;background:#121212}", '<div id="app">x</div>')],
    ['meta color-scheme "dark"', page100("body{background:#fff}", "x", '<meta name="color-scheme" content="dark">')],
    ['meta color-scheme "only dark"', page100("body{background:#fff}", "x", '<meta name="color-scheme" content="only dark">')],
    ["oklch() background", page100("body{margin:0;min-height:100vh;background:oklch(0.2 0.02 250)}")],
    ["lab() background", page100("body{margin:0;min-height:100vh;background:lab(15% 0 0)}")],
    ["color(srgb) background", page100("body{margin:0;min-height:100vh;background:color(srgb 0.1 0.1 0.12)}")],
    ["rgb() modern syntax with slash alpha", page100("body{margin:0;min-height:100vh;background:rgb(10 10 10 / 0.9)}")],
  ];
  for (const [name, html] of dark) {
    test(`${name} counts as dark`, async ({ page }) => {
      const log = await openPage(page, { html });
      expect(await duskState(page)).toBe("already-dark");
      expect((await styleInfo(page)).count).toBe(0);
      expect(log.errors).toEqual([]);
    });
  }

  // Regression (bug in 1.1: Dusk's own html{background:#fff !important} was
  // in force during detection and hid the page's html background).
  test("dark background on <html> (transparent body) counts as dark", async ({ page }) => {
    await openPage(page, { html: page100("html{background:#111}body{margin:0;color:#eee}") });
    expect(await duskState(page)).toBe("already-dark");
  });

  // BUG: a short <body> with a dark background paints the whole canvas
  // (background propagation), but sample points below the body hit <html>,
  // whose computed background is transparent, so they count as white.
  test("short dark <body> (background propagates to canvas) counts as dark", async ({ page }) => {
    await openPage(page, { html: page100("body{background:#111;color:#eee}", "<p>one line</p>") });
    expect(await duskState(page)).toBe("already-dark");
  });

  // Regression (bug in 1.1: color(display-p3 …) was not parsed).
  test("color(display-p3) dark background counts as dark", async ({ page }) => {
    await openPage(page, { html: page100("body{margin:0;min-height:100vh;background:color(display-p3 0.08 0.08 0.1)}") });
    expect(await duskState(page)).toBe("already-dark");
  });

  // BUG: Dusk's load listener is registered at document_start, before the
  // page's own load listener, so it runs first and never sees a theme the
  // page applies in its load handler.
  test("dark theme applied by the page in its own load handler is detected", async ({ page }) => {
    const html = page100(
      "body{margin:0;min-height:100vh;background:#fff}body.dark{background:#111}",
      "<p>x</p><script>addEventListener('load',()=>document.body.classList.add('dark'))</script>",
    );
    await openPage(page, { html });
    expect(await duskState(page)).toBe("already-dark");
  });

  test("dark theme applied at DOMContentLoaded+load via early script is detected", async ({ page }) => {
    // Theme set synchronously by an inline script: must be detected.
    const html = page100(
      "body{margin:0;min-height:100vh;background:#fff}body.dark{background:#111}",
      "<script>document.body.classList.add('dark')</script><p>x</p>",
    );
    await openPage(page, { html });
    expect(await duskState(page)).toBe("already-dark");
  });

  test("light page with a dark header strip stays active (majority light)", async ({ page }) => {
    await openPage(page, {
      html: page100("body{margin:0;background:#fff}header{height:200px;background:#111}main{height:2000px}", "<header></header><main>x</main>"),
    });
    expect(await duskState(page)).toBe("active");
  });
});

test.describe("settings and site modes", () => {
  test("enabled=false removes the style and reports disabled", async ({ page }) => {
    await openPage(page, { settings: { enabled: false } });
    expect((await styleInfo(page)).count).toBe(0);
    expect(await duskState(page)).toBe("disabled");
  });

  test("site mode off", async ({ page }) => {
    await openPage(page, { settings: { siteModes: { [HOST]: "off" } } });
    expect((await styleInfo(page)).count).toBe(0);
    expect(await duskState(page)).toBe("site-off");
  });

  test("site mode on forces dark on an already-dark site", async ({ page }) => {
    await openPage(page, {
      settings: { siteModes: { [HOST]: "on" } },
      html: page100("body{margin:0;min-height:100vh;background:#111}"),
    });
    expect((await styleInfo(page)).count).toBe(1);
    expect(await duskState(page)).toBe("forced");
  });

  test("site mode auto (missing key) behaves as auto", async ({ page }) => {
    await openPage(page, { settings: { siteModes: { "other.test": "off" } } });
    expect(await duskState(page)).toBe("active");
  });

  test("garbage site mode value falls back to auto", async ({ page }) => {
    await openPage(page, { settings: { siteModes: { [HOST]: "maybe" } } });
    expect(await duskState(page)).toBe("active");
  });

  test("legacy disabledSites is honored as off", async ({ page }) => {
    await openPage(page, { settings: { disabledSites: [HOST] } });
    expect(await duskState(page)).toBe("site-off");
    expect((await styleInfo(page)).count).toBe(0);
  });

  test("siteModes on wins over legacy disabledSites", async ({ page }) => {
    await openPage(page, { settings: { disabledSites: [HOST], siteModes: { [HOST]: "on" } } });
    expect(await duskState(page)).toBe("forced");
  });

  test("siteModes null in storage does not throw", async ({ page }) => {
    const log = await openPage(page, { settings: { siteModes: null, disabledSites: null } });
    expect(await duskState(page)).toBe("active");
    expect(log.errors).toEqual([]);
  });

  test("followSystem: light Mac pauses, dark Mac applies, switches live", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openPage(page, { settings: { followSystem: true } });
    expect(await duskState(page)).toBe("system-light");
    expect((await styleInfo(page)).count).toBe(0);

    await page.emulateMedia({ colorScheme: "dark" });
    await settle(page);
    expect(await duskState(page)).toBe("active");
    expect((await styleInfo(page)).count).toBe(1);

    await page.emulateMedia({ colorScheme: "light" });
    await settle(page);
    expect((await styleInfo(page)).count).toBe(0);
  });

  test("followSystem off ignores light Mac", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openPage(page, { settings: { followSystem: false } });
    expect(await duskState(page)).toBe("active");
  });

  test("storage.onChanged applies live: disable, site off, back to auto", async ({ page }) => {
    await openPage(page);
    await setSettings(page, { enabled: false });
    expect((await styleInfo(page)).count).toBe(0);
    await setSettings(page, { enabled: true });
    expect((await styleInfo(page)).count).toBe(1);
    await setSettings(page, { siteModes: { [HOST]: "off" } });
    expect(await duskState(page)).toBe("site-off");
    await setSettings(page, { siteModes: {} });
    expect(await duskState(page)).toBe("active");
  });

  test("removing a key (newValue undefined) falls back to the default", async ({ page }) => {
    await openPage(page, { settings: { enabled: false } });
    await setSettings(page, { enabled: undefined });
    expect(await duskState(page)).toBe("active");
  });

  test("no duplicate style tags after many renders", async ({ page }) => {
    await openPage(page);
    for (let i = 0; i < 40; i++) {
      await page.evaluate((v) => window.__duskSet({ intensity: 50 + (v % 11) * 5, enabled: v % 3 !== 0 }), i);
    }
    await setSettings(page, { enabled: true });
    const s = await styleInfo(page);
    expect(s.count).toBe(1);
    expect(s.styleTags).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.querySelectorAll("style").length)).toBeLessThanOrEqual(1);
  });

  test("unrelated runtime messages get no reply", async ({ page }) => {
    await openPage(page);
    const res = await page.evaluate(() => window.__duskSend({ type: "something-else" }));
    expect(res).toBeUndefined();
  });
});

test.describe("css rules parse in WebKit", () => {
  test("every rule survives parsing, including top-layer selectors", async ({ page }) => {
    await openPage(page);
    const selectors = await duskSelectors(page);
    // An invalid selector would drop its whole rule, so check each one landed.
    expect(selectors.some((s) => s.includes("dialog:modal"))).toBe(true);
    expect(selectors.some((s) => s.includes(":popover-open"))).toBe(true);
    expect(selectors.some((s) => s.includes(":fullscreen"))).toBe(true);
    // WebKit 26 keeps the prefixed rule but serializes it as :fullscreen
    // (alias), so both fullscreen rules show up as :fullscreen.
    expect(selectors.filter((s) => /full-?screen/.test(s)).length).toBeGreaterThanOrEqual(2);
    expect(selectors.some((s) => s.includes(":is("))).toBe(true);
  });

  test("modal dialog and popover get the page filter", async ({ page }) => {
    await openPage(page, {
      html: page100("", '<dialog id="d">hi</dialog><div id="p" popover>pop</div>'),
    });
    const res = await page.evaluate(() => {
      const d = /** @type {HTMLDialogElement} */ (document.getElementById("d"));
      d.showModal();
      const p = document.getElementById("p");
      p.showPopover();
      return [getComputedStyle(d).filter, getComputedStyle(p).filter];
    });
    for (const f of res) expect(f).toMatch(/^invert\(0\.96\) hue-rotate\(180deg\)( sepia\(0\))?$/);
  });

  test("non-modal dialog keeps no own filter (it is inside the page filter)", async ({ page }) => {
    await openPage(page, { html: page100("", '<dialog id="d" open>hi</dialog>') });
    const f = await page.evaluate(() => getComputedStyle(document.getElementById("d")).filter);
    expect(f).toBe("none");
  });

  test("media inside an inline background-image box is not flipped twice", async ({ page }) => {
    await openPage(page, {
      html: page100("", '<div id="bg" style="background-image:url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)"><img id="i"></div>'),
    });
    // Inline url() backgrounds are marked by the idle scanner, not by a selector.
    await page.waitForSelector("#bg[data-dusk-bg]", { state: "attached" });
    const [outer, inner] = await page.evaluate(() => [
      getComputedStyle(document.getElementById("bg")).filter,
      getComputedStyle(document.getElementById("i")).filter,
    ]);
    expect(outer).toContain("contrast(");
    expect(inner).toBe("none");
  });
});

test.describe("privacy and robustness", () => {
  test("content script makes no network requests", async ({ page }) => {
    const log = await openPage(page, {
      html: page100("body{background:#fff}", '<dialog id="d"></dialog>'),
    });
    await setSettings(page, { intensity: 75 });
    expect(log.requests).toEqual([ORIGIN + "/"]);
  });

  test("no console errors across a full settings cycle", async ({ page }) => {
    const log = await openPage(page, { settings: { followSystem: true } });
    await setSettings(page, { enabled: false });
    await setSettings(page, { enabled: true, siteModes: { [HOST]: "on" }, intensity: 55 });
    await duskState(page);
    expect(log.errors).toEqual([]);
  });

  test("style exists before first paint (applied at document_start)", async ({ page }) => {
    // An inline script at the very top of <head> must already see Dusk's style.
    const html = '<!doctype html><html><head><script>window.__early=getComputedStyle(document.documentElement).filter</script></head><body>x</body></html>';
    await openPage(page, { html });
    expect(await page.evaluate(() => window.__early)).toContain("invert");
  });

  test("no flash: root filter never drops to none while checking an already-light page", async ({ page }) => {
    const html = page100("body{background:#fff}", `<script>
      window.__seen = [];
      new MutationObserver(() => window.__seen.push(getComputedStyle(document.documentElement).filter))
        .observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    </script>`);
    await openPage(page, { html });
    const seen = await page.evaluate(() => window.__seen);
    expect(seen.filter((f) => f === "none")).toEqual([]);
  });

  test("detection works on a page with no <body> background and only text", async ({ page }) => {
    await openPage(page, { html: "<!doctype html><title>t</title>plain text" });
    expect(await duskState(page)).toBe("active");
  });

});
