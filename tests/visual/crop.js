// node visual/crop.js <in.png> <out.png> x y w h [scale]  — crop (and upscale) a screenshot region.
const fs = require("fs");
const { PNG } = require("pngjs");
const [, , inp, out, x, y, w, h, sc = "1"] = process.argv;
const src = PNG.sync.read(fs.readFileSync(inp));
const s = Number(sc), W = Number(w) * s, H = Number(h) * s;
const dst = new PNG({ width: W, height: H });
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
  const sx = Math.min(src.width - 1, Number(x) + Math.floor(i / s)), sy = Math.min(src.height - 1, Number(y) + Math.floor(j / s));
  const a = (sy * src.width + sx) * 4, b = (j * W + i) * 4;
  for (let k = 0; k < 4; k++) dst.data[b + k] = src.data[a + k];
}
fs.writeFileSync(out, PNG.sync.write(dst));
