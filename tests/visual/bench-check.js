// Breaks the dark-site check into pieces and times each one on real pages,
// with Dusk active, after load:  node visual/bench-check.js [site-filter...]
const { webkit } = require("@playwright/test");
const { stubApi } = require("../helpers");
const V = require("./run");
const SITES = require("./sites");

function bench() {
  const t = () => performance.now();
  const de = document.documentElement;
  const out = {};
  const time = (name, fn, n = 5) => {
    const runs = [];
    for (let i = 0; i < n; i++) {
      // Dirty style and layout the way a page or Dusk would between checks.
      document.body.style.setProperty("--dusk-bench", String(Math.random()));
      const s = t(); fn(); runs.push(t() - s);
    }
    runs.sort((a, b) => a - b);
    out[name] = +runs[Math.floor(n / 2)].toFixed(1);
  };
  const pts = [[innerWidth / 2, innerHeight / 2], [innerWidth / 2, innerHeight * 0.2], [innerWidth * 0.2, innerHeight * 0.6], [innerWidth * 0.8, innerHeight * 0.6]];
  time("baseline gCS(html) only", () => getComputedStyle(de).backgroundColor);
  time("elementFromPoint x4", () => pts.forEach(([x, y]) => document.elementFromPoint(x, y)));
  time("remove/readd data-dusk + gCS(html)", () => { de.removeAttribute("data-dusk"); getComputedStyle(de).backgroundColor; de.setAttribute("data-dusk", ""); getComputedStyle(de).backgroundColor; });
  time("probe attr + gCS(html)", () => { de.setAttribute("data-dusk-probe", ""); getComputedStyle(de).backgroundColor; de.removeAttribute("data-dusk-probe"); getComputedStyle(de).backgroundColor; });
  time("remove/readd data-dusk + elementFromPoint", () => { de.removeAttribute("data-dusk"); document.elementFromPoint(10, 10); de.setAttribute("data-dusk", ""); document.elementFromPoint(10, 10); });
  time("toggle --dusk-x on html + gCS(body)", () => { de.style.setProperty("--dusk-x", String(Math.random())); getComputedStyle(document.body).color; });
  out.elements = document.getElementsByTagName("*").length;
  document.body.style.removeProperty("--dusk-bench");
  return out;
}

(async () => {
  const filters = process.argv.slice(2);
  const sites = SITES.filter((s) => !filters.length || filters.some((f) => s.name.includes(f)));
  const browser = await webkit.launch();
  for (const site of sites) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true, colorScheme: site.scheme || "light" });
    const page = await ctx.newPage();
    await page.addInitScript(stubApi, { initial: { intensity: 100 } });
    await page.addInitScript(V.injectCss, V.CSS + "\nhtml[data-dusk]:not([data-dusk-probe]){}");
    await page.addInitScript({ content: V.JS });
    try {
      await page.goto(site.url, { waitUntil: "load", timeout: 40000 });
      await page.waitForTimeout(2500);
      console.log(site.name.padEnd(24), JSON.stringify(await page.evaluate(bench)));
    } catch (e) { console.log(site.name, "ERROR", String(e).slice(0, 120)); }
    await ctx.close();
  }
  await browser.close();
})();
