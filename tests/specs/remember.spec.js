// @ts-check
// Sites that are already dark: remembered per host so a second visit never
// shows them inverted, and checked early so web apps that paint their dark
// theme late are left alone before the page has finished loading.
const { test, expect } = require("@playwright/test");
const { HOST, openPage, settle, duskState, styleInfo } = require("../helpers");

const KEY_LIGHT_MAC = `dark:l:${HOST}`; // Playwright's default appearance is light
const KEY_DARK_MAC = `dark:d:${HOST}`;

const DARK = "<!doctype html><style>body{margin:0;min-height:100vh;background:#111;color:#eee}</style><p>x</p>";
const LIGHT = "<!doctype html><style>body{margin:0;min-height:100vh;background:#fff}</style><p>x</p>";

// Light until a script paints the dark theme, the way a web app does after its
// bundle runs; a slow image keeps the page from loading until 2 s.
const LATE_DARK = (ms) => `<!doctype html><style>body{margin:0;min-height:100vh}.dark{background:#111;color:#eee}</style>
<p>app</p><img src="/slow.png" alt="">
<script>setTimeout(() => document.body.classList.add("dark"), ${ms})</script>`;

// Records every frame in which the root is filtered, from document start.
async function recordFilteredFrames(page) {
  await page.addInitScript(() => {
    window.__filtered = 0;
    const tick = () => {
      if (document.documentElement && getComputedStyle(document.documentElement).filter.includes("invert")) {
        window.__filtered++;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

test("a detected dark site is remembered", async ({ page }) => {
  await openPage(page, { html: DARK });
  expect(await duskState(page)).toBe("already-dark");
  const store = await page.evaluate(() => window.__duskStore);
  expect(store[KEY_LIGHT_MAC]).toBe(1);
  expect(store[KEY_DARK_MAC]).toBeUndefined();
});

test("a light site writes nothing", async ({ page }) => {
  await openPage(page, { html: LIGHT });
  expect(await duskState(page)).toBe("active");
  expect(await page.evaluate(() => window.__duskWrites)).toEqual([]);
});

test("a remembered dark site is never inverted on the next visit", async ({ page }) => {
  await recordFilteredFrames(page);
  await openPage(page, { html: DARK, settings: { [KEY_LIGHT_MAC]: 1 } });
  expect(await duskState(page)).toBe("already-dark");
  expect(await page.evaluate(() => window.__filtered)).toBe(0);
});

test("a dark site remembered while the Mac was dark does not count in light mode", async ({ page }) => {
  await openPage(page, { html: LIGHT, settings: { [KEY_DARK_MAC]: 1 } });
  expect(await duskState(page)).toBe("active");
  expect((await page.evaluate(() => window.__duskStore))[KEY_DARK_MAC]).toBe(1);
});

test("a remembered site that turned light is darkened after load and forgotten", async ({ page }) => {
  await openPage(page, { html: LIGHT, settings: { [KEY_LIGHT_MAC]: 1 } });
  expect(await duskState(page)).toBe("active");
  expect((await styleInfo(page)).count).toBe(1);
  await settle(page);
  expect((await page.evaluate(() => window.__duskStore))[KEY_LIGHT_MAC]).toBeUndefined();
});

test("a web app that paints dark before load is left alone before it loads", async ({ page }) => {
  const nav = page.goto("about:blank");
  await nav;
  const opening = openPage(page, { html: LATE_DARK(200), slow: { "/slow.png": 2000 } });
  // Well before load (2 s), the early checks must have switched Dusk off.
  await page.waitForFunction(() => document.readyState === "interactive", null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => document.readyState)).not.toBe("complete");
  expect((await styleInfo(page)).count).toBe(0);
  await opening;
  expect(await duskState(page)).toBe("already-dark");
  expect((await page.evaluate(() => window.__duskStore))[KEY_LIGHT_MAC]).toBe(1);
});

test("a remembered dark site that looks light while half-built is not inverted", async ({ page }) => {
  await recordFilteredFrames(page);
  await openPage(page, { html: LATE_DARK(1500), slow: { "/slow.png": 2000 }, settings: { [KEY_LIGHT_MAC]: 1 } });
  expect(await duskState(page)).toBe("already-dark");
  expect(await page.evaluate(() => window.__filtered)).toBe(0);
});

test("remembered sites do not wake other tabs", async ({ page }) => {
  await openPage(page, { html: LIGHT });
  const before = await page.evaluate(() => getComputedStyle(document.documentElement).filter);
  await page.evaluate(() => window.__duskSet({ ["dark:l:other.test"]: 1 }));
  await settle(page);
  expect(await duskState(page)).toBe("active");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).filter)).toBe(before);
});

test("site set to Always ignores the memory", async ({ page }) => {
  await openPage(page, { html: DARK, settings: { [KEY_LIGHT_MAC]: 1, siteModes: { [HOST]: "on" } } });
  expect(await duskState(page)).toBe("forced");
  expect((await styleInfo(page)).count).toBe(1);
});
