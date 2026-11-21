// Dusk content script.
//
// How it works: one <style> tag inverts the page with a CSS filter, then
// re-inverts media (images, video, canvas, iframes) so they look normal.
// There is no DOM walking, no MutationObserver and no per-element work, so
// the cost stays flat no matter how big or busy the page is.
//
// What it never does: network requests, reading page content, reading
// keystrokes, screenshots. The only thing it stores is your settings.

(() => {
  "use strict";

  const STYLE_ID = "dusk-dark-style";
  const api = typeof browser !== "undefined" ? browser : chrome;
  const host = location.hostname;

  const DEFAULTS = {
    enabled: true,
    followSystem: false,
    siteModes: {},      // host -> "on" | "off"; missing means auto
    disabledSites: [],  // legacy (v1.0), read as "off"
    intensity: 90,
  };

  // Slider 50..100 maps to an invert amount of 0.80..1.00. Below about 0.75
  // light and dark collapse into the same gray and text becomes unreadable.
  function invertAmount(intensity) {
    const i = Math.min(100, Math.max(50, Number(intensity) || 90));
    return 0.8 + ((i - 50) / 50) * 0.2;
  }

  function css(intensity) {
    const a = invertAmount(intensity);
    const page = `invert(${a.toFixed(3)}) hue-rotate(180deg)`;
    // The page filter maps a color x to a + (1 - 2a)x. A plain invert(1) on
    // media only cancels that when a = 1, otherwise photos look washed out.
    // invert(1) followed by contrast(1 / (2a - 1)) is the exact inverse.
    const media = `invert(1) contrast(${(1 / (2 * a - 1)).toFixed(3)}) hue-rotate(180deg)`;
    const mediaSel = "img, video, picture, canvas, iframe, embed, object, svg image";
    return `
      html {
        filter: ${page} !important;
        background-color: #fff !important;
        color-scheme: light !important;
      }
      ${mediaSel}, [style*="background-image"] {
        filter: ${media} !important;
      }
      /* Do not flip media twice when it sits inside a re-inverted box. */
      [style*="background-image"] :is(${mediaSel}),
      picture img, picture source {
        filter: none !important;
      }
      /* Modal dialogs and popovers render in the top layer, outside the
         page filter, so they need their own. */
      dialog:modal, :popover-open {
        filter: ${page} !important;
      }
      /* Fullscreen also escapes the page filter: show it in natural colors.
         Kept as separate rules so one unknown selector cannot void the other. */
      :fullscreen, :fullscreen :is(${mediaSel}) { filter: none !important; }
      :-webkit-full-screen, :-webkit-full-screen :is(${mediaSel}) { filter: none !important; }
      ::selection { background: #3a5f9e; color: #fff; }
    `;
  }

  function apply(intensity) {
    const root = document.head || document.documentElement;
    if (!root) {
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
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement("style");
      el.id = STYLE_ID;
      root.appendChild(el);
    }
    const text = css(intensity);
    if (el.textContent !== text) el.textContent = text;
  }

  function remove() {
    const el = document.getElementById(STYLE_ID);
    if (el) el.remove();
  }

  // Luminance of a computed CSS color, 0 (black) to 1 (white).
  // Returns null for transparent or unparseable colors.
  function luminance(color) {
    let m = color.match(/^rgba?\(([^)]+)\)/);
    if (m) {
      const [r, g, b, a = 1] = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
      if (a < 0.1) return null;
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }
    m = color.match(/^color\(srgb ([^)]+)\)/);
    if (m) {
      const [r, g, b, a = 1] = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat);
      if (a < 0.1) return null;
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    // oklch(L ...), oklab(L ...), lch(L% ...), lab(L% ...): use lightness.
    m = color.match(/^(ok)?(?:lch|lab)\(\s*([\d.]+)(%?)[^/)]*(?:\/\s*([\d.]+)(%?))?/);
    if (m) {
      const alpha = m[4] === undefined ? 1 : parseFloat(m[4]) / (m[5] ? 100 : 1);
      if (alpha < 0.1) return null;
      const l = parseFloat(m[2]);
      const lightness = m[1] ? (m[3] ? l / 100 : l) : l / 100;
      return Math.pow(lightness, 2.2); // perceptual lightness to rough luminance
    }
    return null;
  }

  // Background of an element, or of the nearest ancestor that paints one.
  // Computed colors are not affected by CSS filters, so this works while Dusk is on.
  function backgroundAt(el) {
    for (; el && el.nodeType === 1; el = el.parentElement) {
      const lum = luminance(getComputedStyle(el).backgroundColor);
      if (lum !== null) return lum;
    }
    return null;
  }

  // A site that is already dark should be left alone, or Dusk would turn it light.
  function pageIsAlreadyDark() {
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta && /^\s*(only\s+)?dark\s*$/i.test(meta.content)) return true;

    // Sample what is actually painted, not just <body>: many dark sites keep
    // <body> transparent and paint the background on a wrapper element.
    const w = innerWidth, h = innerHeight;
    const points = [[w / 2, h / 2], [w / 2, h * 0.2], [w * 0.2, h * 0.6], [w * 0.8, h * 0.6]];
    let dark = 0, light = 0;
    for (const [x, y] of points) {
      const el = document.elementFromPoint(x, y);
      let lum = el ? backgroundAt(el) : null;
      if (lum === null) lum = 1; // nothing painted: the canvas is white
      if (lum < 0.4) dark++; else light++;
    }
    if (dark + light > 0 && dark !== light) return dark > light;

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

  function render() {
    const s = state();
    if (s === "active" || s === "forced") apply(settings.intensity);
    else remove();
  }

  // Apply right away to avoid a white flash, then correct once settings load.
  render();

  api.storage.local.get(DEFAULTS).then((stored) => {
    settings = { ...DEFAULTS, ...stored };
    render();
  }).catch(render);

  function checkDark() {
    siteIsDark = pageIsAlreadyDark();
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", checkDark, { once: true });
  } else {
    checkDark();
  }
  // Pages that paint their theme late (web apps) get one more look.
  if (document.readyState !== "complete") {
    addEventListener("load", checkDark, { once: true });
  }

  systemDark.addEventListener("change", render);

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
