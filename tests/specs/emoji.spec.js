// @ts-check
// Colour emoji are pictures drawn by the font. The page filter would show
// their negative, so an element holding only emoji is re-inverted like an
// image. Emoji inside a sentence stay with the text.
const { test, expect } = require("@playwright/test");
const { openPage, settle } = require("../helpers");

const doc = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #fff; font: 16px -apple-system, sans-serif; }
  #big { position: absolute; left: 20px; top: 20px; font-size: 100px; line-height: 1; }
</style></head><body>${body}</body></html>`;

const emojiMark = (page, sel) => page.evaluate((s) => document.querySelector(s).hasAttribute("data-dusk-emoji"), sel);
const filterOf = (page, sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).filter, sel);
const REINVERT = /invert\(1\) contrast\([\d.]+\) hue-rotate\(180deg\)/;
const waitScan = (page) => page.waitForTimeout(400);

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

test.describe("emoji", () => {
  test("an emoji-only element is re-inverted like an image", async ({ page }) => {
    await openPage(page, { html: doc('<p>Nice post <span id="e">👏👍😊</span></p>') });
    await waitScan(page);
    expect(await emojiMark(page, "#e")).toBe(true);
    expect(await filterOf(page, "#e")).toMatch(REINVERT);
  });

  test("an emoji renders in its own colours on screen (a red square stays red)", async ({ page }) => {
    await openPage(page, { html: doc('<span id="big">🟥</span>') });
    await waitScan(page);
    const [r, g, b] = await pixelAt(page, 70, 70);
    expect(r).toBeGreaterThan(150);
    expect(Math.max(g, b)).toBeLessThan(110);
  });

  test("emoji with skin tones, joiners and flags count as emoji", async ({ page }) => {
    await openPage(page, { html: doc('<span id="a">👍🏽</span><span id="b">👩‍💻</span><span id="c">🇳🇱</span><span id="d">❤️</span>') });
    await waitScan(page);
    for (const s of ["#a", "#b", "#c", "#d"]) expect(await emojiMark(page, s)).toBe(true);
  });

  test("text with an emoji in it stays with the page", async ({ page }) => {
    await openPage(page, { html: doc('<span id="e">Great work 👏</span>') });
    await waitScan(page);
    expect(await emojiMark(page, "#e")).toBe(false);
  });

  test("symbols drawn as text (©, ™, ✔, plain ❤) are not emoji", async ({ page }) => {
    await openPage(page, { html: doc('<span id="a">©</span><span id="b">™</span><span id="c">✔</span><span id="d">❤</span><span id="n">12</span>') });
    await waitScan(page);
    for (const s of ["#a", "#b", "#c", "#d", "#n"]) expect(await emojiMark(page, s)).toBe(false);
  });

  test("an emoji on its own coloured background is left alone (re-inverting would flip the background)", async ({ page }) => {
    await openPage(page, { html: doc('<span id="e" style="background:#eef">👏</span>') });
    await waitScan(page);
    expect(await emojiMark(page, "#e")).toBe(false);
  });

  test("an element that gains emoji text later is marked", async ({ page }) => {
    await openPage(page, { html: doc('<span id="e">like</span>') });
    await waitScan(page);
    await page.evaluate(() => { document.getElementById("e").textContent = "👍"; });
    await page.waitForFunction(() => document.getElementById("e").hasAttribute("data-dusk-emoji"), null, { timeout: 3000 });
  });

  test("text edited in place from emoji to words is unmarked", async ({ page }) => {
    await openPage(page, { html: doc('<span id="e">👍</span>') });
    await waitScan(page);
    expect(await emojiMark(page, "#e")).toBe(true);
    await page.evaluate(() => { document.getElementById("e").firstChild.data = "liked"; });
    await page.waitForFunction(() => !document.getElementById("e").hasAttribute("data-dusk-emoji"), null, { timeout: 3000 });
  });

  test("an SVG emoji image (Twemoji, WordPress) is re-inverted, unlike SVG logos", async ({ page }) => {
    await openPage(page, { html: doc('<img id="w" class="emoji" alt="👏" src="/x/1f44f.svg"><img id="t" alt="👏" src="/emoji/v2/svg/1f44f.svg"><img id="logo" src="/logo.svg">') });
    await settle(page);
    expect(await filterOf(page, "#w")).toMatch(REINVERT);
    expect(await filterOf(page, "#t")).toMatch(REINVERT);
    expect(await filterOf(page, "#logo")).toBe("none");
  });

  test("an emoji inside a re-inverted photo box is not flipped twice", async ({ page }) => {
    const IMG = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
    await openPage(page, { html: doc(`<div id="p" style="width:200px;height:120px;background:url(${IMG}) center/cover"><span id="e">👏</span></div>`) });
    await page.waitForFunction(() => document.getElementById("p").hasAttribute("data-dusk-bg"), null, { timeout: 3000 });
    expect(await filterOf(page, "#e")).toBe("none");
  });

  test("Dusk off: emoji show with no filter", async ({ page }) => {
    await openPage(page, { html: doc('<span id="e">👏</span>'), settings: { enabled: false } });
    await waitScan(page);
    expect(await filterOf(page, "#e")).toBe("none");
  });
});
