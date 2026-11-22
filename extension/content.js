// Dusk content script.
//
// How it works: dusk.css (injected by Safari) inverts the page with a CSS
// filter, then re-inverts media (images, video, canvas, iframes) so they look
// normal. This script switches it on or off with a data-dusk attribute on
// <html>, passes your settings as CSS custom properties, and marks elements
// that CSS alone cannot recognise: photo backgrounds from stylesheets,
// originally dark blocks, modal scrims and ::before/::after photos. That
// marking runs in small slices right after a frame is painted, never forces
// layout, and stops while the tab is hidden or Dusk is off for the site.
//
// What it never does: network requests, reading page content, reading
// keystrokes, screenshots. It stores your settings, and which sites turned
// out to be dark already, so the next visit to them starts right.

(() => {
  "use strict";

  const ATTR = "data-dusk";
  const MEASURE = "data-dusk-measure";
  const api = typeof browser !== "undefined" ? browser : chrome;
  const host = location.hostname;
  const own = (obj, key) => obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);

  const DEFAULTS = {
    enabled: true,
    followSystem: false,
    siteModes: {},      // host -> "on" | "off"; missing means auto
    disabledSites: [],  // legacy (v1.0), read as "off"
    intensity: 90,
    warmth: 0,          // 0..100, a sepia tint for night reading
    dimImages: false,   // tone down bright photos on a dark page
  };

  const VARS = ["--dusk-a", "--dusk-c", "--dusk-s", "--dusk-img"];

  // Slider 50..100 maps to an invert amount of 0.80..1.00. Below about 0.75
  // light and dark collapse into the same gray and text becomes unreadable.
  function invertAmount(intensity) {
    const n = Number(intensity);
    const i = Math.min(100, Math.max(50, Number.isFinite(n) ? n : 90));
    return 0.8 + ((i - 50) / 50) * 0.2;
  }

  // Warmth 0..100 maps to sepia 0..0.5; more turns text muddy brown.
  function sepiaAmount(warmth) {
    const n = Number(warmth);
    return (Math.min(100, Math.max(0, Number.isFinite(n) ? n : 0)) / 100) * 0.5;
  }

  // XML documents (feeds, sitemaps) have a root without a style object.
  const styleable = (el) => !!el && !!el.style && typeof el.style.setProperty === "function";

  function apply() {
    const de = document.documentElement;
    if (!de) {
      // Very early in page load there may be no <html> yet. Wait for it once.
      const obs = new MutationObserver(() => {
        if (document.documentElement) {
          obs.disconnect();
          render();
        }
      });
      obs.observe(document, { childList: true });
      return;
    }
    if (!styleable(de)) return;
    const a = invertAmount(settings.intensity);
    // The page filter maps a color x to a + (1 - 2a)x. invert(1) followed by
    // contrast(1 / (2a - 1)) on media is the exact inverse, so photos keep
    // their real colors instead of looking washed out.
    const vars = {
      "--dusk-a": a.toFixed(3),
      "--dusk-c": (1 / (2 * a - 1)).toFixed(3),
      "--dusk-s": sepiaAmount(settings.warmth).toFixed(3),
      "--dusk-img": settings.dimImages === true ? "0.8" : "1",
    };
    for (const [k, v] of Object.entries(vars)) {
      // "important" so a page rule like html{--dusk-a:.1!important} cannot win.
      if (de.style.getPropertyValue(k) !== v || de.style.getPropertyPriority(k) !== "important") {
        de.style.setProperty(k, v, "important");
      }
    }
    if (!de.hasAttribute(ATTR)) de.setAttribute(ATTR, "");
    shadowSheetOn(true);
  }

  function remove() {
    const de = document.documentElement;
    shadowSheetOn(false);
    if (!styleable(de)) return;
    if (de.hasAttribute(ATTR)) de.removeAttribute(ATTR);
    for (const k of VARS) {
      if (de.style.getPropertyValue(k)) de.style.removeProperty(k);
    }
    if (de.getAttribute("style") === "") de.removeAttribute("style");
  }

  // ---- Colors ----------------------------------------------------------------
  // Computed colors come back as rgb()/rgba() for most pages, but also as
  // lab(), oklch(), color(display-p3 ...) and more. Rather than reimplement
  // every color space, anything that is not rgb() is converted by drawing it
  // on a 1x1 canvas, which gives sRGB like every other color here. Cached.
  const rgbaCache = new Map();
  let probe = null;

  function toRGBA(color) {
    const m = color.match(/^rgba?\(([^)]+)\)/);
    if (m) {
      const [r, g, b, a = 1] = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
      return [r, g, b, a];
    }
    let hit = rgbaCache.get(color);
    if (hit !== undefined) return hit;
    hit = null;
    try {
      if (!probe) {
        const c = document.createElement("canvas");
        c.width = c.height = 1;
        probe = c.getContext("2d", { willReadFrequently: true });
      }
      if (probe) {
        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle = "#000";
        probe.fillStyle = color;
        probe.fillRect(0, 0, 1, 1);
        const d = probe.getImageData(0, 0, 1, 1).data;
        hit = [d[0], d[1], d[2], d[3] / 255];
      }
    } catch { hit = null; }
    if (rgbaCache.size > 256) rgbaCache.clear();
    rgbaCache.set(color, hit);
    return hit;
  }

  const luma = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

  // Luminance of a computed CSS color, 0 (black) to 1 (white).
  // Returns null for colors that are transparent or see-through enough that
  // what is behind them decides the look (overlays, modal backdrops).
  function luminance(color) {
    const c = toRGBA(color);
    if (!c || !(c[3] >= 0.9)) return null;
    return luma(c);
  }

  // Background an element paints itself. A gradient counts by its first color stop.
  function ownBackground(el) {
    const cs = getComputedStyle(el);
    let lum = luminance(cs.backgroundColor);
    if (lum === null && cs.backgroundImage.includes("gradient")) {
      const stop = cs.backgroundImage.match(/(?:rgba?|color|oklch|oklab|lch|lab|hsla?|hwb)\([^)]*\)/);
      if (stop) lum = luminance(stop[0]);
    }
    return lum;
  }

  // The page's own <html> background. dusk.css forces it white, and
  // data-dusk-measure switches that one rule off for a moment. Changing <html>
  // while the filter is on can restyle the whole page in WebKit (about 60 ms
  // on MDN), so it is read only when a sample actually reaches <html>, and at
  // most once per check.
  let rootLum; // per check; undefined = not read yet
  function rootBackground() {
    if (rootLum !== undefined) return rootLum;
    const de = document.documentElement;
    const on = de.hasAttribute(ATTR);
    if (on) de.setAttribute(MEASURE, "");
    try { rootLum = ownBackground(de); } finally { if (on) de.removeAttribute(MEASURE); }
    return rootLum;
  }

  // Background of an element, or of the nearest ancestor that paints one.
  function backgroundAt(el) {
    for (; el && el.nodeType === 1; el = el.parentElement) {
      let lum = el === document.documentElement ? rootBackground() : ownBackground(el);
      // A transparent <html> shows the <body> background on the whole canvas,
      // even below a short body.
      if (lum === null && el === document.documentElement && document.body) {
        lum = ownBackground(document.body);
      }
      if (lum !== null) return lum;
    }
    return null;
  }

  // With nothing painted, the browser fills the page with its canvas color:
  // dark when the page's color-scheme resolves to dark (":root { color-scheme:
  // dark }", or "light dark" on a Mac in dark mode), else white.
  function canvasLum() {
    const cs = getComputedStyle(document.documentElement).colorScheme || "";
    const dark = /\bdark\b/.test(cs) && (!/\blight\b/.test(cs) || systemDark.matches);
    return dark ? 0.1 : 1;
  }

  // A site that is already dark should be left alone, or Dusk would turn it light.
  function pageIsAlreadyDark() {
    rootLum = undefined;
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta && /^\s*(only\s+)?dark\s*$/i.test(meta.content)) return true;

    // Sample what is actually painted, not just <body>: many dark sites keep
    // <body> transparent and paint the background on a wrapper element. Three
    // rows of five points, and two thirds must agree, so one dark hero or
    // promo box on a light site does not switch Dusk off for the whole site.
    // The outer columns sit in the page margins: a dark site paints edge to
    // edge, a light site with a big dark box (Medium's newsletter banner)
    // leaves them light.
    const w = innerWidth, h = innerHeight;
    if (w > 0 && h > 0) {
      let dark = 0, total = 0;
      const canvas = canvasLum();
      for (const fx of [0.03, 0.2, 0.5, 0.8, 0.97]) {
        for (const fy of [0.2, 0.5, 0.8]) {
          const el = document.elementFromPoint(w * fx, h * fy);
          let lum = el ? backgroundAt(el) : null;
          if (lum === null) lum = canvas; // nothing painted: the canvas shows
          total++;
          if (lum < 0.4) dark++;
        }
      }
      if (dark * 3 >= total * 2) return true;
      if ((total - dark) * 3 >= total * 2) return false;
    }

    const fallback = backgroundAt(document.body) ?? backgroundAt(document.documentElement) ?? canvasLum();
    return fallback < 0.4;
  }

  const systemDark = matchMedia("(prefers-color-scheme: dark)");

  let settings = { ...DEFAULTS };
  let siteIsDark = false;

  // Sites that follow the Mac's appearance are dark in dark mode only, so the
  // answer is remembered per host and appearance. Only dark sites get a key
  // (removed again if one turns light), so storage stays small, and one key
  // is read per page instead of a whole list.
  const darkKey = () => "dark:" + (systemDark.matches ? "d:" : "l:") + host;
  let rememberedDark = false; // what storage said for darkKey()

  function siteMode() {
    const modes = settings.siteModes;
    const mode = own(modes, host) ? modes[host] : undefined;
    if (mode === "on" || mode === "off") return mode;
    return Array.isArray(settings.disabledSites) && settings.disabledSites.includes(host) ? "off" : "auto";
  }

  // Why Dusk is or is not darkening this page. The popup shows it.
  function state() {
    if (settings.enabled === false) return "disabled";
    if (settings.followSystem === true && !systemDark.matches) return "system-light";
    const mode = siteMode();
    if (mode === "off") return "site-off";
    if (mode === "on") return "forced";
    return siteIsDark ? "already-dark" : "active";
  }

  // ---- Scheduling ----------------------------------------------------------
  // Dusk's background work runs right after a frame has been painted: the
  // page's styles and layout are fresh then, so reading computed styles is
  // cheap instead of forcing the browser to recalculate them early. While
  // the tab is hidden no frames are painted, so nothing runs at all.
  function afterPaint(cb) {
    requestAnimationFrame(() => setTimeout(cb, 0));
  }

  // ---- Shadow DOM ----------------------------------------------------------
  // Page stylesheets, dusk.css included, stop at a shadow root. Open shadow
  // roots get one shared constructed stylesheet with the media rules; it is
  // emptied while Dusk is off. Closed shadow roots cannot be reached.
  const MEDIA_SEL = ["img", "video", "picture", "canvas", "iframe", "embed", "object",
    'input[type="image" i]', "[data-dusk-bg]", "[data-dusk-keep]"];
  const MEDIA_F = "brightness(var(--dusk-img, 1)) invert(1) contrast(var(--dusk-c, 1.19)) hue-rotate(180deg)";
  const SHADOW_CSS = [
    `${MEDIA_SEL.join(", ")} { filter: ${MEDIA_F} !important; }`,
    `svg:has(image) { filter: ${MEDIA_F} !important; }`,
    `img[src*=".svg" i], img[src^="data:image/svg" i] { filter: none !important; }`,
    `${["[data-dusk-bg]", "[data-dusk-keep]"].flatMap((b) => MEDIA_SEL.map((m) => `${b} ${m}`)).join(", ")}, picture img { filter: none !important; }`,
    `[data-dusk-pb]::before, [data-dusk-pa]::after { filter: ${MEDIA_F} !important; }`,
  ];
  let shadowSheet = null;
  let shadowOn = false;
  const shadowRoots = new Set(); // only roots we attached to, cleared when off

  function shadowSheetOn(on) {
    if (on === shadowOn) return;
    shadowOn = on;
    if (!shadowSheet) return;
    try {
      // replaceSync drops rules a browser does not know, one by one.
      shadowSheet.replaceSync(on ? SHADOW_CSS.join("\n") : "");
    } catch { /* keep the previous rules */ }
  }

  function attachShadow(sr) {
    if (shadowRoots.has(sr)) return;
    shadowRoots.add(sr);
    try {
      if (!shadowSheet) {
        shadowSheet = new CSSStyleSheet();
        shadowSheet.replaceSync(shadowOn ? SHADOW_CSS.join("\n") : "");
      }
      if (!sr.adoptedStyleSheets.includes(shadowSheet)) {
        sr.adoptedStyleSheets = [...sr.adoptedStyleSheets, shadowSheet];
      }
    } catch { /* adoptedStyleSheets unavailable: images in this root stay inverted */ }
    if (bgObserver) bgObserver.observe(sr, OBSERVE);
    queueRoot(sr);
  }

  // ---- Marking -------------------------------------------------------------
  // CSS cannot select an element by its computed background, so the scanner
  // looks at each element once (the initial page, nodes added later) and
  // again only when its own class or style attribute changes (lazy-loaded
  // photos and avatars often get their image that way). Marks:
  //   data-dusk-bg     photo background, under half the viewport, little text
  //   data-dusk-keep   opaque near-black block on the original page
  //   data-dusk-scrim  translucent dark overlay behind a modal
  //   data-dusk-pb/pa  ::before / ::after shows a photo
  // Reads only computed styles, never layout: sizes come from an
  // IntersectionObserver, which reports them after layout without forcing it.
  const BG = "data-dusk-bg", KEEP = "data-dusk-keep", SCRIM = "data-dusk-scrim";
  const PB = "data-dusk-pb", PA = "data-dusk-pa";
  const MARKS = [BG, KEEP, SCRIM, PB, PA];
  const MAX_BOXES = 3000;    // filtered boxes cost an offscreen buffer each when on screen
  const KEEP_MIN_AREA = 30000;
  const TEXT_LIMIT = 200;    // a "photo" with more text than this is a content box
  const DESC_LIMIT = 40;
  const SLICE_MS = 5;
  const SVG_NS = "http://www.w3.org/2000/svg";
  // Subtrees that never paint a CSS background of their own, or that dusk.css
  // already handles by tag.
  const SKIP = new Set([
    "script", "style", "template", "noscript", "link", "meta", "title", "head",
    "img", "picture", "video", "audio", "canvas", "iframe", "embed", "object",
    "source", "track", "br", "wbr",
  ]);
  const scannable = (n) =>
    !SKIP.has(n.localName) && !(n.namespaceURI === SVG_NS && n.localName !== "svg");
  let seen = new WeakSet();  // elements the walkers already looked at
  const FILTER = {
    acceptNode(n) {
      // Seen subtrees were scanned already; anything added to them since was
      // queued on its own by the observer.
      if (!scannable(n) || seen.has(n)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  };
  const OBSERVE = { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] };

  let bgQueue = [];          // TreeWalkers still to finish
  let bgRecheck = new Set(); // elements whose class or style changed
  // An element whose class or style changed is checked once it has been
  // stable for RECHECK_MS: one that keeps flipping (hover effects,
  // animations, highlight toggles) is looked at once it settles, not on every
  // flip, so Dusk never marks and unmarks it in a loop.
  const RECHECK_MS = 50;
  let lastChange = new WeakMap();
  let recheckTimer = 0;
  let recheckReady = false;
  let bgScheduled = false;
  let bgObserver = null;
  let bgStarted = false;
  let sizer = null;
  let boxes = 0;             // elements currently carrying BG or KEEP
  let sizing = 0;            // elements waiting for their size
  let measuring = new WeakSet();
  // Latest classification per element waiting for its size. The size arrives
  // a frame later, so an element can change meanwhile; only the latest counts.
  let wanted = new WeakMap();

  // First url() layer that is not an SVG (SVG backgrounds are icons, sprites
  // and placeholders drawn in one color: they read right when inverted).
  function photoUrl(value) {
    if (!value || value === "none" || !value.includes("url(")) return false;
    const re = /url\(\s*(["']?)(.*?)\1\s*\)/g;
    let m;
    while ((m = re.exec(value))) {
      const u = m[2];
      if (!/^data:image\/svg/i.test(u) && !/\.svg(?:[?#]|$)/i.test(u)) return true;
    }
    return false;
  }

  // What, if anything, an element needs. Reads one computed style (two more
  // for leaf elements, whose ::before/::after may draw an icon photo).
  function classify(el) {
    const cs = getComputedStyle(el);
    const info = { bg: false, keep: false, scrim: 0, pb: false, pa: false };
    info.bg = photoUrl(cs.backgroundImage);
    const bg = toRGBA(cs.backgroundColor);
    if (bg && bg[3] > 0) {
      const lum = luma(bg);
      if (bg[3] >= 0.9) {
        if (lum < 0.08) info.keep = true;
      } else if (bg[3] >= 0.15 && lum < 0.3 && (cs.position === "fixed" || cs.position === "absolute")) {
        info.scrim = bg[3];
      }
    }
    // ::before/::after photos sit on empty icon elements (<i>, <span>). Only
    // those are checked: two extra style reads per element would double the
    // scanner's cost on text-heavy pages for no gain.
    if (el.childElementCount === 0 && !el.textContent.trim()) {
      const b = getComputedStyle(el, "::before"), a = getComputedStyle(el, "::after");
      info.pb = photoUrl(b.backgroundImage) || photoUrl(b.content);
      info.pa = photoUrl(a.backgroundImage) || photoUrl(a.content);
    }
    return info;
  }

  const wantsAny = (i) => i.bg || i.keep || i.scrim > 0 || i.pb || i.pa;

  // Photos are re-inverted with everything inside them. A box full of text,
  // or one holding a panel with its own background and text (a chat bubble
  // over a pattern), is content: leave it with the page. A small child with a
  // background and no text (an avatar's presence dot) is part of the picture.
  function photoLike(el) {
    const kids = el.getElementsByTagName("*");
    if (kids.length > DESC_LIMIT) return false;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let chars = 0;
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      chars += t.data.trim().length;
      if (chars > TEXT_LIMIT) return false;
    }
    if (chars === 0) return true;
    for (const k of kids) {
      const c = toRGBA(getComputedStyle(k).backgroundColor);
      if (c && c[3] >= 0.9 && k.textContent.trim()) return false;
    }
    return true;
  }

  function setMark(el, attr, on) {
    if (on === el.hasAttribute(attr)) return;
    if (attr === BG || attr === KEEP) {
      if (on && boxes >= MAX_BOXES) {
        // The count drifts up as marked elements leave the page (infinite
        // feeds): recount the real number before refusing.
        boxes = document.querySelectorAll(`[${BG}], [${KEEP}]`).length;
        if (boxes >= MAX_BOXES) return;
      }
      boxes += on ? 1 : -1;
    }
    if (on) el.setAttribute(attr, "");
    else el.removeAttribute(attr);
  }

  function applyInfo(el, info, area, viewport) {
    if (!el.isConnected) return;
    const small = !(viewport > 0 && area > 0.5 * viewport);
    setMark(el, BG, info.bg && small && photoLike(el));
    setMark(el, KEEP, info.keep && small && area >= KEEP_MIN_AREA && !el.hasAttribute(BG));
    const scrim = info.scrim > 0 && viewport > 0 && area >= 0.4 * viewport;
    const alpha = info.scrim.toFixed(3);
    if (scrim && el.style.getPropertyValue("--dusk-scrim-a") !== alpha) {
      el.style.setProperty("--dusk-scrim-a", alpha, "important");
    }
    else if (el.hasAttribute(SCRIM)) el.style.removeProperty("--dusk-scrim-a");
    setMark(el, SCRIM, scrim);
    setMark(el, PB, info.pb && small);
    setMark(el, PA, info.pa && small);
  }

  // Unmark at once what no longer applies; measure what might.
  function decide(el, info) {
    if (!wantsAny(info)) {
      wanted.delete(el);
      for (const m of MARKS) if (el.hasAttribute(m)) applyInfo(el, info, 0, 0);
      return;
    }
    wanted.set(el, info);
    if (!sizer) {
      sizer = new IntersectionObserver((entries) => {
        const viewport = innerWidth * innerHeight;
        for (const e of entries) {
          const t = e.target;
          sizer.unobserve(t);
          if (measuring.has(t)) { measuring.delete(t); sizing--; }
          const latest = wanted.get(t);
          if (!latest) continue; // changed its mind meanwhile
          wanted.delete(t);
          const r = e.boundingClientRect;
          applyInfo(t, latest, r.width * r.height, viewport);
        }
      });
    }
    if (!measuring.has(el)) { measuring.add(el); sizing++; sizer.observe(el); }
  }

  function bgSlice() {
    bgScheduled = false;
    const end = performance.now() + SLICE_MS;
    const skip = new Set([document.documentElement, document.body]);
    const settled = performance.now() - RECHECK_MS;
    let recheckDone = true;
    const todo = [];
    if (recheckReady) for (const el of bgRecheck) {
      if ((lastChange.get(el) || 0) > settled) continue; // still changing
      bgRecheck.delete(el);
      if (el.isConnected && !skip.has(el) && scannable(el)) todo.push([el, classify(el)]);
      if (performance.now() >= end) { recheckDone = false; break; }
    }
    while (bgQueue.length && performance.now() < end) {
      // walker.currentNode is always the next node still to check.
      const walker = bgQueue[0];
      if (!walker.root.isConnected) { bgQueue.shift(); continue; } // removed meanwhile
      let el = walker.currentNode;
      while (el) {
        if (el.nodeType === 1 && !seen.has(el)) {
          seen.add(el);
          if (!skip.has(el)) {
            const info = classify(el);
            if (wantsAny(info)) todo.push([el, info]);
          }
          if (el.shadowRoot) attachShadow(el.shadowRoot);
        }
        el = walker.nextNode();
        if (performance.now() >= end) break;
      }
      if (!el) bgQueue.shift(); // this subtree is done
    }
    if (recheckReady && recheckDone) recheckReady = false;
    for (const [el, info] of todo) decide(el, info);
    if (bgQueue.length || (recheckReady && bgRecheck.size)) scheduleBg();
    else if (bgRecheck.size) {
      // Wake up when the next element has been stable long enough.
      let soonest = Infinity;
      for (const el of bgRecheck) soonest = Math.min(soonest, lastChange.get(el) || 0);
      armRecheck(soonest + RECHECK_MS - performance.now());
    }
  }

  function armRecheck(delay = RECHECK_MS) {
    if (recheckTimer || recheckReady) return;
    recheckTimer = setTimeout(() => { recheckTimer = 0; recheckReady = true; scheduleBg(); }, Math.max(10, delay));
  }

  function scheduleBg() {
    if (!bgScheduled) { bgScheduled = true; afterPaint(bgSlice); }
  }

  function queueRoot(root) {
    bgQueue.push(document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, FILTER));
    scheduleBg();
  }

  function queueBg(node) {
    if (!node || node.nodeType !== 1 || seen.has(node) || !scannable(node)) return;
    queueRoot(node);
  }

  function startBgScan() {
    if (!document.body || document.visibilityState === "hidden") return;
    if (!bgObserver) {
      bgObserver = new MutationObserver((records) => {
        for (const r of records) {
          if (r.type === "attributes") { bgRecheck.add(r.target); lastChange.set(r.target, performance.now()); }
          else for (const node of r.addedNodes) queueBg(node);
        }
        if (bgRecheck.size) armRecheck();
      });
      bgObserver.observe(document.body, OBSERVE);
      for (const sr of shadowRoots) bgObserver.observe(sr, OBSERVE);
    }
    if (!bgStarted) {
      bgStarted = true;
      queueBg(document.body);
    }
  }

  // Drops every DOM reference Dusk holds. Marks already set stay; they do
  // nothing while Dusk is off.
  function stopBgScan() {
    if (bgObserver) { bgObserver.disconnect(); bgObserver = null; }
    if (sizer) { sizer.disconnect(); sizer = null; }
    sizing = 0;
    measuring = new WeakSet();
    wanted = new WeakMap();
    seen = new WeakSet(); // rescan on next start: the page changed meanwhile
    clearTimeout(recheckTimer);
    recheckTimer = 0;
    recheckReady = false;
    bgQueue = [];
    bgRecheck.clear();
    shadowRoots.clear();
    bgStarted = false;
  }

  // ---- Already-dark sites --------------------------------------------------
  // Only needed while the site is on Auto. Runs in the next animation frame,
  // after the page's own DOMContentLoaded and load handlers: that is before
  // the frame is painted, so a dark site never shows inverted, and the layout
  // it needs is the one that frame computes anyway.
  let darkStale = true;      // a check is due (page start, load, appearance or mode change)
  let darkScheduled = false;

  function needsDarkCheck() {
    return settings.enabled !== false && !(settings.followSystem === true && !systemDark.matches) && siteMode() === "auto";
  }

  // Web apps often paint their dark theme seconds after DOMContentLoaded.
  // Until the page has loaded, a check may only switch Dusk off (light to
  // dark), never back on: a half-built page can look light, and trusting it
  // would invert a dark site for a moment. From load on, every check counts
  // and the result is remembered for the next visit.
  const EARLY_CHECKS = [300, 800, 1600]; // ms after DOMContentLoaded
  let earlyTimers = [];

  function remember(dark) {
    if (dark === rememberedDark) return;
    rememberedDark = dark;
    try {
      const p = dark ? api.storage.local.set({ [darkKey()]: 1 }) : api.storage.local.remove(darkKey());
      if (p && p.catch) p.catch(() => {});
    } catch { /* extension context gone */ }
  }

  function checkDark() {
    darkScheduled = false;
    if (!needsDarkCheck()) return; // measured later, if the site is set back to Auto
    const final = document.readyState === "complete";
    const dark = pageIsAlreadyDark();
    darkStale = false; // the early checks are scheduled by their own timers
    if (final) {
      siteIsDark = dark;
      remember(dark);
    } else if (dark) {
      siteIsDark = true;
    }
    render();
  }

  function scheduleDarkCheck() {
    if (darkScheduled || document.readyState === "loading") return;
    darkScheduled = true;
    requestAnimationFrame(checkDark);
  }

  function scheduleEarlyChecks() {
    for (const t of earlyTimers) clearTimeout(t);
    earlyTimers = EARLY_CHECKS.map((ms) => setTimeout(() => {
      if (document.readyState !== "complete" && !siteIsDark && needsDarkCheck()) scheduleDarkCheck();
    }, ms));
  }

  let lastRoot = document.documentElement;
  let lastBody = document.body;

  function render() {
    // document.open() or a page replacing <html>/<body> leaves the old
    // observers watching a detached tree: start over on the new one.
    if (document.documentElement !== lastRoot || document.body !== lastBody) {
      lastRoot = document.documentElement;
      lastBody = document.body;
      stopBgScan();
      watchRoot();
    }
    const s = state();
    if (s === "active" || s === "forced") {
      apply();
      startBgScan();
    } else {
      remove();
      stopBgScan();
    }
    if (darkStale && needsDarkCheck()) scheduleDarkCheck();
  }

  // ---- Self-repair ---------------------------------------------------------
  // A page script that removes data-dusk or rewrites <html style> would undo
  // Dusk until the next tab switch. One cheap observer on <html> itself (not
  // its subtree) puts it back, at most once per frame.
  // Repairs run at once (before the next paint, so nothing flashes), but at
  // most REPAIR_MAX times per second: a page fighting back cannot make Dusk
  // spin, it just gets repaired once per frame after that.
  let rootObserver = null;
  let repairQueued = false;
  let repairs = 0, repairWindow = 0;
  const REPAIR_MAX = 30;
  function watchRoot() {
    if (rootObserver) rootObserver.disconnect();
    const de = document.documentElement;
    if (!de) return;
    rootObserver = new MutationObserver(() => {
      const now = performance.now();
      if (now - repairWindow > 1000) { repairWindow = now; repairs = 0; }
      if (++repairs <= REPAIR_MAX) { render(); return; }
      if (repairQueued) return;
      repairQueued = true;
      requestAnimationFrame(() => { repairQueued = false; render(); });
    });
    // One observe() call: a second call on the same node replaces the options.
    // childList: <body> may arrive later, or be replaced.
    rootObserver.observe(de, { attributes: true, attributeFilter: [ATTR, "style"], childList: true });
  }
  watchRoot();
  new MutationObserver(() => {
    if (document.documentElement !== lastRoot) render();
  }).observe(document, { childList: true });

  function loadSettings() {
    try {
      const key = darkKey();
      return api.storage.local.get({ ...DEFAULTS, [key]: 0 }).then((stored) => {
        const { [key]: dark, ...rest } = stored || {};
        settings = { ...DEFAULTS, ...rest };
        rememberedDark = dark === 1;
        // Start from what the last visit found; the checks below still run
        // and correct it once the page has loaded.
        if (darkStale) siteIsDark = rememberedDark;
        render();
      }).catch(render);
    } catch {
      // Extension context gone (Dusk updated or removed): keep defaults.
      render();
      return Promise.resolve();
    }
  }

  // Apply right away to avoid a white flash, then correct once settings load.
  render();
  loadSettings();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { render(); scheduleEarlyChecks(); }, { once: true });
  } else if (document.readyState === "interactive") {
    scheduleEarlyChecks();
  }
  // Pages that paint their theme late (web apps) get one more look, after the
  // page's own load handlers (this listener is registered before theirs).
  if (document.readyState !== "complete") {
    addEventListener("load", () => setTimeout(() => { darkStale = true; render(); }, 0), { once: true });
  }

  // The Mac switched appearance: sites that follow it change too. Start from
  // what was remembered for the new appearance and measure again.
  systemDark.addEventListener("change", () => {
    darkStale = true;
    try {
      const key = darkKey();
      api.storage.local.get({ [key]: 0 }).then((r) => {
        rememberedDark = !!r && r[key] === 1;
        siteIsDark = rememberedDark;
        render();
      }).catch(render);
    } catch { render(); }
  });

  // A page restored from the back/forward cache may have missed setting changes.
  addEventListener("pageshow", (e) => { if (e.persisted) loadSettings(); });
  // Hidden tabs do no work and hold no DOM references; catch up when shown.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") stopBgScan();
    else render();
  });

  try {
    // Live updates when you flip a switch in the popup.
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      let relevant = false;
      for (const [key, { newValue }] of Object.entries(changes)) {
        if (own(DEFAULTS, key)) { settings[key] = newValue ?? DEFAULTS[key]; relevant = true; }
      }
      // Another tab remembering a dark site is not a settings change.
      if (relevant) render();
    });

    api.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "dusk:state") return Promise.resolve({ state: state() });
    });
  } catch { /* extension context gone */ }
})();
