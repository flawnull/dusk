// Benchmark pages. Everything is generated locally; no network.
"use strict";

// 8x8 PNG, distinct colors so a missed re-inversion would be visible.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";

const CSS = `
  body { margin: 0; font: 14px/1.4 -apple-system, system-ui, sans-serif; background: #f3f2ef; color: #222; }
  .hdr { position: fixed; top: 0; left: 0; right: 0; height: 52px; background: #fff; z-index: 10; box-shadow: 0 1px 2px #0002; }
  .hdr .logo { width: 34px; height: 34px; margin: 9px; background-image: url(${PNG}); }
  main { padding: 60px 0 60px; max-width: 640px; margin: 0 auto; }
  .card { background: #fff; margin: 8px; padding: 12px; border-radius: 8px; }
  .card.hl { background: #fffbe6; }
  .top { display: flex; gap: 8px; align-items: center; }
  .av { width: 48px; height: 48px; border-radius: 50%; background-image: url(${PNG}); background-size: cover; flex: none; }
  .ico { display: inline-block; width: 16px; height: 16px; background-image: url(${PNG}); vertical-align: middle; }
  .card img { display: block; width: 100%; height: 160px; object-fit: cover; }
  .menu { display: none; }
  .msg { position: fixed; right: 16px; bottom: 0; width: 320px; height: 48px; background: #fff; overflow: hidden; z-index: 20; border-radius: 8px 8px 0 0; box-shadow: 0 0 4px #0003; will-change: transform; transform: translateZ(0); }
  .msg.open { height: 420px; overflow: auto; }
  .msg .me { width: 32px; height: 32px; border-radius: 50%; margin: 8px; }
  .msg .me.loaded { background-image: url(${PNG}); }
  .row { display: flex; gap: 8px; padding: 6px 8px; border-top: 1px solid #eee; }
  .row .ph { width: 40px; height: 40px; border-radius: 50%; background: #ccc; flex: none; position: relative; }
  .row .ph.loaded { background-image: url(${PNG}); background-size: cover; }
  .row .dot { position: absolute; right: 0; bottom: 0; width: 10px; height: 10px; border-radius: 50%; background: #3a3; }
  article { max-width: 680px; margin: 40px auto; padding: 0 16px; background: #fff; }
`;

function card(i) {
  const img = i % 2 === 0 ? `<img src="${PNG}" alt="">` : "";
  return `<div class="card" id="k${i}">
  <div class="top"><div class="av"></div><div><b>Person ${i}</b> <span>· 2nd</span><br><span class="sub">Title at Company</span></div></div>
  <p>Post text ${i} with <a href="#">a link</a>, <em>emphasis</em> and <strong>bold</strong> words.</p>
  <p>Second paragraph <i>italic</i> <span class="ico"></span> reactions.</p>
  ${img}
  <ul><li>Like</li><li>Comment</li><li>Share</li></ul>
  <div class="menu"><div>Save</div><div>Copy link</div><div>Embed</div><div>Unfollow</div><div>Report</div></div>
</div>`;
}

// ~25 elements per card. 1000 static cards + 200 inserted by script ~ 30k elements,
// 2 url() backgrounds per card (avatar + icon) = 2.4k, 600 imgs.
function heavy({ storm = false } = {}) {
  const cards = [];
  for (let i = 0; i < 1000; i++) cards.push(card(i));
  return `<!doctype html><html><head><meta charset="utf-8"><title>Feed</title><style>${CSS}</style></head><body>
<div class="hdr"><div class="logo"></div></div>
<main id="feed">${cards.join("")}</main>
<div class="msg" id="msg"><div class="top"><div class="me" id="me"></div><b>Messaging</b><span class="dot" style="position:static;display:inline-block;width:10px;height:10px;border-radius:50%;background:#3a3"></span></div><div id="rows"></div></div>
<script>
  // SPA-style hydration: 200 more cards in 4 chunks after DOMContentLoaded.
  const CARD = ${card.toString()};
  const PNG = ${JSON.stringify(PNG)};
  let next = 1000;
  function addCards(n) {
    const html = [];
    for (let i = 0; i < n; i++) html.push(CARD(next++));
    document.getElementById("feed").insertAdjacentHTML("beforeend", html.join(""));
  }
  document.addEventListener("DOMContentLoaded", () => {
    for (let c = 0; c < 4; c++) setTimeout(() => addCards(50), 20 * c);
    // The avatar in the messaging bar gets its photo late, the way LinkedIn does it.
    setTimeout(() => document.getElementById("me").classList.add("loaded"), 300);
  });
  window.__bench = { storm: ${storm} };
  if (${storm}) {
    window.addEventListener("load", () => {
      const t0 = performance.now();
      // ~1000 class/style attribute changes per second.
      const storm = setInterval(() => {
        const n = document.getElementById("feed").children.length;
        for (let i = 0; i < 10; i++) {
          const c = document.getElementById("feed").children[(Math.random() * n) | 0];
          if (i % 2) c.classList.toggle("hl"); else c.style.outline = (Math.random() < 0.5) ? "1px solid #ddd" : "";
        }
      }, 10);
      // Infinite feed: bursts of 10 cards every 300 ms.
      const feed = setInterval(() => addCards(10), 300);
      // Open the messaging overlay at +1 s and insert 50 conversation rows with lazy avatars.
      setTimeout(() => {
        const t = performance.now();
        const msg = document.getElementById("msg");
        msg.classList.add("open");
        const rows = [];
        for (let i = 0; i < 50; i++) rows.push('<div class="row"><div class="ph"><span class="dot"></span></div><div><b>Contact ' + i + '</b><br><span>Last message preview…</span></div></div>');
        document.getElementById("rows").innerHTML = rows.join("");
        requestAnimationFrame(() => requestAnimationFrame(() => {
          window.__bench.overlayRendered = performance.now() - t;
          const phs = document.querySelectorAll(".row .ph");
          phs.forEach((p, i) => setTimeout(() => p.classList.add("loaded"), 10 * i));
          window.__bench.avatarsSetAt = performance.now() + 10 * 49;
        }));
      }, 1000);
      // At +3.5 s stop, then detach 300 cards to test retention.
      setTimeout(() => {
        clearInterval(storm); clearInterval(feed);
        const feedEl = document.getElementById("feed");
        for (let i = 0; i < 300; i++) feedEl.lastElementChild && feedEl.lastElementChild.remove();
        window.__bench.detachedAt = performance.now();
        window.__bench.done = true;
      }, 3500);
    });
  } else {
    window.addEventListener("load", () => setTimeout(() => { window.__bench.done = true; }, 1500));
  }
</script>
</body></html>`;
}

function article() {
  const paras = [];
  for (let i = 0; i < 60; i++) {
    paras.push(`<p>Paragraph ${i}. Lorem ipsum dolor sit amet, <a href="#">consectetur</a> adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>`);
    if (i % 15 === 0) paras.push(`<figure><img src="${PNG}" width="640" height="320" alt=""><figcaption>Figure ${i}</figcaption></figure>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Article</title><style>${CSS}</style></head><body>
<article><h1>An article</h1>${paras.join("")}</article>
<script>window.__bench = {}; window.addEventListener("load", () => setTimeout(() => { window.__bench.done = true; }, 1200));</script>
</body></html>`;
}

module.exports = { heavy, article, PNG };
