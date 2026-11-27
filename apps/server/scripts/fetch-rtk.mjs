// Image build: download the rtk binary (github.com/rtk-ai/rtk, Apache-2.0 "oss" edition) into <out>/bin.
//   node fetch-rtk.mjs <out>
// Pinned: version and the sha256 of each tarball (from the release's checksums.txt, 2026-11-22). A tarball whose
// hash differs is thrown away. A build must never fail for this: the image ships without rtk and the chats
// run their commands as written (providers/rtk.mjs finds no binary). Docker caches this step like any other, so a
// failed download stays until the script changes or `--build-arg RTK_RETRY=<anything new>` is given.
// RTK_BASE: a mirror of the release folder, for a builder that cannot reach github.com
// (HTTPS_PROXY is honoured when NODE_USE_ENV_PROXY=1, which the Dockerfile sets).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = process.env.RTK_VERSION || "1.2.1";
const SUMS = {
  "1.2.1": {
    x64: ["rtk-oss-x86_64-unknown-linux-musl.tar.gz", "44aa460c4827d206d11405c652832c9f7082edccfbc3a9f15a69a851e8a9e8b4"],
    arm64: ["rtk-oss-aarch64-unknown-linux-musl.tar.gz", "b01860ae2d3f44e0f7fc4431a95dd66b29b4bd87ec7f5e60aff13681b05db5dd"],
  },
};
const base = (process.env.RTK_BASE || "https://github.com/rtk-ai/rtk/releases/download").replace(/\/$/, "");

async function main(out) {
  const pin = SUMS[VERSION]?.[process.arch];
  if (!pin) throw new Error(`no pinned checksum for rtk ${VERSION} on ${process.arch}`);
  const [file, sha256] = pin;
  const res = await fetch(`${base}/v${VERSION}/${file}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(body).digest("hex");
  if (got !== sha256) throw new Error(`checksum mismatch (${got})`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "rtk-"));
  fs.writeFileSync(path.join(work, file), body);
  execFileSync("tar", ["-xzf", path.join(work, file), "-C", work]);
  fs.mkdirSync(path.join(out, "bin"), { recursive: true });
  fs.mkdirSync(path.join(out, "share", "licenses", "rtk"), { recursive: true });
  fs.copyFileSync(path.join(work, "rtk"), path.join(out, "bin", "rtk"));
  fs.chmodSync(path.join(out, "bin", "rtk"), 0o755);
  if (fs.existsSync(path.join(work, "LICENSE"))) fs.copyFileSync(path.join(work, "LICENSE"), path.join(out, "share", "licenses", "rtk", "LICENSE"));
  console.log(`rtk ${VERSION} installed in ${out}/bin`);
}

main(process.argv[2] || "/out").catch((error) => console.log(`rtk not installed (${error.message}); the image is built without it`));
