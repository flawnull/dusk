// LinkedIn messaging overlay fixture: renders linkedin-messaging.html with
// Dusk, after the lazy avatars load and with one row hovered, then measures
// avatars, presence dots, text contrast, badge, unread rows and the panel
// shadow against the same page with Dusk off.
//
//   npm run visual:linkedin
const fs = require("fs");
const path = require("path");
const { webkit } = require("@playwright/test");
const { stubApi } = require("../helpers");
const V = require("./run");

const HTML = fs.readFileSync(path.join(__dirname, "linkedin-messaging.html"), "utf8");
const URL_ = "http://www.linkedin.test/messaging/";

const avg = (I, x, y, r = 3) => {
  const px = [];
  for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) px.push(I.px(x + i, y + j));
  return [0, 1, 2].map((c) => Math.round(V.mean(px.map((p) => p[c]))));
};
const dist = (a, b) => Math.round((Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3);
const L = (p) => V.lumOf(...p);

async function run(intensity, extra = {}) {
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true });
  const page = await ctx.newPage();
  await page.route("**/*", (r) => r.request().url().startsWith(URL_) ? r.fulfill({ contentType: "text/html", body: HTML }) : r.fulfill({ status: 404, body: "" }));
  await page.addInitScript(stubApi, { initial: { intensity, ...extra } });
  await page.addInitScript(V.injectCss, V.CSS);
  await page.addInitScript({ content: V.JS });
  await page.goto(URL_, { waitUntil: "load" });
  await page.waitForSelector("html[data-lazy-done]", { state: "attached" });
  await page.waitForTimeout(1500); // scanner
  // Hover the 2nd conversation row.
  const rows = page.locator(".msg-conversation-listitem__link");
  await rows.nth(1).hover();
  await page.waitForTimeout(200);

  const geo = await page.evaluate(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; };
    const q = (s) => Array.from(document.querySelectorAll(s));
    return {
      panel: r(document.querySelector(".msg-overlay-list-bubble")),
      avatars: q(".presence-entity__image").map((el) => ({ ...r(el), mode: el.dataset.mode || "header", marked: el.hasAttribute("data-dusk-bg"), tag: el.tagName, filter: getComputedStyle(el).filter, cls: el.className })),
      dots: q(".presence-entity__indicator").map(r),
      names: q(".msg-conversation-listitem__participant-names").map(r),
      snippets: q(".msg-conversation-card__message-snippet").map(r),
      times: q(".msg-conversation-card__time-stamp").map(r),
      badges: q(".notification-badge").map(r),
      unread: q(".msg-conversation-card--unread").map(r),
      rows: q(".msg-conversation-listitem__link").map(r),
      icons: q(".msg-overlay-bubble-header__controls svg").map(r),
      title: r(document.querySelector(".msg-overlay-bubble-header__title")),
      search: r(document.querySelector(".msg-overlay-list-bubble__search input")),
      cost: window.__duskCost,
      state: null,
    };
  });
  geo.state = await page.evaluate(() => window.__duskSend({ type: "dusk:state" })).then((x) => x && x.state);
  const shot = () => page.screenshot({ animations: "disabled" });
  const onBuf = await shot();
  await page.evaluate(() => window.__duskSet({ enabled: false }));
  await page.waitForTimeout(300);
  const offBuf = await shot();
  await browser.close();
  return { geo, on: V.img(onBuf), off: V.img(offBuf), onBuf, offBuf };
}

function textContrast(I, b) {
  const c = V.clip({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }, I);
  if (!c) return null;
  const s = V.samples(I, c, 24, 0);
  const bg = V.median(s.map(L));
  return V.peakContrast(s, bg);
}

(async () => {
  const OUT = process.env.VISUAL_OUT || path.join(__dirname, "out");
  fs.mkdirSync(OUT, { recursive: true });
  const report = [];
  for (const [label, intensity, extra] of [["100", 100, {}], ["90", 90, {}], ["90+warm40+dim", 90, { warmth: 40, dimImages: true }]]) {
    const { geo, on, off, onBuf, offBuf } = await run(intensity, extra);
    fs.writeFileSync(path.join(OUT, `linkedin-msg.${label}.on.png`), onBuf);
    fs.writeFileSync(path.join(OUT, `linkedin-msg.${label}.off.png`), offBuf);
    const r = { label, state: geo.state, avatars: [], dots: [], text: {}, shadow: null, unread: null, hover: null };
    for (const a of geo.avatars) {
      const p1 = avg(on, a.cx, a.cy + a.h * 0.05), p0 = avg(off, a.cx, a.cy + a.h * 0.05);
      const bgOn = avg(on, a.x + a.w * 0.15, a.y + a.h * 0.15, 1), bgOff = avg(off, a.x + a.w * 0.15, a.y + a.h * 0.15, 1);
      const inv = dist(p1, [255 - p0[0], 255 - p0[1], 255 - p0[2]]);
      r.avatars.push({ mode: a.mode, tag: a.tag, marked: a.marked, faceOff: p0, faceOn: p1, faceDiff: dist(p1, p0), cornerOff: bgOff, cornerOn: bgOn, cornerDiff: dist(bgOn, bgOff), looksInverted: dist(p1, p0) > 40 && inv < dist(p1, p0), cls: a.cls.replace(/presence-entity__image|evi-image|msg-facepile-grid__img(--person)?/g, "").trim() });
    }
    for (const d of geo.dots) { const p1 = avg(on, d.cx, d.cy, 1), p0 = avg(off, d.cx, d.cy, 1); r.dots.push({ off: p0, on: p1, diff: dist(p0, p1) }); }
    for (const k of ["names", "snippets", "times", "badges", "icons"]) {
      const vals = geo[k].map((b) => [textContrast(off, b), textContrast(on, b)]).filter((v) => v[0]);
      r.text[k] = { off: +V.mean(vals.map((v) => v[0])).toFixed(2), on: +V.mean(vals.map((v) => v[1])).toFixed(2), minOn: +Math.min(...vals.map((v) => v[1])).toFixed(2) };
    }
    r.text.title = [textContrast(off, geo.title), textContrast(on, geo.title)].map((v) => +v.toFixed(2));
    // Shadow: just left of the panel vs page canvas further left.
    const P = geo.panel;
    const sh = (I) => ({ edge: avg(I, P.x - 2, P.y + 200, 1), page: avg(I, P.x - 40, P.y + 200, 1), panel: avg(I, P.x + 20, P.y + 600, 1) });
    r.shadow = { off: sh(off), on: sh(on) };
    r.shadow.verdict = L(r.shadow.on.edge) > L(r.shadow.on.page) + 0.005 ? "GLOW (shadow rendered lighter than page)" : "ok";
    if (geo.unread[0]) { const u = geo.unread[0]; r.unread = { off: avg(off, u.x + u.w - 30, u.y + 8, 1), on: avg(on, u.x + u.w - 30, u.y + 8, 1) }; }
    if (geo.rows[1]) { const h = geo.rows[1], n = geo.rows[4]; r.hover = { hoveredOn: avg(on, h.x + h.w - 30, h.y + 8, 1), plainOn: avg(on, n.x + n.w - 30, n.y + 8, 1) }; }
    r.panelBg = { off: sh(off).panel, on: sh(on).panel, page: sh(on).page };
    r.cost = geo.cost && { ms: Math.round(geo.cost.ms), max: Math.round(geo.cost.max), calls: geo.cost.calls };
    report.push(r);
  }
  fs.writeFileSync(path.join(OUT, "linkedin-msg.json"), JSON.stringify(report, null, 1));
  for (const r of report) {
    console.log(`\n== intensity ${r.label}  state ${r.state}  dusk cost ${JSON.stringify(r.cost)}`);
    for (const a of r.avatars) console.log(`avatar ${a.mode.padEnd(16)} ${a.tag.padEnd(4)} marked=${a.marked ? "Y" : "n"} face off ${a.faceOff} on ${a.faceOn} diff ${a.faceDiff}${a.looksInverted ? "  INVERTED" : ""} | corner diff ${a.cornerDiff} | ${a.cls}`);
    console.log("dots", r.dots.map((d) => `${d.off}->${d.on}`).join("  "));
    console.log("text contrast off->on", JSON.stringify(r.text));
    console.log("shadow", JSON.stringify(r.shadow));
    console.log("unread row bg", JSON.stringify(r.unread), " hover", JSON.stringify(r.hover), " panel", JSON.stringify(r.panelBg));
  }
})();
