// DOMContentLoaded and load times without any instrumentation, per part of
// Dusk: stub API only, stylesheet only, content script with the site Off,
// and everything with Dusk on. `npm run perf:load`. Median of 5.
const fs = require("fs"), path = require("path");
const { webkit } = require("@playwright/test");
const { stubApi } = require("../helpers");
const { heavy } = require("./fixtures");
const EXT = path.resolve(__dirname, "..", "..", "extension");
const CSS = fs.readFileSync(process.env.CSSFILE || path.join(EXT, "dusk.css"), "utf8");
const JS = fs.readFileSync(process.env.JSFILE || path.join(EXT, "content.js"), "utf8");
function injectCss(css) {
  const add = () => { const s = document.createElement("style"); s.textContent = css; document.documentElement.prepend(s); };
  if (document.documentElement) add();
  else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); add(); } }).observe(document, { childList: true });
}
const html = heavy();
const V = {
  none: [], stub: ["stub"], css: ["css"], js_off: ["stub", "js"], css_js_off: ["stub", "css", "js"], css_js_on: ["stub-on", "css", "js"],
  // Reference: what one forced layout inside DOMContentLoaded costs.
  layoutAtDCL: ["layout"],
};
(async () => {
  const b = await webkit.launch();
  for (const [name, parts] of Object.entries(V)) {
    if (process.env.ONLY && !process.env.ONLY.split(",").includes(name)) continue;
    const xs = [];
    for (let i = 0; i < 5; i++) {
      const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
      const p = await ctx.newPage();
      await p.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: html }));
      if (parts.includes("stub")) await p.addInitScript(stubApi, { initial: { siteModes: { "bench.test": "off" } } });
      if (parts.includes("stub-on")) await p.addInitScript(stubApi, { initial: {} });
      if (parts.includes("css")) await p.addInitScript(injectCss, CSS);
      if (parts.includes("js")) await p.addInitScript({ content: JS });
      if (parts.includes("layout")) await p.addInitScript(() => document.addEventListener("DOMContentLoaded", () => document.elementFromPoint(10, 10)));
      await p.goto("http://bench.test/", { waitUntil: "load" });
      xs.push(await p.evaluate(() => { const n = performance.getEntriesByType("navigation")[0]; return [n.domContentLoadedEventStart, n.domContentLoadedEventEnd, n.loadEventEnd]; }));
      await ctx.close();
    }
    const med = (k) => xs.map((x) => x[k]).sort((a, b) => a - b)[2];
    console.log(name.padEnd(12), "DCLstart", med(0), "DCLend", med(1), "load", med(2));
  }
  await b.close();
})();
