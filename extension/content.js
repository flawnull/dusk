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

  const DEFAULTS = { enabled: true, disabledSites: [], intensity: 90 };

  function css(intensity) {
    const amount = Math.min(100, Math.max(50, intensity)) / 100;
    return `
      html {
        filter: invert(${amount}) hue-rotate(180deg) !important;
        background-color: #fff !important;
        color-scheme: light !important;
      }
      img, video, picture, canvas, iframe, embed, object,
      svg image, [style*="background-image"] {
        filter: invert(1) hue-rotate(180deg) !important;
      }
      /* Do not flip media twice when it sits inside a re-inverted box. */
      [style*="background-image"] img,
      [style*="background-image"] video,
      [style*="background-image"] picture,
      picture img, picture source {
        filter: none !important;
      }
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
    el.textContent = css(intensity);
  }

  function remove() {
    const el = document.getElementById(STYLE_ID);
    if (el) el.remove();
  }

  // Luminance of a CSS color string, 0 (black) to 1 (white).
  // Returns null for transparent colors.
  function luminance(color) {
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (a < 0.1) return null;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  // A site that is already dark should be left alone, or Dusk would turn it light.
  // Computed colors are not affected by CSS filters, so this works while Dusk is on.
  function pageIsAlreadyDark() {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const lum = luminance(getComputedStyle(el).backgroundColor);
      if (lum !== null) return lum < 0.4;
    }
    return false;
  }

  let settings = { ...DEFAULTS };
  let siteIsDark = false;

  function shouldRun() {
    return settings.enabled && !settings.disabledSites.includes(host) && !siteIsDark;
  }

  function render() {
    if (shouldRun()) apply(settings.intensity);
    else remove();
  }

  // Apply right away to avoid a white flash, then correct once settings load.
  render();

  api.storage.local.get(DEFAULTS).then((stored) => {
    settings = { ...DEFAULTS, ...stored };
    render();
  }).catch(render);

  function checkDark() {
    // Temporarily drop our style so we read the page's own colors cleanly.
    remove();
    siteIsDark = pageIsAlreadyDark();
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", checkDark, { once: true });
  } else {
    checkDark();
  }

  // Live updates when you flip a switch in the popup.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue ?? DEFAULTS[key];
    }
    render();
  });
})();
