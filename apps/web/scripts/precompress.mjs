// Brotli + gzip copies of the built text assets, served by serveStatic({ precompressed }) (server
// index.mjs). The main bundle is ~1.8 MB raw; behind a slow link or a CDN that does not compress,
// the page stays blank until it arrives.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const dist = path.resolve(process.argv[2] || new URL("../dist", import.meta.url).pathname);
const TEXT = /\.(js|mjs|css|html|svg|json|txt|webmanifest)$/;
let raw = 0;
let br = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (TEXT.test(name) && statSync(file).size > 1024) {
      const data = readFileSync(file);
      const b = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 10 } });
      writeFileSync(`${file}.br`, b);
      writeFileSync(`${file}.gz`, gzipSync(data, { level: 9 }));
      raw += data.length;
      br += b.length;
    }
  }
};
walk(dist);
console.log(`precompressed ${(raw / 1e6).toFixed(1)} MB -> ${(br / 1e6).toFixed(1)} MB (br)`);
