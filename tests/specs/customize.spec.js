// @ts-check
// Warmth and Dim images: what the page renders with, checked by computed
// filters and by real pixels.
const { test, expect } = require("@playwright/test");
const { openPage, setSettings } = require("../helpers");

// A white page with a white canvas (media) and a gray text block.
const PAGE = `<!doctype html><html><head><style>
  body { margin: 0; background: #fff; }
  #c { position: absolute; left: 20px; top: 20px; width: 200px; height: 200px; }
  #t { position: absolute; left: 300px; top: 20px; width: 200px; height: 200px; background: #000; }
</style></head><body>
  <canvas id="c" width="200" height="200"></canvas>
  <div id="t"></div><!-- black block: renders light, like text does -->
  <script>
    const g = document.getElementById("c").getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, 200, 200);
  </script>
</body></html>`;

async function pixelAt(page, x, y) {
  const png = await page.screenshot();
  const probe = await page.context().newPage();
  const rgb = await probe.evaluate(async ({ b64, x, y }) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    return Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
  }, { b64: png.toString("base64"), x, y });
  await probe.close();
  return rgb;
}

const CANVAS = [120, 120];
const PAGE_BG = [400, 320];  // white page background, renders dark
const LIGHT = [400, 120];    // black block, renders light
const filterOf = (page, sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).filter, sel);

test("defaults: no warmth, images at full brightness", async ({ page }) => {
  await openPage(page, { html: PAGE });
  expect(await filterOf(page, "html")).toMatch(/sepia\(0\)/);
  expect(await filterOf(page, "#c")).toMatch(/^brightness\(1\) invert\(1\)/);
  const img = await pixelAt(page, ...CANVAS);
  expect(img.every((v) => v > 240)).toBe(true); // white image stays white
});

test("Dim images: a white image renders at about 80% brightness, page unchanged", async ({ page }) => {
  await openPage(page, { html: PAGE, settings: { intensity: 100 } });
  const pageBefore = await pixelAt(page, ...PAGE_BG);
  await setSettings(page, { dimImages: true });
  expect(await filterOf(page, "#c")).toMatch(/^brightness\(0\.8\) invert\(1\)/);
  const img = await pixelAt(page, ...CANVAS);
  for (const v of img) expect(Math.abs(v - 204)).toBeLessThan(12); // 0.8 * 255
  expect(await pixelAt(page, ...PAGE_BG)).toEqual(pageBefore);
});

test("Warmth: light parts (text) turn warm, red clearly above blue", async ({ page }) => {
  await openPage(page, { html: PAGE, settings: { intensity: 90 } });
  const [r0, , b0] = await pixelAt(page, ...LIGHT);
  expect(Math.abs(r0 - b0)).toBeLessThan(6); // neutral without warmth
  await setSettings(page, { warmth: 100 });
  expect(await filterOf(page, "html")).toMatch(/sepia\(0\.5\)/);
  const [r, , b] = await pixelAt(page, ...LIGHT);
  expect(r - b).toBeGreaterThan(12);
  const [dr, , db] = await pixelAt(page, ...PAGE_BG);
  expect(dr).toBeLessThan(40); // dark background stays dark
  expect(db).toBeLessThan(40);
});

test("Warmth clamps junk values", async ({ page }) => {
  for (const [warmth, sepia] of [[-20, "0"], [500, "0.5"], ["abc", "0"]]) {
    await openPage(page, { html: PAGE, settings: { warmth } });
    const v = await page.evaluate(() => document.documentElement.style.getPropertyValue("--dusk-s"));
    expect(Number(v)).toBe(Number(sepia));
  }
});

test("Dim images only accepts true", async ({ page }) => {
  await openPage(page, { html: PAGE, settings: { dimImages: "yes" } });
  const v = await page.evaluate(() => document.documentElement.style.getPropertyValue("--dusk-img"));
  expect(v).toBe("1");
});

test("turning Dusk off removes every custom property and the style attribute", async ({ page }) => {
  await openPage(page, { html: PAGE, settings: { warmth: 40, dimImages: true } });
  await setSettings(page, { enabled: false });
  const left = await page.evaluate(() => document.documentElement.getAttribute("style"));
  expect(left).toBeNull();
});
