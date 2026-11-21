// @ts-check
// Property-based tests (fast-check) against the real content script in WebKit.
//
// 1. Colour parser: random colours in every CSS syntax, applied as a real
//    background. Dusk's dark/light verdict on the computed value is compared
//    with an independent reference: the same colour painted on a canvas and
//    read back as sRGB bytes. Dusk's own definition of "dark" is luma
//    (0.2126 R + 0.7152 G + 0.0722 B on 0..255 sRGB values) below 0.4, and
//    alpha below 0.9 counts as transparent; the reference uses exactly that.
//    Colours within 0.03 of the threshold are skipped (rounding noise).
// 2. Settings: random and junk storage values must never throw and must
//    always produce a known state and finite, in-range CSS variables.
// 3. DOM trees: the background-image scanner must terminate and mark exactly
//    the qualifying elements.
const { test, expect } = require("@playwright/test");
const fc = require("fast-check");
const { open, scannerIdle } = require("../robust-helpers");

const SEED = Number(process.env.FUZZ_SEED || 20261121);
const STATES = ["disabled", "system-light", "site-off", "forced", "already-dark", "active"];

// ---------------------------------------------------------------- colours --

const byte = fc.integer({ min: 0, max: 255 });
const unit = fc.integer({ min: 0, max: 1000 }).map((n) => n / 1000); // uniform: fc.double skews to the ends
const pct = fc.integer({ min: 0, max: 100 });
const hue = fc.integer({ min: 0, max: 359 });
const alpha = fc.oneof(fc.constant(1), unit);
const f3 = (x) => Number(x.toFixed(3));
const hex2 = (n) => n.toString(16).padStart(2, "0");

const FAMILIES = {
  hex: fc.tuple(byte, byte, byte, fc.option(byte, { nil: undefined }), fc.boolean())
    .map(([r, g, b, a, short]) => short && a === undefined
      ? `#${(r >> 4).toString(16)}${(g >> 4).toString(16)}${(b >> 4).toString(16)}`
      : `#${hex2(r)}${hex2(g)}${hex2(b)}${a === undefined ? "" : hex2(a)}`),
  "rgb-legacy": fc.tuple(byte, byte, byte, alpha).map(([r, g, b, a]) => a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${f3(a)})`),
  "rgb-modern": fc.tuple(pct, pct, pct, alpha).map(([r, g, b, a]) => `rgb(${r}% ${g}% ${b}% / ${f3(a)})`),
  hsl: fc.tuple(hue, pct, pct, alpha).map(([h, s, l, a]) => `hsl(${h} ${s}% ${l}% / ${f3(a)})`),
  hwb: fc.tuple(hue, pct, pct).map(([h, w, b]) => `hwb(${h} ${w}% ${b}%)`),
  named: fc.constantFrom("black", "white", "navy", "darkslategray", "gainsboro", "rebeccapurple", "gold", "midnightblue",
    "silver", "dimgray", "gray", "darkgray", "lightgray", "teal", "maroon", "ivory", "orange", "crimson"),
  system: fc.constantFrom("Canvas", "CanvasText", "ButtonFace", "ButtonText", "Field", "FieldText", "GrayText",
    "Highlight", "HighlightText", "LinkText", "Mark", "MarkText", "SelectedItem", "AccentColor"),
  "keyword": fc.constantFrom("currentColor", "transparent"),
  "color-mix-srgb": fc.tuple(byte, byte, pct).map(([a, b, p]) => `color-mix(in srgb, rgb(${a} ${a} ${a}) ${p}%, rgb(${b} ${b} ${b}))`),
  "color(srgb)": fc.tuple(unit, unit, unit).map(([r, g, b]) => `color(srgb ${f3(r)} ${f3(g)} ${f3(b)})`),
  "color(display-p3)": fc.tuple(unit, unit, unit).map(([r, g, b]) => `color(display-p3 ${f3(r)} ${f3(g)} ${f3(b)})`),
  "color(a98-rgb)": fc.tuple(unit, unit, unit).map(([r, g, b]) => `color(a98-rgb ${f3(r)} ${f3(g)} ${f3(b)})`),
  "color(rec2020)": fc.tuple(unit, unit, unit).map(([r, g, b]) => `color(rec2020 ${f3(r)} ${f3(g)} ${f3(b)})`),
  "color(srgb-linear)": fc.tuple(unit, unit, unit).map(([r, g, b]) => `color(srgb-linear ${f3(r)} ${f3(g)} ${f3(b)})`),
  "color(xyz)": fc.tuple(unit, unit, unit).map(([x, y, z]) => `color(xyz ${f3(x)} ${f3(y)} ${f3(z)})`),
  "color(prophoto-rgb)": fc.tuple(unit, unit, unit).map(([r, g, b]) => `color(prophoto-rgb ${f3(r)} ${f3(g)} ${f3(b)})`),
  lab: fc.tuple(pct, fc.integer({ min: -100, max: 100 }), fc.integer({ min: -100, max: 100 })).map(([l, a, b]) => `lab(${l}% ${a} ${b})`),
  lch: fc.tuple(pct, fc.integer({ min: 0, max: 150 }), hue).map(([l, c, h]) => `lch(${l}% ${c} ${h})`),
  oklab: fc.tuple(unit, fc.integer({ min: -300, max: 300 }).map((n) => n / 1000), fc.integer({ min: -300, max: 300 }).map((n) => n / 1000))
    .map(([l, a, b]) => `oklab(${f3(l)} ${f3(a)} ${f3(b)})`),
  oklch: fc.tuple(pct, fc.integer({ min: 0, max: 370 }).map((n) => n / 1000), hue).map(([l, c, h]) => `oklch(${l}% ${f3(c)} ${h})`),
};

// Compares Dusk's verdict with the canvas reference for a batch of colours.
// Returns the mismatches.
async function checkColours(page, colours) {
  return page.evaluate((colours) => {
    const d = window.__duskDebug;
    const el = document.getElementById("probe");
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const g = cv.getContext("2d", { willReadFrequently: true });
    const bad = [];
    for (const c of colours) {
      el.style.backgroundColor = "";
      el.style.backgroundColor = c;
      const computed = getComputedStyle(el).backgroundColor;
      const dusk = d.luminance(computed);
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = "rgba(0,0,0,0)";
      g.fillStyle = computed;
      g.fillRect(0, 0, 1, 1);
      const [r, gg, b, a] = g.getImageData(0, 0, 1, 1).data;
      const alpha = a / 255;
      if (Math.abs(alpha - 0.9) < 0.01) continue; // alpha rounding at the edge
      const ref = alpha < 0.9 ? null : (0.2126 * r + 0.7152 * gg + 0.0722 * b) / 255;
      if (ref === null && dusk === null) continue;
      if (ref === null || dusk === null) {
        bad.push({ c, computed, dusk, ref, why: dusk === null ? "unparsed: Dusk treats as transparent" : "opacity disagrees" });
        continue;
      }
      if (Math.abs(ref - 0.4) < 0.03) continue;
      if ((dusk < 0.4) !== (ref < 0.4)) bad.push({ c, computed, dusk: Number(dusk.toFixed(3)), ref: Number(ref.toFixed(3)), why: "verdict differs" });
    }
    return bad;
  }, colours);
}

// Families Dusk reads correctly. Each runs 200 colours (2 x 100).
const GOOD = ["hex", "rgb-legacy", "rgb-modern", "hsl", "hwb", "named", "system", "keyword", "color-mix-srgb", "color(srgb)", "color(a98-rgb)"];
// Families Dusk misreads (see BUG notes).
const BAD = {
  lab: "BUG: content.js:103-109 reads lab() lightness as L^2.2 (linear-light), but the rgb() path compares gamma-encoded luma; lab(60% 0 0) == rgb(145,145,145) is 'light' as rgb but 'dark' as lab",
  lch: "BUG: content.js:103-109 same L^2.2 vs gamma-luma mismatch for lch()",
  oklab: "BUG: content.js:103-109 same mismatch for oklab() (Tailwind v4 and color-mix(in oklab) produce these)",
  oklch: "BUG: content.js:103-109 same mismatch for oklch() (Tailwind v4 palette is oklch)",
  "color(display-p3)": "BUG: content.js:96-100 reads display-p3 components as if they were sRGB (small error, flips verdicts near the threshold)",
  "color(rec2020)": "BUG: content.js:96-100 reads rec2020 components as if they were sRGB (different transfer curve)",
  "color(srgb-linear)": "BUG: content.js:96-100 treats linear-light srgb-linear components as gamma-encoded sRGB",
  "color(xyz)": "BUG: content.js:96 regex has no xyz / xyz-d50 / xyz-d65: these colours count as transparent",
  "color(prophoto-rgb)": "BUG: content.js:96 regex has no prophoto-rgb: these colours count as transparent",
};

test.describe("colour parser vs canvas reference", () => {
  test.describe.configure({ mode: "parallel" });
  const BODY = '<!doctype html><body><div id="probe" style="width:10px;height:10px"></div></body>';

  for (const fam of GOOD) {
    test(`${fam}: Dusk verdict matches the canvas`, async ({ page }) => {
      await open(page, { body: BODY });
      const seen = [];
      await fc.assert(
        fc.asyncProperty(fc.array(FAMILIES[fam], { minLength: 100, maxLength: 100 }), async (batch) => {
          const bad = await checkColours(page, batch);
          seen.push(...bad);
          return bad.length === 0;
        }),
        { numRuns: 2, seed: SEED, endOnFailure: true },
      );
      expect(seen).toEqual([]);
    });
  }

  for (const [fam, note] of Object.entries(BAD)) {
    test(`${fam}: Dusk verdict matches the canvas`, async ({ page }) => {
      await open(page, { body: BODY });
      const bad = await checkColours(page, fc.sample(FAMILIES[fam], { numRuns: 200, seed: SEED }));
      test.info().annotations.push({ type: "mismatches", description: `${bad.length}/200 e.g. ${JSON.stringify(bad.slice(0, 2))}` });
      expect(bad).toEqual([]);
    });
  }

  // End to end on fresh pages, no debug hook involved: the popup state for a
  // page whose whole background is the colour must match the reference.
  test("end to end: page background verdicts for rgb/hsl/hex", async ({ browser }) => {
    const colours = fc.sample(fc.oneof(FAMILIES.hex, FAMILIES["rgb-legacy"], FAMILIES.hsl), { numRuns: 24, seed: SEED })
      .filter((c) => !/rgba|#.{8}$|\/ (?!1\))/.test(c)); // opaque only
    const wrong = [];
    for (const c of colours) {
      const page = await browser.newPage();
      await open(page, { body: `<!doctype html><html style="background:${c}"><body style="margin:0;min-height:100vh"></body></html>`, debug: false });
      const state = await page.evaluate(() => window.__duskSend({ type: "dusk:state" }).then((r) => r.state));
      const ref = await page.evaluate((c) => {
        const cv = document.createElement("canvas"); cv.width = cv.height = 1;
        const g = cv.getContext("2d"); g.fillStyle = c; g.fillRect(0, 0, 1, 1);
        const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
        return (0.2126 * r + 0.7152 * gg + 0.0722 * b) / 255;
      }, c);
      if (Math.abs(ref - 0.4) >= 0.03 && (state === "already-dark") !== (ref < 0.4)) wrong.push({ c, state, ref });
      await page.close();
    }
    expect(wrong).toEqual([]);
  });
});

// --------------------------------------------------------------- settings --

const junk = fc.oneof(
  fc.boolean(), fc.integer(), fc.double(), fc.string({ maxLength: 12 }), fc.constant(null),
  fc.constant(Number.MAX_VALUE), fc.constant(-1e308), fc.array(fc.oneof(fc.string({ maxLength: 8 }), fc.integer()), { maxLength: 4 }),
  fc.dictionary(fc.string({ maxLength: 8 }), fc.oneof(fc.string({ maxLength: 4 }), fc.integer()), { maxKeys: 3 }),
);
const modeValue = fc.oneof(fc.constantFrom("on", "off", "auto", "ON", "", "__proto__"), junk);
const hostKeys = fc.constantFrom("example.test", "__proto__", "constructor", "toString", "hasOwnProperty", "", "other.test");

// Well-typed settings with hostile values: numbers out of range, NaN, huge,
// strings in number slots, prototype-ish keys in siteModes.
const typedSettings = fc.record({
  enabled: fc.boolean(),
  followSystem: fc.boolean(),
  intensity: fc.oneof(fc.integer({ min: -1000, max: 1000 }), fc.double(), fc.string({ maxLength: 5 }), fc.constant(null)),
  warmth: fc.oneof(fc.integer({ min: -1000, max: 1000 }), fc.double(), fc.string({ maxLength: 5 }), fc.constant(null)),
  dimImages: fc.oneof(fc.boolean(), fc.constant("true"), fc.constant(1)),
  siteModes: fc.dictionary(hostKeys, modeValue, { maxKeys: 4 }),
  disabledSites: fc.array(fc.oneof(hostKeys, fc.string({ maxLength: 10 })), { maxLength: 4 }),
}, { requiredKeys: [] });

// Anything at all in any slot.
const anySettings = fc.record({
  enabled: junk, followSystem: junk, intensity: junk, warmth: junk, dimImages: junk, siteModes: junk, disabledSites: junk,
}, { requiredKeys: [] });

async function checkSettings(page, log, items) {
  const before = log.errors.length;
  await page.evaluate((i) => window.__duskSet(i), items);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 5)));
  return page.evaluate(({ STATES, newErrors }) => {
    const d = window.__duskDebug;
    const problems = [...newErrors];
    let s;
    try { s = d.state(); } catch (e) { problems.push("state() threw: " + e); }
    if (s !== undefined && !STATES.includes(s)) problems.push("unknown state " + s);
    const de = document.documentElement;
    const on = de.hasAttribute("data-dusk");
    if ((s === "active" || s === "forced") !== on) problems.push(`state ${s} but data-dusk=${on}`);
    if (on) {
      const v = (k) => Number(de.style.getPropertyValue(k));
      const a = v("--dusk-a"), c = v("--dusk-c"), sp = v("--dusk-s"), img = v("--dusk-img");
      if (!(a >= 0.8 && a <= 1)) problems.push("--dusk-a " + a);
      if (!(c >= 1 && c <= 1.67)) problems.push("--dusk-c " + c);
      if (!(sp >= 0 && sp <= 0.5)) problems.push("--dusk-s " + sp);
      if (!(img === 1 || img === 0.8)) problems.push("--dusk-img " + img);
    }
    return problems;
  }, { STATES, newErrors: log.errors.slice(before) });
}

test.describe("settings fuzz", () => {
  test("well-typed but hostile values: 400 random settings, live updates", async ({ page }) => {
    const log = await open(page);
    const seen = [];
    await fc.assert(fc.asyncProperty(typedSettings, async (s) => {
      const p = await checkSettings(page, log, s);
      if (p.length) seen.push({ s, p });
      return p.length === 0;
    }), { numRuns: 400, seed: SEED, endOnFailure: true });
    expect(seen).toEqual([]);
  });

  test("any type in any slot: 400 random settings, live updates", async ({ page }) => {
    const log = await open(page);
    const seen = [];
    await fc.assert(fc.asyncProperty(anySettings, async (s) => {
      const p = await checkSettings(page, log, s);
      if (p.length) seen.push({ s, p });
      return p.length === 0;
    }), { numRuns: 400, seed: SEED, endOnFailure: true });
    test.info().annotations.push({ type: "first failure", description: JSON.stringify(seen[0]) });
    expect(seen).toEqual([]);
  });

  test("well-typed hostile values at first load (fresh pages)", async ({ browser }) => {
    const samples = fc.sample(typedSettings, { numRuns: 30, seed: SEED });
    const bad = [];
    for (const s of samples) {
      const page = await browser.newPage();
      const log = await open(page, { settings: s });
      const p = await checkSettings(page, log, {});
      if (p.length) bad.push({ s, p });
      await page.close();
    }
    expect(bad).toEqual([]);
  });
});

// -------------------------------------------------------------- DOM trees --

// Builds a random tree in the page from a seed, runs the scanner to idle, and
// returns elements the scanner got wrong.
async function scanTree(page, spec) {
  await page.evaluate((spec) => {
    let x = spec.seed >>> 0;
    const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
    const IMG = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
    const kinds = ["plain", "plain", "plain", "cls-small", "inline-small", "cls-big", "gradient", "none", "hidden", "shorthand"];
    const root = document.createElement("div");
    root.id = "root";
    let made = 0;
    const node = () => {
      const el = document.createElement(rnd() < 0.1 ? "span" : "div");
      const k = kinds[Math.floor(rnd() * kinds.length)];
      el.dataset.kind = k;
      if (k === "cls-small") el.className = "bgs";
      if (k === "inline-small") el.setAttribute("style", `display:block;width:12px;height:12px;background-image:url(${IMG})`);
      if (k === "cls-big") el.className = "bgb";
      if (k === "gradient") el.style.backgroundImage = "linear-gradient(red, blue)";
      if (k === "none") el.style.backgroundImage = "none";
      if (k === "hidden") { el.className = "bgs"; el.style.display = "none"; }
      if (k === "shorthand") el.setAttribute("style", `display:block;width:9px;height:9px;background:url(${IMG}) no-repeat`);
      made++;
      return el;
    };
    if (spec.shape === "chain") {
      let cur = root;
      for (let i = 0; i < spec.depth; i++) { const n = node(); cur.appendChild(n); cur = n; }
    } else {
      // random tree: each new node goes under a random existing node,
      // biased so depth and width both vary
      const all = [root];
      for (let i = 0; i < spec.count; i++) {
        const parent = all[Math.floor(Math.pow(rnd(), spec.bias) * all.length)];
        const n = node(); parent.appendChild(n); all.push(n);
      }
    }
    document.body.appendChild(root);
    window.__made = made;
  }, spec);
  const ms = await scannerIdle(page, 60000);
  const result = await page.evaluate(() => {
    // Measure the layout the page would have without Dusk: Dusk's own
    // re-invert filters change the containing block of position:fixed
    // descendants (covered separately in hostile.spec.js).
    const de = document.documentElement;
    de.removeAttribute("data-dusk");
    const vp = innerWidth * innerHeight;
    const wrong = [];
    let expected = 0, marked = 0, skipped = 0;
    for (const el of document.querySelectorAll("*")) {
      const bi = getComputedStyle(el).backgroundImage;
      const r = el.getBoundingClientRect();
      const should = el !== document.documentElement && el !== document.body &&
        bi !== "none" && bi.includes("url(") && !(r.width * r.height > 0.5 * vp) &&
        // A photo box holds at most 40 elements; more is a content box with a
        // textured background, left inverted with the page.
        el.getElementsByTagName("*").length <= 40;
      const is = el.hasAttribute("data-dusk-bg");
      // position:fixed under a marked ancestor: its size depends on Dusk's own
      // filter (the fixed-containing-block bug in hostile.spec.js). Skip here.
      if (getComputedStyle(el).position === "fixed" && el.parentElement && el.parentElement.closest("[data-dusk-bg]")) { skipped++; continue; }
      if (should) expected++;
      if (is) marked++;
      if (should !== is && wrong.length < 5) wrong.push({ tag: el.tagName, kind: el.dataset.kind, should, is, area: Math.round(r.width * r.height) });
    }
    if (document.documentElement.hasAttribute("data-dusk-bg") || document.body.hasAttribute("data-dusk-bg")) wrong.push("html/body marked");
    de.setAttribute("data-dusk", "");
    return { wrong, expected, marked, skipped, made: window.__made };
  });
  return { ...result, ms };
}

const TREE_CSS = `<style>
  body{margin:0}
  .bgs{display:block;width:16px;height:16px;background-image:url(data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==)}
  .bgb{position:fixed;inset:0;background-image:url(data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==)}
</style>`;

test.describe("scanner on random DOM trees", () => {
  test.describe.configure({ mode: "parallel", timeout: 120000 });

  test("40 random trees (up to 3000 nodes, mixed depth/width): exactly the qualifying elements", async ({ page }) => {
    await open(page, { body: `<!doctype html><head>${TREE_CSS}</head><body></body>` });
    const fails = [];
    await fc.assert(fc.asyncProperty(
      fc.record({ seed: fc.integer({ min: 1, max: 2 ** 31 - 1 }), count: fc.integer({ min: 1, max: 3000 }), bias: fc.double({ min: 0.2, max: 4, noNaN: true }) }),
      async (spec) => {
        await page.evaluate(() => document.getElementById("root")?.remove());
        const r = await scanTree(page, { ...spec, shape: "random" });
        if (r.ms < 0 || r.wrong.length) { fails.push({ spec, ...r }); console.log("TREEFAIL", JSON.stringify({ spec, ...r })); }
        return r.ms >= 0 && r.wrong.length === 0;
      }), { numRuns: 40, seed: SEED, endOnFailure: true });
    expect(fails).toEqual([]);
  });

  test("depth 2000 chain", async ({ page }) => {
    await open(page, { body: `<!doctype html><head>${TREE_CSS}</head><body></body>` });
    const r = await scanTree(page, { seed: 7, shape: "chain", depth: 2000 });
    test.info().annotations.push({ type: "time to idle", description: `${Math.round(r.ms)} ms, ${r.marked} marked` });
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.wrong).toEqual([]);
  });

  test("width 5000 (flat)", async ({ page }) => {
    await open(page, { body: `<!doctype html><head>${TREE_CSS}</head><body></body>` });
    const r = await scanTree(page, { seed: 9, shape: "random", count: 5000, bias: 0.0001 });
    test.info().annotations.push({ type: "time to idle", description: `${Math.round(r.ms)} ms, ${r.marked} marked` });
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.wrong).toEqual([]);
  });
});
