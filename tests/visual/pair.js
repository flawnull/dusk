// node visual/pair.js <name> <out.png> [x y w h]  — off | on100 side by side for one site.
const fs = require("fs"), path = require("path");
const { PNG } = require("pngjs");
const OUT = process.env.VISUAL_OUT || path.join(__dirname, "out");
const [, , name, out, x = 0, y = 0, w, h] = process.argv;
const imgs = ["off", "on100"].map((k) => PNG.sync.read(fs.readFileSync(path.join(OUT, `${name}.${k}.png`))));
const W = Number(w || imgs[0].width), H = Number(h || imgs[0].height), X = Number(x), Y = Number(y);
const dst = new PNG({ width: W * 2 + 8, height: H });
dst.data.fill(255);
imgs.forEach((im, n) => {
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const a = ((Y + j) * im.width + (X + i)) * 4, b = (j * dst.width + n * (W + 8) + i) * 4;
    for (let k = 0; k < 4; k++) dst.data[b + k] = im.data[a + k] ?? 255;
  }
});
fs.writeFileSync(out, PNG.sync.write(dst));
