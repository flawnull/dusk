// @ts-check
// Rendering edge cases, checked by real pixels in WebKit.
//
// Every fixture shows a solid YELLOW image (#ff0). With Dusk on at intensity
// 100, a correctly protected image stays light yellow; an image that Dusk
// inverts with the page turns dark olive (about rgb(37,37,0)). The page
// background must render dark.
//
// "Light yellow", not exact #ff0: hue-rotate(180deg) clamps out-of-range
// intermediate values, so fully saturated colors come back desaturated
// (#ff0 renders about rgb(223,223,186)). That is a limit of the filter
// approach, measured in test 27; lightness and hue survive.
//
// Cases marked test.fail document a known problem: "BUG:" is a defect Dusk
// could fix, "LIMIT:" is a trade-off of the filter approach. When a fix lands,
// the test starts passing, so test.fail reports it and the marker must go.
//
// Unlike helpers.openPage, injection here is TOP FRAME ONLY, like Safari with
// all_frames: false (Playwright init scripts otherwise run in every frame).
const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const { EXT, ORIGIN, stubApi } = require("../helpers");

const CONTENT_JS = fs.readFileSync(path.join(EXT, "content.js"), "utf8");
const DUSK_CSS = fs.readFileSync(path.join(EXT, "dusk.css"), "utf8");

// Solid-colour PNG, like a real photo. (Dusk treats SVG images as one-colour
// icons and leaves them inverted with the page, so test photos must not be SVG.)
const zlib = require("zlib");
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const svg = (fill, w = 100, h = 100) => {
  const hex = fill.replace("#", "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  const rgb = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return "data:image/png;base64," + png.toString("base64");
};
const Y = svg("#ff0");
const Y40 = svg("#ff0", 40, 40);

const doc = (body, head = "") => `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #fff; color: #000; font: 16px sans-serif; }
  .f { position: absolute; left: 100px; top: 100px; width: 100px; height: 100px; }
  .img { display: block; width: 100px; height: 100px; }
</style>${head}</head><body>${body}</body></html>`;

const BOX = { x: 100, y: 100, w: 100, h: 100 };
const PAGE_BG = { x: 1100, y: 700 };

async function openTop(page, html, settings = { intensity: 100 }) {
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === ORIGIN && url.pathname === "/") {
      return route.fulfill({ status: 200, contentType: "text/html", body: html });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  const topOnly = (code) => `if (window === window.top) { ${code} }`;
  await page.addInitScript({ content: topOnly(`(${stubApi})(${JSON.stringify({ initial: settings })});`) });
  await page.addInitScript({
    content: topOnly(`(() => {
      const css = ${JSON.stringify(DUSK_CSS)};
      const add = () => { const s = document.createElement("style"); s.textContent = css; document.documentElement.prepend(s); };
      if (document.documentElement) add();
      else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); add(); } }).observe(document, { childList: true });
    })();`),
  });
  await page.addInitScript({ content: topOnly(CONTENT_JS) });
  await page.goto(ORIGIN + "/", { waitUntil: "load" });
  await settle(page);
}

async function settle(page, ms = 2500) {
  // Lets the deferred load check and the idle background scanner finish.
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

// Classifies the pixels of a region: natural yellow vs inverted olive.
async function measure(page, box = BOX) {
  const png = await page.screenshot();
  const probe = await page.context().newPage();
  const res = await probe.evaluate(async ({ b64, box, bg }) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(box.x, box.y, box.w, box.h).data;
    let yellow = 0, olive = 0;
    for (let i = 0; i < d.length; i += 4) {
      const [r, gg, b] = [d[i], d[i + 1], d[i + 2]];
      if (r > 180 && gg > 180 && b < gg - 15) yellow++; // light yellow: protected
      else if (r > 15 && r < 100 && gg > 15 && gg < 100 && b < 40 && Math.abs(r - gg) < 30) olive++;
    }
    const cx = Math.floor(box.w / 2), cy = Math.floor(box.h / 2);
    const ci = (cy * box.w + cx) * 4;
    const center = [d[ci], d[ci + 1], d[ci + 2]];
    const bgd = g.getImageData(bg.x, bg.y, 1, 1).data;
    return { yellow, olive, center, pageBg: [bgd[0], bgd[1], bgd[2]] };
  }, { b64: png.toString("base64"), box, bg: PAGE_BG });
  await probe.close();
  return res;
}

const results = [];
function record(name, m, verdict) {
  const line = { name, verdict, ...m };
  results.push(line);
  console.log("EDGE " + JSON.stringify(line));
}

async function expectNatural(name, page, box = BOX) {
  const m = await measure(page, box);
  const natural = m.yellow > 20 && m.yellow > m.olive * 3;
  record(name, m, natural ? "natural" : "INVERTED");
  expect(m.pageBg.every((v) => v < 60), `page background dark, got ${m.pageBg}`).toBe(true);
  expect(natural, `yellow=${m.yellow} olive=${m.olive} center=${m.center}`).toBe(true);
}

// ---------------------------------------------------------------- shadow DOM

test("01 img inside open shadow DOM", async ({ page }) => {
  await openTop(page, doc(`<div id="h" class="f"></div><script>
    h.attachShadow({ mode: "open" }).innerHTML = '<img class="img" style="display:block;width:100px;height:100px" src="${Y}">';
  </script>`));
  await expectNatural("01 open shadow img", page);
});

test("02 img inside closed shadow DOM", async ({ page }) => {
  test.fail(true, "BUG: closed shadow roots are unreachable from a content script; img inverted");
  await openTop(page, doc(`<div id="h" class="f"></div><script>
    h.attachShadow({ mode: "closed" }).innerHTML = '<img style="display:block;width:100px;height:100px" src="${Y}">';
  </script>`));
  await expectNatural("02 closed shadow img", page);
});

test("03 CSS background-image inside a shadow root", async ({ page }) => {
  await openTop(page, doc(`<div id="h" class="f"></div><script>
    h.attachShadow({ mode: "open" }).innerHTML =
      '<style>.b{width:100px;height:100px;background-image:url("${Y}")}</style><div class="b"></div>';
  </script>`));
  await expectNatural("03 shadow bg", page);
});

// ---------------------------------------------------------------- pseudo elements

test("04a ::before with background-image url", async ({ page }) => {
  await openTop(page, doc(`<div class="f p"></div>`,
    `<style>.p::before{content:"";display:block;width:100px;height:100px;background-image:url("${Y}")}</style>`));
  await expectNatural("04a ::before bg", page);
});

test("04b ::after with background-image url", async ({ page }) => {
  await openTop(page, doc(`<div class="f p"></div>`,
    `<style>.p::after{content:"";display:block;width:100px;height:100px;background-image:url("${Y}")}</style>`));
  await expectNatural("04b ::after bg", page);
});

test("05 ::before with content: url(...)", async ({ page }) => {
  await openTop(page, doc(`<div class="f p"></div>`, `<style>.p::before{content:url("${Y}")}</style>`));
  await expectNatural("05 ::before content url", page);
});

// ---------------------------------------------------------------- changes after load

test("06 class change after load adds a bg image (no node added)", async ({ page }) => {
  await openTop(page, doc(`<div id="t" class="f"></div>`, `<style>.on{background-image:url("${Y}")}</style>`));
  await page.evaluate(() => document.getElementById("t").classList.add("on"));
  await settle(page);
  await expectNatural("06 class change", page);
});

test("07 img src swapped after load (lazy loading)", async ({ page }) => {
  await openTop(page, doc(`<img id="i" class="f" src="${svg("#00f")}">`));
  await page.evaluate((src) => { /** @type {HTMLImageElement} */ (document.getElementById("i")).src = src; }, Y);
  await settle(page);
  await expectNatural("07 src swap", page);
});

test("08 bg image added by a style attribute change after load", async ({ page }) => {
  await openTop(page, doc(`<div id="t" class="f"></div>`));
  await page.evaluate((src) => { document.getElementById("t").style.backgroundImage = `url("${src}")`; }, Y);
  await settle(page);
  await expectNatural("08 style attr change", page);
});

// ---------------------------------------------------------------- image kinds

test("09a picture with source srcset", async ({ page }) => {
  await openTop(page, doc(`<picture class="f" style="display:block"><source srcset="${Y}"><img class="img" src="${svg("#000")}"></picture>`));
  await expectNatural("09a picture/source", page);
});

test("09b img with srcset only", async ({ page }) => {
  await openTop(page, doc(`<img class="f" srcset="${Y} 1x">`));
  await expectNatural("09b img srcset", page);
});

test("10 svg <image href>", async ({ page }) => {
  await openTop(page, doc(`<svg class="f" width="100" height="100"><image href="${Y}" width="100" height="100"/></svg>`));
  await expectNatural("10 svg image", page);
});

test("11 inline svg logo with fill #f00 keeps its hue (lighter, by design)", async ({ page }) => {
  await openTop(page, doc(`<svg class="f" width="100" height="100"><rect width="100" height="100" fill="#f00"/></svg>`));
  const m = await measure(page);
  record("11 inline svg red rect", m, "info");
  const [r, g, b] = m.center;
  // Inline SVG is treated like text: lightness flips, hue stays red.
  expect(r).toBeGreaterThan(g + 60);
  expect(r).toBeGreaterThan(b + 60);
});

test("12 mask-image icon colored by background-color behaves like text", async ({ page }) => {
  await openTop(page, doc(`<div class="f" style="background-color:#000;-webkit-mask-image:url('${Y}');mask-image:url('${Y}')"></div>`));
  const m = await measure(page);
  record("12 mask icon (#000 fill)", m, "info");
  // A black icon must turn light on the dark page, like text.
  expect(m.center.every((v) => v > 200)).toBe(true);
});

test("13 list-style-image marker", async ({ page }) => {
  test.fail(true, "LIMIT: list markers are not elements; the marker image is inverted with the page");
  await openTop(page, doc(`<ul style="position:absolute;left:100px;top:100px;margin:0;padding:0;list-style-position:inside;list-style-image:url('${Y40}');font-size:40px;line-height:40px"><li>&nbsp;</li></ul>`));
  await expectNatural("13 list-style-image", page, { x: 100, y: 100, w: 50, h: 50 });
});

test("14 border-image", async ({ page }) => {
  test.fail(true, "LIMIT: border-image is not a background; scanner and selectors miss it");
  await openTop(page, doc(`<div class="f" style="box-sizing:border-box;border:30px solid;border-image:url('${Y}') 30 stretch"></div>`));
  await expectNatural("14 border-image", page);
});

test("15 image-set() background", async ({ page }) => {
  await openTop(page, doc(`<div class="f" style="background-image:-webkit-image-set(url('${Y}') 1x);background-image:image-set(url('${Y}') 1x)"></div>`));
  await expectNatural("15 image-set", page);
});

test("16 multiple backgrounds: url over gradient", async ({ page }) => {
  await openTop(page, doc(`<div class="f" style="background-image:url('${Y}'),linear-gradient(#000,#000)"></div>`));
  await expectNatural("16 url + gradient", page);
});

// ---------------------------------------------------------------- LinkedIn-like avatars

const BAR = `position:fixed;right:20px;bottom:0;width:300px;height:60px;overflow:hidden;transform:translateZ(0);will-change:transform;background:#fff;box-shadow:0 0 4px rgba(0,0,0,.3)`;
const AVATAR_BOX = { x: 1200 - 20 - 300 + 12, y: 800 - 60 + 12, w: 36, h: 36 };

test("17a circular img avatar in a fixed, transformed bottom-right bar", async ({ page }) => {
  await openTop(page, doc(`<div style="${BAR}"><button style="border:0;padding:0;background:none"><img src="${Y40}" style="display:block;width:40px;height:40px;border-radius:50%;margin:10px"></button></div>`));
  await expectNatural("17a fixed bar img avatar", page, AVATAR_BOX);
});

test("17b avatar as inline background-image div in the bar", async ({ page }) => {
  await openTop(page, doc(`<div style="${BAR}"><div style="width:40px;height:40px;margin:10px;border-radius:50%;background-image:url('${Y40}');background-size:cover"></div></div>`));
  await expectNatural("17b fixed bar bg avatar", page, AVATAR_BOX);
});

test("17c avatar via svg <pattern><image> fill", async ({ page }) => {
  await openTop(page, doc(`<svg class="f" width="100" height="100"><defs><pattern id="p" width="1" height="1" patternContentUnits="objectBoundingBox"><image href="${Y}" width="1" height="1" preserveAspectRatio="none"/></pattern></defs><circle cx="50" cy="50" r="50" fill="url(#p)"/></svg>`));
  await expectNatural("17c svg pattern avatar", page, { x: 120, y: 120, w: 60, h: 60 });
});

test("17d avatar via svg <image clip-path>", async ({ page }) => {
  await openTop(page, doc(`<svg class="f" width="100" height="100"><clipPath id="c"><circle cx="50" cy="50" r="50"/></clipPath><image href="${Y}" width="100" height="100" clip-path="url(#c)"/></svg>`));
  await expectNatural("17d svg clip-path avatar", page, { x: 120, y: 120, w: 60, h: 60 });
});

test("17e avatar img inside a masked container (presence-dot cutout)", async ({ page }) => {
  await openTop(page, doc(`<div class="f" style="-webkit-mask-image:radial-gradient(circle at 85% 85%, transparent 12px, #000 13px);mask-image:radial-gradient(circle at 85% 85%, transparent 12px, #000 13px)"><img class="img" src="${Y}" style="border-radius:50%"></div>`));
  await expectNatural("17e masked container avatar", page, { x: 120, y: 120, w: 40, h: 40 });
});

test("17f avatar img that ALSO has a placeholder background-image", async ({ page }) => {
  await openTop(page, doc(`<div style="${BAR}"><img src="${Y40}" style="display:block;width:40px;height:40px;margin:10px;border-radius:50%;background-image:url('${svg("#ccc", 40, 40)}')"></div>`));
  await expectNatural("17f img with placeholder bg", page, AVATAR_BOX);
});

test("17g avatar img inside a small element with a url background (sprite wrapper)", async ({ page }) => {
  await openTop(page, doc(`<div style="${BAR}"><div style="width:60px;height:60px;background-image:url('${svg("#ccc", 4, 4)}')"><img src="${Y40}" style="display:block;width:40px;height:40px;margin:10px;border-radius:50%"></div></div>`));
  await expectNatural("17g img in marked wrapper", page, AVATAR_BOX);
});

// LinkedIn-like: circular avatar with a green presence dot that gets its
// photo after load. The ghost placeholder is gray; the photo is yellow.
const GHOST = svg("#999", 40, 40);
const DOT = `<span id="dot" style="position:absolute;left:40px;top:40px;width:12px;height:12px;border-radius:50%;background:#057642;border:2px solid #fff"></span>`;
const AVATAR = (inner) => `<div style="${BAR}"><div style="position:relative;display:flow-root;width:56px;height:56px;margin:0">${inner}${DOT}</div></div>`;
const DOT_BOX = { x: 1200 - 20 - 300 + 42, y: 800 - 60 + 42, w: 8, h: 8 };

async function dotIsGreen(page) {
  const m = await measure(page, DOT_BOX);
  const [r, g, b] = m.center;
  record("presence dot", m, "info");
  return g > r + 30 && g > b;
}

test("17i lazy avatar: ghost bg div, photo set later via style", async ({ page }) => {
  await openTop(page, doc(AVATAR(`<div id="a" style="width:40px;height:40px;margin:10px;border-radius:50%;background-size:cover;background-image:url('${GHOST}')"></div>`)));
  await page.evaluate((src) => { document.getElementById("a").style.backgroundImage = `url("${src}")`; }, Y40);
  await settle(page);
  await expectNatural("17i lazy style bg avatar", page, AVATAR_BOX);
  expect(await dotIsGreen(page)).toBe(true);
});

test("17j lazy avatar: empty div gets a photo class later", async ({ page }) => {
  await openTop(page, doc(AVATAR(`<div id="a" class="ghost" style="width:40px;height:40px;margin:10px;border-radius:50%;background-size:cover"></div>`),
    `<style>.ghost{background-color:#999}.photo{background-image:url('${Y40}')}</style>`));
  await page.evaluate(() => { const a = document.getElementById("a"); a.classList.remove("ghost"); a.classList.add("photo"); });
  await settle(page);
  await expectNatural("17j lazy class avatar", page, AVATAR_BOX);
  expect(await dotIsGreen(page)).toBe(true);
});

test("17k lazy avatar: img with ghost src, real src later", async ({ page }) => {
  await openTop(page, doc(AVATAR(`<img id="a" src="${GHOST}" style="display:block;width:40px;height:40px;margin:10px;border-radius:50%">`)));
  await page.evaluate((src) => { /** @type {HTMLImageElement} */ (document.getElementById("a")).src = src; }, Y40);
  await settle(page);
  await expectNatural("17k lazy img avatar", page, AVATAR_BOX);
  expect(await dotIsGreen(page)).toBe(true);
});

test("17l lazy avatar: whole bar inserted after load, photo bg set a tick later", async ({ page }) => {
  await openTop(page, doc(""));
  await page.evaluate(({ html, src }) => {
    document.body.insertAdjacentHTML("beforeend", html);
    setTimeout(() => { document.getElementById("a").style.backgroundImage = `url("${src}")`; }, 0);
  }, { html: AVATAR(`<div id="a" style="width:40px;height:40px;margin:10px;border-radius:50%;background-size:cover"></div>`), src: Y40 });
  await settle(page);
  await expectNatural("17l inserted bar + lazy bg", page, AVATAR_BOX);
});

test("17m lazy avatar: photo bg removed again (back to ghost color) gets unmarked", async ({ page }) => {
  await openTop(page, doc(AVATAR(`<div id="a" style="width:40px;height:40px;margin:10px;border-radius:50%;background-image:url('${Y40}')"></div>`)));
  await page.evaluate(() => { const a = document.getElementById("a"); a.style.backgroundImage = "none"; a.style.backgroundColor = "#000"; });
  await settle(page);
  const marked = await page.evaluate(() => document.getElementById("a").hasAttribute("data-dusk-bg"));
  expect(marked).toBe(false);
  const m = await measure(page, AVATAR_BOX);
  record("17m unmarked after bg removed", m, "info");
  expect(m.center.every((v) => v > 200)).toBe(true); // black fill renders light, like text
});

test("17h avatar as <input type=image>", async ({ page }) => {
  await openTop(page, doc(`<input type="image" class="f" src="${Y}" style="width:100px;height:100px;padding:0;border:0">`));
  await expectNatural("17h input type=image", page);
});

// ---------------------------------------------------------------- filters, opacity, blend

test("18a img inside an ancestor with its own filter", async ({ page }) => {
  await openTop(page, doc(`<div class="f" style="filter:grayscale(0.01)"><img class="img" src="${Y}"></div>`));
  await expectNatural("18a ancestor filter", page);
});

test("18b img with the page's own (non-important) filter, e.g. blur placeholder", async ({ page }) => {
  await openTop(page, doc(`<img class="f ph" src="${Y}">`, `<style>.ph{filter:blur(0px)}</style>`));
  await expectNatural("18b page img filter", page);
});

test("18c page sets img { filter: none !important }", async ({ page }) => {
  // dusk.css wins on specificity (html[data-dusk] :is(img)) even against a
  // page's own !important on a plain img selector.
  await openTop(page, doc(`<img class="f" src="${Y}">`, `<style>img{filter:none !important}</style>`));
  await expectNatural("18c page !important filter", page);
});

test("19a img with opacity", async ({ page }) => {
  await openTop(page, doc(`<img class="f" src="${Y}" style="opacity:.99">`));
  await expectNatural("19a opacity", page);
});

test("19b img with mix-blend-mode", async ({ page }) => {
  await openTop(page, doc(`<div class="f" style="isolation:isolate;background:#fff"><img class="img" src="${Y}" style="mix-blend-mode:multiply"></div>`));
  await expectNatural("19b mix-blend-mode", page);
});

// ---------------------------------------------------------------- media elements

test("20 video poster", async ({ page }) => {
  await openTop(page, doc(`<video class="f" poster="${Y}"></video>`));
  await expectNatural("20 video poster", page, { x: 120, y: 120, w: 60, h: 60 });
});

test("21 canvas", async ({ page }) => {
  await openTop(page, doc(`<canvas id="c" class="f" width="100" height="100"></canvas><script>
    const g = c.getContext("2d"); g.fillStyle = "#ff0"; g.fillRect(0, 0, 100, 100);
  </script>`));
  await expectNatural("21 canvas", page);
});

test("22 same-origin iframe containing an img", async ({ page }) => {
  await openTop(page, doc(`<iframe class="f" style="border:0" srcdoc="<body style='margin:0'><img src='${Y}' width='100' height='100' style='display:block'></body>"></iframe>`));
  await expectNatural("22 iframe img", page);
});

test("23 img nested inside an element with a url background (no double flip)", async ({ page }) => {
  await openTop(page, doc(`<div class="f" style="background-image:url('${svg("#f00")}')"><img class="img" src="${Y}"></div>`));
  await expectNatural("23 nested in bg", page);
});

// ---------------------------------------------------------------- text, dark sites

test("24 color emoji in text", async ({ page }) => {
  test.fail(true, "LIMIT: emoji are text glyphs, inverted with the page (yellow face turns dark)");
  await openTop(page, doc(`<div class="f" style="font-size:80px;line-height:100px">😀</div>`));
  await expectNatural("24 emoji", page, { x: 110, y: 110, w: 80, h: 80 });
});

test("25 site with its own prefers-color-scheme: dark theme, system dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openTop(page, doc(`<img class="f" src="${Y}">`,
    `<style>@media (prefers-color-scheme: dark){ body{ background:#111 !important; color:#eee } }</style>`));
  const state = await page.evaluate(() => document.documentElement.hasAttribute("data-dusk"));
  expect(state, "Dusk must stay off on an already-dark site").toBe(false);
  await expectNatural("25 native dark theme", page);
});

test("26 large hero photo as a stylesheet background (over half the viewport)", async ({ page }) => {
  test.fail(true, "LIMIT: elements over 50% of the viewport are not re-inverted, to protect page wallpapers");
  await openTop(page, doc(`<div class="hero"></div>`,
    `<style>.hero{position:absolute;left:0;top:0;width:1200px;height:500px;background-image:url('${Y}');background-size:cover}</style>`));
  await expectNatural("26 big hero", page);
});

test("27 color fidelity of protected images (saturated swatches)", async ({ page }) => {
  // Not pass/fail on exact color: documents how much saturation survives.
  const sw = [["#ff0000", 0], ["#00ff00", 1], ["#0000ff", 2], ["#ffff00", 3], ["#e0ac69", 4], ["#808080", 5], ["#ffffff", 6], ["#000000", 7]];
  await openTop(page, doc(sw.map(([c, i]) => `<img src="${svg(c, 60, 60)}" style="position:absolute;left:${20 + i * 70}px;top:300px;width:60px;height:60px">`).join("")));
  const out = {};
  for (const [c, i] of sw) {
    const m = await measure(page, { x: 20 + i * 70 + 20, y: 320, w: 20, h: 20 });
    out[c] = m.center;
  }
  console.log("EDGE-FIDELITY " + JSON.stringify(out));
  // Lightness must not be inverted: white stays light, black stays dark.
  expect(out["#ffffff"].every((v) => v > 200)).toBe(true);
  expect(out["#000000"].every((v) => v < 60)).toBe(true);
  expect(Math.abs(out["#808080"][0] - 128)).toBeLessThan(25);
});

test.afterAll(() => {
  if (results.length) console.log("EDGE-SUMMARY " + JSON.stringify(results));
});
