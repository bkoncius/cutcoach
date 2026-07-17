// One-off icon rasterizer. Run with `npm run icons` after editing assets/*.svg.
// Never runs on Vercel — the PNGs are committed, sharp is a devDependency.
import sharp from "sharp";
import { readFileSync, mkdirSync } from "node:fs";

const OUT = "public/icons";
mkdirSync(OUT, { recursive: true });

const round = readFileSync("assets/icon.svg");
const square = readFileSync("assets/icon-square.svg");
const badge = readFileSync("assets/badge.svg");

// [source, size, filename, flatten]
// flatten => composite onto #020617. Required for apple-touch-icon (iOS puts black
// behind alpha) and for maskable (Android masks it and expects full bleed).
// The badge must stay transparent — Android silhouettes its alpha channel.
const jobs = [
  [round, 512, "icon-512.png", false],
  [round, 192, "icon-192.png", false],
  [round, 32, "icon-32.png", false],
  [square, 512, "maskable-512.png", true],
  [square, 180, "apple-touch-icon-180.png", true],
  [badge, 72, "badge-72.png", false],
];

for (const [buf, size, name, flat] of jobs) {
  // density: sharp rasterizes SVG at 72dpi by default, which renders the 512px
  // output from a 512-unit viewBox blurry. 384dpi gives it enough to downsample from.
  let p = sharp(buf, { density: 384 }).resize(size, size);
  if (flat) p = p.flatten({ background: "#020617" });
  await p.png({ compressionLevel: 9 }).toFile(`${OUT}/${name}`);
  console.log(`${OUT}/${name}  ${size}×${size}${flat ? "  (opaque)" : ""}`);
}
