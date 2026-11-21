// Dusk content script.
//
// How it works: dusk.css (injected by Safari) inverts the page with a CSS
// filter, then re-inverts media (images, video, canvas, iframes) so they look
// normal. This script only switches it on or off with a data-dusk attribute
// on <html> and passes your settings as CSS custom properties. There is
// no DOM walking, no MutationObserver on the page and no per-element work, so
// the cost stays flat no matter how big or busy the page is.
//
// What it never does: network requests, reading page content, reading
// keystrokes, screenshots. The only thing it stores is your settings.

(() => {
  "use strict";

  const ATTR = "data-dusk";
  const api = typeof browser !== "undefined" ? browser : chrome;
  const host = location.hostname;

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
      if (de.style.getPropertyValue(k) !== v) de.style.setProperty(k, v);
    }
    if (!de.hasAttribute(ATTR)) de.setAttribute(ATTR, "");
  }

  function remove() {
    const de = document.documentElement;
    if (!de) return;
    if (de.hasAttribute(ATTR)) de.removeAttribute(ATTR);
    for (const k of VARS) {
      if (de.style.getPropertyValue(k)) de.style.removeProperty(k);
    }
    if (de.getAttribute("style") === "") de.removeAttribute("style");
  }

  // Luminance of a computed CSS color, 0 (black) to 1 (white).
  // Returns null for colors that are transparent or see-through enough that
  // what is behind them decides the look (overlays, modal backdrops).
  function luminance(color) {
    const OPAQUE = 0.9;
    let m = color.match(/^rgba?\(([^)]+)\)/);
    if (m) {
      const [r, g, b, a = 1] = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
      if (a < OPAQUE) return null;
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }
    m = color.match(/^color\((?:srgb|srgb-linear|display-p3|a98-rgb|rec2020) ([^)]+)\)/);
    if (m) {
      const [r, g, b, a = 1] = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat);
      if (a < OPAQUE) return null;
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    // oklch(L ...), oklab(L ...), lch(L% ...), lab(L% ...): use lightness.
    m = color.match(/^(ok)?(?:lch|lab)\(\s*([\d.]+)(%?)[^/)]*(?:\/\s*([\d.]+)(%?))?/);
    if (m) {
      const alpha = m[4] === undefined ? 1 : parseFloat(m[4]) / (m[5] ? 100 : 1);
      if (alpha < OPAQUE) return null;
      const l = parseFloat(m[2]);
      const lightness = m[1] ? (m[3] ? l / 100 : l) : l / 100;
      return Math.pow(lightness, 2.2); // perceptual lightness to rough luminance
    }
    return null;
  }

  // Background an element paints itself. A gradient counts by its first color stop.
  function ownBackground(el) {
    const cs = getComputedStyle(el);
    let lum = luminance(cs.backgroundColor);
    if (lum === null && cs.backgroundImage.includes("gradient")) {
      const stop = cs.backgroundImage.match(/(?:rgba?|color|oklch|oklab|lch|lab)\([^)]*\)/);
      if (stop) lum = luminance(stop[0]);
    }
    return lum;
  }

  // Background of an element, or of the nearest ancestor that paints one.
  function backgroundAt(el) {
    for (; el && el.nodeType === 1; el = el.parentElement) {
      let lum = ownBackground(el);
      // A transparent <html> shows the <body> background on the whole canvas,
      // even below a short body.
      if (lum === null && el === document.documentElement && document.body) {
        lum = ownBackground(document.body);
      }
      if (lum !== null) return lum;
    }
    return null;
  }

  // A site that is already dark should be left alone, or Dusk would turn it light.
  // Call only while dusk.css is switched off: it forces <html> to white.
  function pageIsAlreadyDark() {
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta && /^\s*(only\s+)?dark\s*$/i.test(meta.content)) return true;

    // Sample what is actually painted, not just <body>: many dark sites keep
    // <body> transparent and paint the background on a wrapper element.
    const w = innerWidth, h = innerHeight;
    if (w > 0 && h > 0) {
      const points = [[w / 2, h / 2], [w / 2, h * 0.2], [w * 0.2, h * 0.6], [w * 0.8, h * 0.6]];
      let dark = 0, light = 0;
      for (const [x, y] of points) {
        const el = document.elementFromPoint(x, y);
        let lum = el ? backgroundAt(el) : null;
        if (lum === null) lum = 1; // nothing painted: the canvas is white
        if (lum < 0.4) dark++; else light++;
      }
      if (dark !== light) return dark > light;
    }

    const fallback = backgroundAt(document.body) ?? backgroundAt(document.documentElement);
    return fallback !== null && fallback < 0.4;
  }

  const systemDark = matchMedia("(prefers-color-scheme: dark)");

  let settings = { ...DEFAULTS };
  let siteIsDark = false;

  function siteMode() {
    const mode = settings.siteModes && settings.siteModes[host];
    if (mode === "on" || mode === "off") return mode;
    return (settings.disabledSites || []).includes(host) ? "off" : "auto";
  }

  // Why Dusk is or is not darkening this page. The popup shows it.
  function state() {
    if (!settings.enabled) return "disabled";
    if (settings.followSystem && !systemDark.matches) return "system-light";
    const mode = siteMode();
    if (mode === "off") return "site-off";
    if (mode === "on") return "forced";
    return siteIsDark ? "already-dark" : "active";
  }

  // Background images set from a stylesheet (not inline) cannot be matched by
  // a CSS selector, so they would stay inverted. Find them in idle time and
  // mark them with data-dusk-bg; dusk.css re-inverts marked elements.
  // Cheap by design: work runs in small time slices, reads only computed
  // styles, writes attributes in one batch per slice, and only looks at
  // nodes once (the initial page, then nodes added later).
  const BG_ATTR = "data-dusk-bg";
  const SLICE_MS = 6;
  const idle = typeof requestIdleCallback === "function"
    ? (cb) => requestIdleCallback(cb, { timeout: 1000 })
    : (cb) => setTimeout(cb, 50);
  let bgQueue = [];       // TreeWalkers still to finish
  let bgScheduled = false;
  let bgObserver = null;
  let bgStarted = false;

  function hasUrlBackground(el) {
    const bi = getComputedStyle(el).backgroundImage;
    return bi !== "none" && bi.includes("url(");
  }

  function bgTooBig(el) {
    // A page-wide texture or wallpaper must stay inverted with the page,
    // or the whole page would turn light again.
    const viewport = innerWidth * innerHeight;
    const r = el.getBoundingClientRect();
    return viewport > 0 && r.width * r.height > 0.5 * viewport;
  }

  function bgSlice() {
    bgScheduled = false;
    const end = performance.now() + SLICE_MS;
    const found = [];
    const skip = new Set([document.documentElement, document.body]);
    while (bgQueue.length) {
      // walker.currentNode is always the next node still to check.
      const walker = bgQueue[0];
      let el = walker.currentNode;
      while (el) {
        if (el.isConnected && !skip.has(el) && !el.hasAttribute(BG_ATTR) && hasUrlBackground(el)) {
          found.push(el);
        }
        el = walker.nextNode();
        if (performance.now() >= end) break;
      }
      if (!el) bgQueue.shift(); // this subtree is done
      if (performance.now() >= end) break;
    }
    // Layout reads first, attribute writes last, so the slice causes at most
    // one style recalculation.
    const mark = found.filter((el) => el.isConnected && !bgTooBig(el));
    for (const el of mark) el.setAttribute(BG_ATTR, "");
    if (bgQueue.length) scheduleBg();
  }

  function scheduleBg() {
    if (!bgScheduled) { bgScheduled = true; idle(bgSlice); }
  }

  function queueBg(root) {
    if (!root || root.nodeType !== 1) return;
    bgQueue.push(document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT));
    scheduleBg();
  }

  function startBgScan() {
    if (!document.body) return; // DOMContentLoaded calls render() again
    if (!bgStarted) {
      bgStarted = true;
      queueBg(document.body);
    }
    if (!bgObserver) {
      bgObserver = new MutationObserver((records) => {
        for (const r of records) for (const node of r.addedNodes) queueBg(node);
      });
      bgObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  function stopBgScan() {
    if (bgObserver) { bgObserver.disconnect(); bgObserver = null; }
    bgQueue = [];
    bgStarted = false; // rescan on next start: the page changed meanwhile
  }

  function render() {
    const s = state();
    if (s === "active" || s === "forced") {
      apply();
      startBgScan();
    } else {
      remove();
      stopBgScan();
    }
  }

  function loadSettings() {
    return api.storage.local.get(DEFAULTS).then((stored) => {
      settings = { ...DEFAULTS, ...stored };
      render();
    }).catch(render);
  }

  // Apply right away to avoid a white flash, then correct once settings load.
  render();
  loadSettings();

  function checkDark() {
    // Read the page's own colors with Dusk switched off. Off and back on in
    // the same task, so nothing is painted in between and nothing flashes.
    const de = document.documentElement;
    const wasOn = !!de && de.hasAttribute(ATTR);
    if (wasOn) de.removeAttribute(ATTR);
    siteIsDark = pageIsAlreadyDark();
    if (wasOn) de.setAttribute(ATTR, "");
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", checkDark, { once: true });
  } else {
    checkDark();
  }
  // Pages that paint their theme late (web apps) get one more look.
  // Deferred, because this listener is registered first and would otherwise
  // run before the page's own load handlers that switch its theme.
  if (document.readyState !== "complete") {
    addEventListener("load", () => setTimeout(checkDark, 0), { once: true });
  }

  systemDark.addEventListener("change", render);

  // A page restored from the back/forward cache may have missed setting changes.
  addEventListener("pageshow", (e) => { if (e.persisted) loadSettings(); });
  // Cheap self-repair if a page script rebuilt <html> attributes.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") render();
  });

  // Live updates when you flip a switch in the popup.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue ?? DEFAULTS[key];
    }
    render();
  });

  api.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "dusk:state") return Promise.resolve({ state: state() });
  });
})();
