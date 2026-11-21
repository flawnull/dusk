// @ts-check
// Pixel probe: does a CSS filter on <html> reach top-layer elements in WebKit?
// This decides whether Dusk needs its own dialog:modal / :popover-open /
// :fullscreen rules. Independent of Dusk's code: uses a bare root filter.
const { test, expect } = require("@playwright/test");

const PAGE = `<!doctype html><html><head><style>
  html { filter: invert(1); background: #fff; }
  body { margin: 0; background: #fff; }
  .box { background: #fff; width: 300px; height: 200px; border: 0; padding: 0; margin: 0; }
  #ctrl { position: absolute; left: 20px; top: 20px; }
  dialog::backdrop { background: transparent; }
  #d { position: fixed; left: 400px; top: 20px; }
  #p { position: fixed; left: 400px; top: 300px; inset: auto; left: 400px; top: 300px; }
</style></head><body>
  <div id="ctrl" class="box"></div>
  <dialog id="d" class="box"></dialog>
  <div id="p" class="box" popover="manual"></div>
  <div id="fs" class="box" style="position:absolute;left:20px;top:300px"></div>
</body></html>`;

// Reads one pixel of a screenshot by decoding it in the browser itself.
async function pixel(page, png, x, y) {
  const ctx = await page.context().newPage();
  const rgb = await ctx.evaluate(async ({ b64, x, y }) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    return Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
  }, { b64: png.toString("base64"), x, y });
  await ctx.close();
  return rgb;
}

const isBlack = (rgb) => rgb.every((v) => v < 40);
const isWhite = (rgb) => rgb.every((v) => v > 215);

async function centerOf(page, sel) {
  return page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, sel);
}

test("root filter vs top layer (pixel sampling)", async ({ page }) => {
  await page.setContent(PAGE);
  const findings = {};

  // Control: a normal white element under html{invert(1)} must render black.
  let shot = await page.screenshot();
  let c = await centerOf(page, "#ctrl");
  const ctrl = await pixel(page, shot, c.x, c.y);
  expect(isBlack(ctrl), `control pixel ${ctrl}`).toBe(true);

  // (a) modal dialog
  await page.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById("d")).showModal());
  shot = await page.screenshot();
  c = await centerOf(page, "#d");
  const dlg = await pixel(page, shot, c.x, c.y);
  findings.modalDialog = isBlack(dlg) ? "root filter APPLIES" : isWhite(dlg) ? "root filter does NOT apply" : `unclear ${dlg}`;
  await page.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById("d")).close());

  // (b) popover
  await page.evaluate(() => document.getElementById("p").showPopover());
  shot = await page.screenshot();
  c = await centerOf(page, "#p");
  const pop = await pixel(page, shot, c.x, c.y);
  findings.popover = isBlack(pop) ? "root filter APPLIES" : isWhite(pop) ? "root filter does NOT apply" : `unclear ${pop}`;
  await page.evaluate(() => document.getElementById("p").hidePopover());

  // (c) fullscreen, if headless allows it
  const fsOk = await page.evaluate(async () => {
    try { await document.getElementById("fs").requestFullscreen(); return !!document.fullscreenElement; }
    catch (e) { return "error: " + e.message; }
  });
  if (fsOk === true) {
    shot = await page.screenshot();
    const vp = page.viewportSize();
    const fs = await pixel(page, shot, Math.round(vp.width / 2), Math.round(vp.height / 2));
    findings.fullscreen = isBlack(fs) ? "root filter APPLIES" : isWhite(fs) ? "root filter does NOT apply" : `unclear ${fs}`;
  } else {
    findings.fullscreen = `not testable in headless WebKit (${fsOk})`;
  }

  console.log("TOPLAYER " + JSON.stringify(findings));
  test.info().annotations.push({ type: "toplayer", description: JSON.stringify(findings) });
});

// With Dusk itself: modal dialog / popover must come out dark, and a white
// image inside a fullscreen element must keep its natural (white) color.
const { openPage } = require("../helpers");
const WHITE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

test("Dusk on: dialog and popover dark, fullscreen media natural (pixels)", async ({ page }) => {
  await openPage(page, {
    settings: { intensity: 100 },
    html: `<!doctype html><html><head><style>
      body{margin:0;background:#fff}
      .box{background:#fff;width:300px;height:200px;border:0;padding:0;margin:0}
      dialog::backdrop{background:transparent}
      #d{position:fixed;left:400px;top:20px}
      #p{position:fixed;inset:auto;left:400px;top:300px}
      #fs img{width:100%;height:100%;display:block}
    </style></head><body>
      <dialog id="d" class="box"></dialog>
      <div id="p" class="box" popover="manual"></div>
      <div id="fs" class="box"><img src="data:image/png;base64,${WHITE_PNG}"></div>
    </body></html>`,
  });
  await page.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById("d")).showModal());
  let shot = await page.screenshot();
  let c = await centerOf(page, "#d");
  expect(isBlack(await pixel(page, shot, c.x, c.y)), "modal dialog should be dark").toBe(true);
  await page.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById("d")).close());

  await page.evaluate(() => document.getElementById("p").showPopover());
  shot = await page.screenshot();
  c = await centerOf(page, "#p");
  expect(isBlack(await pixel(page, shot, c.x, c.y)), "popover should be dark").toBe(true);
  await page.evaluate(() => document.getElementById("p").hidePopover());

  const ok = await page.evaluate(async () => {
    try { await document.getElementById("fs").requestFullscreen(); return !!document.fullscreenElement; } catch { return false; }
  });
  test.skip(!ok, "fullscreen unavailable");
  shot = await page.screenshot();
  const vp = page.viewportSize();
  expect(isWhite(await pixel(page, shot, vp.width / 2, vp.height / 2)), "fullscreen image should be natural white").toBe(true);
});
