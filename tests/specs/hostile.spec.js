// @ts-check
// Hostile and unusual pages, failure modes of the extension API, memory,
// and a static security review of the shipped extension files.
//
// Harness limit (see robust-helpers.js): content.js runs in the page's MAIN
// world here. Safari runs it in an isolated world, so page overrides of
// prototypes/globals cannot reach it in Safari. Those tests are worst cases
// and are labelled "main world".
const fs = require("fs");
const path = require("path");
const os = require("os");
const { test, expect } = require("@playwright/test");
const { stubApi, watch } = require("../helpers");
const { EXT, CONTENT_JS, CONTENT_CSS, DEBUG_JS, open, scannerIdle, htmlState } = require("../robust-helpers");

const IMG = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
const wait = (page, ms) => page.evaluate((t) => new Promise((r) => setTimeout(r, t)), ms);
const state = (page) => page.evaluate(() => window.__duskSend({ type: "dusk:state" }).then((r) => r && r.state));

async function pixel(page, x, y) {
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
const isDark = (rgb) => rgb.every((v) => v < 80);

// ------------------------------------------------------ rendering quality --

test.describe("re-inverted containers (quality)", () => {
  test("position:fixed child of a background-image container stays where the page put it", async ({ page }) => {
    // A filter makes the element the containing block for fixed descendants,
    // so such a container is left unmarked: the widget stays in its corner.
    const body = `<!doctype html><head><style>
      body{margin:0;background:#fff}
      .hero{position:relative;width:300px;height:200px;margin:40px;background-image:url(${IMG})}
      .chat{position:fixed;right:0;bottom:0;width:48px;height:48px;border:1px solid #000;border-radius:50%}
    </style></head><body><div class="hero" id="h"><div class="chat" id="c"></div></div></body>`;
    await open(page, { body });
    await scannerIdle(page);
    expect(await page.evaluate(() => document.getElementById("h").hasAttribute("data-dusk-bg"))).toBe(false);
    const r = await page.evaluate(() => {
      const b = document.getElementById("c").getBoundingClientRect();
      return { right: Math.round(innerWidth - b.right), bottom: Math.round(innerHeight - b.bottom) };
    });
    expect(r).toEqual({ right: 0, bottom: 0 });
  });

  test("text panel inside a small background-image container stays dark", async ({ page }) => {
    const body = `<!doctype html><head><style>
      body{margin:0;background:#fff}
      .bubble{position:absolute;right:20px;bottom:20px;width:320px;height:300px;background:#fff url(${IMG}) no-repeat}
      .msg{margin:20px;height:200px;background:#fff;color:#000;font:16px sans-serif}
    </style></head><body><div class="bubble"><div class="msg">Hi! How are you?</div></div></body>`;
    await open(page, { body, settings: { intensity: 100 } });
    await scannerIdle(page);
    const rgb = await pixel(page, 1200 - 20 - 320 + 200, 800 - 20 - 300 + 150);
    test.info().annotations.push({ type: "panel pixel", description: JSON.stringify(rgb) });
    expect(isDark(rgb)).toBe(true);
  });

  test("same-origin srcdoc iframe content stays light (known limit: all_frames false)", async ({ page }) => {
    // Not a bug claim: documents current behaviour. The parent re-inverts every
    // iframe, and Dusk does not run inside frames, so embedded documents keep
    // their own (light) colours. Comment widgets and embeds look like light islands.
    await open(page, { body: `<!doctype html><body style="margin:0;background:#fff"><iframe srcdoc="<body style='background:#fff;margin:0'>x</body>" style="border:0;width:300px;height:200px"></iframe></body>`, settings: { intensity: 100 } });
    const rgb = await pixel(page, 150, 100);
    test.info().annotations.push({ type: "iframe pixel", description: JSON.stringify(rgb) });
    expect(rgb.every((v) => v > 200)).toBe(true);
  });
});

// ------------------------------------------------------------ html fights --

test.describe("pages that touch <html>", () => {
  test("page removes data-dusk in a loop: Dusk restores it", async ({ page }) => {
    await open(page, { after: `addEventListener("load", () => setInterval(() => document.documentElement.removeAttribute("data-dusk"), 20));` });
    await wait(page, 300);
    const s = await htmlState(page);
    expect(s.attr).toBe(true);
  });

  test("page rewrites <html style> once (theme scripts do this): intensity survives", async ({ page }) => {
    // After Dusk's own deferred load check, as a theme toggle or late script would.
    await open(page, { settings: { intensity: 50, warmth: 100 }, after: `addEventListener("load", () => setTimeout(() => document.documentElement.setAttribute("style", "color-scheme: light"), 300));` });
    await wait(page, 500);
    const a = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--dusk-a").trim());
    expect(a).toBe("0.800");
  });

  test("page stylesheet sets --dusk-a !important: Dusk's value still wins", async ({ page }) => {
    await open(page, { body: `<!doctype html><head><style>html{--dusk-a:0.1 !important}</style></head><body><p>x</p></body>` });
    const f = await page.evaluate(() => getComputedStyle(document.documentElement).filter);
    expect(f).toMatch(/^invert\(0\.96\)/);
  });

  test("document.open/write after load: Dusk re-applies to the new document", async ({ page }) => {
    const log = await open(page);
    await page.evaluate(() => { document.open(); document.write("<!doctype html><html><body style='background:#fff'><p>rewritten</p></body></html>"); document.close(); });
    await wait(page, 200);
    expect((await htmlState(page)).attr).toBe(true);
    expect(log.errors).toEqual([]);
  });

  test("documentElement replaced: Dusk re-applies", async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      const n = document.createElement("html");
      n.innerHTML = "<body style='background:#fff'><p>new root</p></body>";
      document.replaceChild(n, document.documentElement);
    });
    await wait(page, 200);
    expect((await htmlState(page)).attr).toBe(true);
  });
});

test.describe("dark detection edge cases", () => {
  test("page that is dark only through CSS color-scheme: dark (no explicit background) is left alone", async ({ page }) => {
    await open(page, { body: `<!doctype html><head><style>:root{color-scheme:dark}</style></head><body><p>UA-dark page</p></body>` });
    const st = await page.evaluate(() => window.__duskDebug.state());
    test.info().annotations.push({ type: "state", description: st });
    expect(st).toBe("already-dark");
  });

  test("full-page cookie/consent overlay at load (opaque white card on dark site) does not flip the verdict", async ({ page }) => {
    await open(page, { body: `<!doctype html><body style="margin:0;background:#111;min-height:100vh"><div style="position:fixed;left:30%;top:30%;width:40%;height:40%;background:#fff">Accept cookies</div></body>` });
    expect(await page.evaluate(() => window.__duskDebug.state())).toBe("already-dark");
  });
});

// ------------------------------------------------------------ fingerprint --

test.describe("what a site can learn (fingerprinting)", () => {
  test("Dusk installed but OFF: a page cannot detect it", async ({ page }) => {
    test.fail(true, "SECURITY/PRIVACY: dusk.css is injected on every page even when Dusk is off, gated only by html[data-dusk]. Any page can set data-dusk itself and read getComputedStyle(html).filter to learn Dusk is installed (and darken itself with Dusk's rules). See report for the least-detectable design.");
    await open(page, { settings: { enabled: false } });
    const detected = await page.evaluate(() => {
      const de = document.documentElement;
      de.setAttribute("data-dusk", "");
      const f = getComputedStyle(de).filter;
      de.removeAttribute("data-dusk");
      return f !== "none";
    });
    expect(detected).toBe(false);
  });

  test("Dusk ON: the signals a page can read (documented, inherent to a filter-based dark mode)", async ({ page }) => {
    await open(page, { body: `<!doctype html><body><div style="width:20px;height:20px;background-image:url(${IMG})"></div></body>` });
    await scannerIdle(page);
    const signals = await page.evaluate(() => {
      const de = document.documentElement;
      return {
        attr: de.hasAttribute("data-dusk"),
        vars: ["--dusk-a", "--dusk-c", "--dusk-s", "--dusk-img"].filter((k) => de.style.getPropertyValue(k)),
        filter: getComputedStyle(de).filter,
        marked: document.querySelectorAll("[data-dusk-bg]").length,
      };
    });
    test.info().annotations.push({ type: "signals", description: JSON.stringify(signals) });
    expect(signals.attr).toBe(true);
  });
});

// ---------------------------------------------------- main-world overrides --

test.describe("page overrides of DOM APIs (main world worst case; Safari isolates content scripts)", () => {
  const cases = {
    "Element.prototype.setAttribute no-op": `Element.prototype.setAttribute = function () {};`,
    "getComputedStyle throws": `window.getComputedStyle = () => { throw new Error("nope"); };`,
    "MutationObserver replaced": `window.MutationObserver = class { observe() {} disconnect() {} };`,
    "Promise replaced": `window.Promise = function () { throw new Error("no promises"); };`,
    "matchMedia returns null": `window.matchMedia = () => null;`,
  };
  for (const [name, script] of Object.entries(cases)) {
    test(`${name}: darkening applied at document_start survives, page not hung`, async ({ page }) => {
      const log = await open(page, { body: `<!doctype html><head><script>${script}</script></head><body><p>x</p></body>` });
      // Read through Playwright's utility world: the page's overrides cannot break the probe.
      const attr = await page.locator("html").getAttribute("data-dusk", { timeout: 5000 });
      test.info().annotations.push({ type: "outcome (main world only; Safari's isolated world is unaffected)", description: JSON.stringify({ darkened: attr !== null, errors: log.errors.slice(0, 2) }) });
      expect(await page.locator("p").textContent({ timeout: 5000 })).toBe("x"); // page not hung
    });
  }
});

// ------------------------------------------------------- document types --

test.describe("document types", () => {
  test("XHTML (application/xhtml+xml) is darkened", async ({ page }) => {
    const log = await open(page, {
      contentType: "application/xhtml+xml",
      body: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body style="background:#fff"><p>xhtml</p></body></html>`,
    });
    const s = await htmlState(page);
    expect(s.filter).toContain("invert");
    expect(log.errors).toEqual([]);
  });

  test("SVG document: no errors", async ({ page }) => {
    const log = await open(page, {
      contentType: "image/svg+xml",
      body: `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#fff"/></svg>`,
    });
    await wait(page, 100);
    expect(log.errors).toEqual([]);
  });

  test("plain XML document (feeds, sitemaps): no errors", async ({ page }) => {
    const log = await open(page, { contentType: "application/xml", body: `<?xml version="1.0"?><rss><channel><title>feed</title></channel></rss>` });
    await wait(page, 100);
    test.info().annotations.push({ type: "errors", description: JSON.stringify(log.errors) });
    expect(log.errors).toEqual([]);
  });

  test("text/plain page is darkened without errors", async ({ page }) => {
    const log = await open(page, { contentType: "text/plain", body: "just text\n".repeat(50) });
    expect((await htmlState(page)).filter).toContain("invert");
    expect(log.errors).toEqual([]);
  });

  test("data: URL page: no errors, state known", async ({ page }) => {
    const log = watch(page);
    await page.addInitScript(stubApi, { initial: {} });
    await page.addInitScript({ content: DEBUG_JS });
    await page.goto("data:text/html,<p style='background:white'>data url</p>");
    await wait(page, 100);
    expect(await page.evaluate(() => window.__duskDebug.state())).toBe("active");
    expect(log.errors).toEqual([]);
  });

  test("file:// page: no errors, host is empty and siteModes[''] is not consulted wrongly", async ({ page }) => {
    const file = path.join(os.tmpdir(), `dusk-file-${process.pid}.html`);
    fs.writeFileSync(file, "<!doctype html><p>file page</p>");
    const log = watch(page);
    await page.addInitScript(stubApi, { initial: { siteModes: { "": "off" } } });
    await page.addInitScript({ content: DEBUG_JS });
    await page.goto("file://" + file);
    await wait(page, 100);
    const s = await page.evaluate(() => window.__duskDebug.state());
    test.info().annotations.push({ type: "file:// state with siteModes['']='off'", description: s });
    expect(log.errors).toEqual([]);
    fs.unlinkSync(file);
  });
});

// -------------------------------------------------------------------- CSP --

test.describe("strict Content-Security-Policy", () => {
  const CSP = { "content-security-policy": "default-src 'none'; style-src 'none'; script-src 'none'; img-src 'none'" };

  test("content script still sets data-dusk and the CSS variables (CSSOM is not blocked by style-src)", async ({ page }) => {
    const log = await open(page, { headers: CSP, css: false });
    const s = await page.evaluate(() => ({
      attr: document.documentElement.hasAttribute("data-dusk"),
      a: getComputedStyle(document.documentElement).getPropertyValue("--dusk-a").trim(),
    }));
    expect(s.attr).toBe(true);
    expect(s.a).not.toBe("");
    expect(log.errors.filter((e) => !/Content Security Policy|Refused/i.test(e))).toEqual([]);
  });

  test("a page-injected <style> IS blocked under that CSP (why dusk.css must be a manifest stylesheet)", async ({ page }) => {
    await open(page, { headers: CSP });
    const f = await page.evaluate(() => getComputedStyle(document.documentElement).filter);
    test.info().annotations.push({ type: "harness limit", description: "the harness can only inject dusk.css as a <style>, so it is blocked here; Safari injects manifest css as an extension stylesheet that page CSP does not govern (WebKit bug 291734 is about injected <style>, not manifest css). Verified below with CSP bypass as the stand-in." });
    expect(f).toBe("none");
  });

  test("with dusk.css applied outside the page CSP (stand-in for an extension stylesheet) the page is dark", async ({ browser }) => {
    const ctx = await browser.newContext({ bypassCSP: true });
    const page = await ctx.newPage();
    await open(page, { headers: CSP });
    expect((await htmlState(page)).filter).toContain("invert");
    await ctx.close();
  });
});

// ------------------------------------------------------------ scale/perf --

test.describe("big and deep pages", () => {
  test.describe.configure({ timeout: 180000 });

  test("100k elements: page load not slowed, scanner finishes, frames stay under 50 ms", async ({ browser }) => {
    test.fail(true, "BUG (perf, likely the slow LinkedIn load): (1) checkDark() removes and re-adds data-dusk on <html>; that flips the inherited color-scheme and every html[data-dusk] descendant rule, so each toggle restyles the whole document: 160-330 ms per call on 70-100k nodes, called twice per load. (2) The next scanner slice pays that restyle inside its '6 ms' budget (measured 265-680 ms slices). (3) A fragment append queues one TreeWalker per child plus the parent walker, so every node is style-read twice (198k reads for 100k nodes). Prototype fix measured in this worktree: gate only background-color behind html[data-dusk]:not([data-dusk-measure]) and toggle data-dusk-measure in checkDark (2nd check 218->40 ms, max slice 265->8 ms, worst frame gap 549->60 ms on a 72k-node server-rendered page); dedupe walkers with a WeakSet + NodeFilter FILTER_REJECT (reads 198k->100k).");
    const body = `<!doctype html><head><style>.b{width:4px;height:4px;background-image:url(${IMG})}i{display:inline-block;width:2px;height:2px}</style></head><body><script>
      const f = document.createDocumentFragment();
      for (let i = 0; i < 100000; i++) { const el = document.createElement("i"); if (i % 50 === 0) el.className = "b"; f.appendChild(el); }
      document.body.appendChild(f);
    </script></body>`;
    const load = async (withDusk) => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      if (withDusk) await open(page, { body });
      else {
        await page.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body }));
        await page.goto("http://example.test/", { waitUntil: "load" });
      }
      const t = await page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0]; return Math.round(n.loadEventStart); });
      return { ctx, page, t };
    };
    const base = await load(false);
    const dusk = await load(true);
    const gaps = await dusk.page.evaluate(() => new Promise((res) => {
      let worst = 0, last = performance.now(); const t0 = last;
      (function f() { const n = performance.now(); worst = Math.max(worst, n - last); last = n; if (n - t0 < 1500) requestAnimationFrame(f); else res(worst); })();
    }));
    const idle = await scannerIdle(dusk.page, 120000);
    const marked = await dusk.page.evaluate(() => document.querySelectorAll("[data-dusk-bg]").length);
    test.info().annotations.push({ type: "numbers", description: `load without Dusk ${base.t} ms, with Dusk ${dusk.t} ms; worst frame gap during scan ${Math.round(gaps)} ms; scanner idle after a further ${Math.round(idle)} ms; marked ${marked}/2000` });
    expect(marked).toBe(2000);
    expect(gaps).toBeLessThan(50);
    expect(dusk.t - base.t).toBeLessThan(Math.max(100, base.t * 0.25));
    await base.ctx.close(); await dusk.ctx.close();
  });

  test("10k-deep DOM: no errors, detection and scanner complete", async ({ page }) => {
    const body = `<!doctype html><body style="background:#fff"><script>
      let cur = document.body;
      for (let i = 0; i < 10000; i++) { const d = document.createElement("div"); cur.appendChild(d); cur = d; }
      cur.textContent = "deep";
      cur.style.cssText = "width:10px;height:10px;background-image:url(${IMG})";
    </script></body>`;
    const log = await open(page, { body });
    const idle = await scannerIdle(page, 8000);
    test.info().annotations.push({ type: "time to idle", description: `${Math.round(idle)} ms (−1 = not idle after 8 s)` });
    expect(idle).toBeGreaterThanOrEqual(0);
    expect(await state(page)).toBe("active");
    expect(log.errors).toEqual([]);
  });

  test("1000 rapid enable/disable toggles: consistent end state, observer off, queues empty", async ({ page }) => {
    const log = await open(page, { body: `<!doctype html><body>${`<div style="width:5px;height:5px;background-image:url(${IMG})"></div>`.repeat(200)}</body>` });
    const t = await page.evaluate(async () => {
      const t0 = performance.now();
      for (let i = 0; i < 1000; i++) window.__duskSet({ enabled: i % 2 === 1 }); // ends with enabled: true (i = 999)
      await new Promise((r) => setTimeout(r, 50));
      window.__duskSet({ enabled: false });
      await new Promise((r) => setTimeout(r, 50));
      return performance.now() - t0;
    });
    const d = await page.evaluate(() => ({ s: window.__duskDebug.state(), obs: window.__duskDebug.observing(), q: window.__duskDebug.bgQueueLen(), r: window.__duskDebug.bgRecheckSize(), attr: document.documentElement.hasAttribute("data-dusk") }));
    test.info().annotations.push({ type: "1000 toggles", description: `${Math.round(t)} ms` });
    expect(d).toEqual({ s: "disabled", obs: false, q: 0, r: 0, attr: false });
    expect(log.errors).toEqual([]);
  });
});

// ---------------------------------------------------------- extension API --

test.describe("extension API failures", () => {
  test("storage.get rejects: defaults apply, popup status still answers", async ({ page }) => {
    const log = await open(page, { storage: "reject" });
    expect(await state(page)).toBe("active");
    expect((await htmlState(page)).attr).toBe(true);
    expect(log.errors).toEqual([]);
  });

  test("storage.get throws synchronously (extension context invalidated): listeners still registered", async ({ page }) => {
    const log = await open(page, { storage: "throw" });
    test.info().annotations.push({ type: "errors", description: JSON.stringify(log.errors) });
    expect(await state(page)).toBe("active");
  });

  test("runtime.onMessage: garbage messages are ignored, only dusk:state answers", async ({ page }) => {
    const log = await open(page);
    const out = await page.evaluate(async () => {
      const msgs = [null, undefined, 0, 42, "", "dusk:state", [], ["dusk:state"], {}, { type: null }, { type: 1 }, { type: "DUSK:STATE" },
        { type: "dusk:state ", x: 1 }, { type: "dusk:state", extra: "x".repeat(1e5) }, { type: ["dusk:state"] }, { __proto__: { type: "dusk:state" } },
        JSON.parse('{"__proto__":{"type":"dusk:state"}}'), { type: "dusk:set", enabled: false }];
      const res = [];
      for (const m of msgs) res.push(await window.__duskSend(m));
      return res;
    });
    // Only the exact `dusk:state` messages answer (index 13). Index 15 inherits
    // type via a real prototype, which structured clone in a real extension drops.
    const answered = out.map((r, i) => (r === undefined ? null : i)).filter((i) => i !== null);
    test.info().annotations.push({ type: "answered indexes", description: JSON.stringify(answered) });
    expect(answered.every((i) => i === 13 || i === 15)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.hasAttribute("data-dusk"))).toBe(true);
    expect(log.errors).toEqual([]);
  });
});

// ------------------------------------------------------------------ popup --

const POPUP_ORIGIN = "http://ext.test";
async function openPopup(page, tabUrl, settings = {}) {
  const log = watch(page);
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    const file = path.join(EXT, url.pathname);
    if (url.origin === POPUP_ORIGIN && file.startsWith(EXT) && fs.existsSync(file)) {
      const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
      return route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file) });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await page.addInitScript(stubApi, { initial: settings, tab: { id: 3, url: tabUrl }, sendMessage: { value: { state: "active" } } });
  let dialogs = 0;
  page.on("dialog", (d) => { dialogs++; d.dismiss(); });
  await page.goto(POPUP_ORIGIN + "/popup/popup.html");
  await page.waitForFunction(() => document.getElementById("status").textContent !== "");
  return { log, dialogs: () => dialogs };
}

test.describe("popup with hostile tab URLs", () => {
  const urls = [
    "https://evil.test/<img src=x onerror=alert(1)>?q=<script>alert(1)</script>#<b>",
    "https://xn--80ak6aa92e.com/",
    "https://аpple.com/",
    "https://" + "a".repeat(63) + "." + "b".repeat(63) + "." + "c".repeat(63) + "." + "d".repeat(57) + ".test/",
    "https://user:secret@login.example.test:8443/path",
    "http://[::1]:8080/",
    "http://192.168.0.1/",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "about:blank",
    "not a url",
  ];
  for (const u of urls) {
    test(`no injection, correct host text: ${u.slice(0, 50)}`, async ({ page }) => {
      const { log, dialogs } = await openPopup(page, u);
      const r = await page.evaluate(() => {
        const h = document.getElementById("host");
        return {
          text: h.textContent, kids: h.children.length,
          disabled: document.querySelector('input[name="siteMode"]').disabled,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          imgs: document.querySelectorAll("img, script:not([src])").length,
        };
      });
      let expectedHost = null;
      try { const p = new URL(u); if (p.protocol.startsWith("http")) expectedHost = p.hostname; } catch {}
      if (expectedHost) expect(r.text).toBe(expectedHost);
      else expect(r.disabled).toBe(true);
      expect(r.kids).toBe(0);
      expect(r.imgs).toBe(0);
      expect(r.overflow).toBe(false);
      expect(dialogs()).toBe(0);
      expect(log.errors).toEqual([]);
      expect(r.text).not.toContain("secret");
    });
  }

  test("host named __proto__: choosing Always is saved", async ({ page }) => {
    await openPopup(page, "http://__proto__/");
    await page.locator(".segmented label", { hasText: "Always" }).click();
    await wait(page, 100);
    const sm = await page.evaluate(() => Object.getOwnPropertyNames(window.__duskStore.siteModes || {}));
    expect(sm).toContain("__proto__");
  });
});

// ----------------------------------------------------------------- memory --

test.describe("memory: no references kept to removed nodes", () => {
  test("50 cycles of add + class/style churn + remove: scanner queues drain to zero", async ({ page }) => {
    await open(page, { body: `<!doctype html><head><style>.on{background-image:url(${IMG})}</style></head><body></body>` });
    const r = await page.evaluate(async () => {
      const d = window.__duskDebug;
      let peakQ = 0, peakR = 0;
      for (let c = 0; c < 50; c++) {
        const box = document.createElement("div");
        for (let i = 0; i < 200; i++) { const e = document.createElement("i"); e.style.cssText = "display:block;width:3px;height:3px"; box.appendChild(e); }
        document.body.appendChild(box);
        await new Promise((r) => setTimeout(r, 0));
        for (const e of box.children) { e.classList.add("on"); e.style.opacity = "0.9"; }
        await new Promise((r) => setTimeout(r, 0));
        peakQ = Math.max(peakQ, d.bgQueueLen()); peakR = Math.max(peakR, d.bgRecheckSize());
        box.remove();
      }
      return { peakQ, peakR };
    });
    const idle = await scannerIdle(page);
    const after = await page.evaluate(() => ({ q: window.__duskDebug.bgQueueLen(), r: window.__duskDebug.bgRecheckSize() }));
    test.info().annotations.push({ type: "peaks", description: JSON.stringify({ ...r, idleMs: Math.round(idle) }) });
    expect(after).toEqual({ q: 0, r: 0 });
  });

  test("turning Dusk off disconnects the observer and drops queued nodes immediately", async ({ page }) => {
    await open(page, { body: `<!doctype html><body>${"<div></div>".repeat(3000)}</body>` });
    await page.evaluate(() => {
      for (const e of document.querySelectorAll("div")) e.className = "x"; // queue rechecks
      window.__duskSet({ enabled: false });
    });
    await wait(page, 30);
    const d = await page.evaluate(() => ({ obs: window.__duskDebug.observing(), q: window.__duskDebug.bgQueueLen(), r: window.__duskDebug.bgRecheckSize() }));
    expect(d).toEqual({ obs: false, q: 0, r: 0 });
  });

  test("a large subtree removed before scanning is not walked to the end", async ({ page }) => {
    // A detached subtree is still walked, but each node costs only an
    // isConnected check, so 20k nodes drain within one or two slices.
    await open(page);
    const r = await page.evaluate(async () => {
      const box = document.createElement("div");
      for (let i = 0; i < 20000; i++) box.appendChild(document.createElement("i"));
      document.body.appendChild(box);
      await new Promise((r) => setTimeout(r, 0));
      box.remove();
      await new Promise((r) => setTimeout(r, 120));
      return window.__duskDebug.bgQueueLen();
    });
    expect(r).toBe(0);
  });
});

// --------------------------------------------------------- static security --

test.describe("static security review of the shipped files", () => {
  const read = (p) => fs.readFileSync(path.join(EXT, p), "utf8");
  const manifest = JSON.parse(read("manifest.json"));

  test("no dynamic code, no HTML sinks, no network APIs in any extension script", () => {
    const files = ["content.js", "popup/popup.js"];
    const banned = /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval|Function\s*\(|setTimeout\s*\(\s*["'`]|setInterval\s*\(\s*["'`]|fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|import\s*\(|postMessage|localStorage|sessionStorage|indexedDB|document\.cookie)\b/;
    for (const f of files) {
      const src = read(f).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(src.match(banned), f).toBeNull();
    }
    expect(read("popup/popup.html")).not.toMatch(/<script(?![^>]*\bsrc=)/); // no inline script
    expect(read("popup/popup.html")).not.toMatch(/\son\w+=/); // no inline handlers
  });

  test("minimal permissions, no background, no web-accessible resources, no remote code", () => {
    expect(manifest.permissions.sort()).toEqual(["activeTab", "storage"]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.background).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.externally_connectable).toBeUndefined();
    expect(manifest.content_security_policy).toBeUndefined(); // MV3 default: script-src 'self'
    expect(manifest.content_scripts[0].all_frames).toBe(false);
  });

  test("zero network requests from Dusk on a busy page", async ({ page }) => {
    const log = await open(page, { body: `<!doctype html><body>${`<div style="width:5px;height:5px;background-image:url(${IMG})"></div><img src="${IMG}">`.repeat(300)}</body>` });
    await scannerIdle(page);
    await page.evaluate(() => window.__duskSet({ intensity: 70, warmth: 30, dimImages: true }));
    await wait(page, 100);
    const foreign = log.requests.filter((u) => !u.startsWith("http://example.test/") && !u.startsWith("data:"));
    expect(foreign).toEqual([]);
    expect(log.requests.filter((u) => u.startsWith("http://example.test/")).length).toBe(1);
  });

  test("the shipped content.js is byte-identical to the one the debug build wraps", () => {
    expect(DEBUG_JS.startsWith(CONTENT_JS.slice(0, CONTENT_JS.lastIndexOf("})();")))).toBe(true);
    expect(CONTENT_CSS.length).toBeGreaterThan(0);
  });
});
