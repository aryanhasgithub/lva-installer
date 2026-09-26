// build.js — packages lva-installer as a self-contained per-platform archive.
// Stack: esbuild (bundle TS) + Go (native launcher) + official Node binary + .node addons
//
// Runs NATIVE per platform (via CI matrix) so that native-addon .node
// binaries (drivelist, ext2fs, usb, etc.) are the real, correct binaries
// for that OS/arch — never cross-compiled/copied from another platform.
//
// Usage:
//   node build.js --target=linux-x86_64
//   node build.js --target=macos-arm64
//   node build.js                          (auto-detects current platform)
//
// Archive layout:
//   lva-installer-linux-x86_64/
//     lva-installer    ← Go launcher binary (native executable)
//     node             ← official Node 20 binary
//     main.cjs         ← esbuild bundle of all TS/JS deps
//     node_modules/    ← full package dirs for native addons (node-gyp-build/bindings-style)

import { build } from "esbuild";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  mkdir, copyFile, rm, chmod, cp,
} from "fs/promises";
import { existsSync, createWriteStream, createReadStream } from "fs";
import { get } from "https";
import path from "path";
import os from "os";
import archiver from "archiver";
import * as tar from "tar";

const execFileAsync = promisify(execFile);

const BUNDLE   = "dist/main.cjs";
const NODE_VER = "20.20.2";
const BASE_URL = `https://nodejs.org/dist/v${NODE_VER}`;

// Packages that resolve their .node binary at RUNTIME via __dirname-relative
// walking (node-gyp-build, bindings, etc). These must NOT be bundled by esbuild —
// esbuild would inline their JS but leave the __dirname resolution pointing at
// the wrong place once flattened into main.cjs. Instead we mark them external
// and copy their entire package directory into node_modules/ verbatim, so
// Node's normal require() resolution finds them next to main.cjs at runtime.
//
// Found via:
//   grep -rl '"node-gyp-build"' node_modules/*/package.json
//   find node_modules -name "*.node" -not -path "*/node_modules/*/node_modules/*" \
//     | sed -E 's|node_modules/([^/]+)/.*|\1|' | sort -u
// Full transitive runtime dependency set, resolved via a recursive walk of
// each root package's "dependencies" (not devDependencies) field. Excludes
// install-time/build-time-only tooling (prebuild-install, prebuildify,
// node-gyp, nan, node-addon-api, node-abi, napi-build-utils, and their own
// HTTP-fetch/config-parsing helpers) since those never get require()'d once
// the .node prebuild already exists on disk.
const NATIVE_PKGS = [
  "xxhash-addon",
  "lzma-native",
  "mountutils",
  "usb",
  "node-raspberrypi-usbboot",
  "drivelist",
  "ext2fs",
  "node-gyp-build",
  "bindings",
  "file-uri-to-path",
  "inherits",
  "base64-js",
  "bl",
  "buffer",
  "chownr",
  "debug",
  "detect-libc",
  "fs-constants",
  "ieee754",
  "mkdirp-classic",
  "ms",
  "once",
  "readable-stream",
  "safe-buffer",
  "string_decoder",
  "util-deprecate",
  "wrappy",
  // readable-stream (the top-level, newer version pulled in independently of
  // lzma-native's nested copy) unconditionally requires the "process" npm
  // package as a browser-compat shim for the global `process` object, even
  // though it's redundant in real Node. Still needs to physically resolve.
  "process",
  // Remaining runtime deps of the top-level readable-stream v4
  // (buffer and string_decoder already covered above).
  "abort-controller",
  "events",
  "event-target-shim",
  // @ronomon/direct-io does a static require('./binding.node'), which made
  // it seem safe to leave bundled via the ".node": "file" esbuild loader.
  // In practice its JS wrapper still breaks once flattened into main.cjs
  // (getAlignedBuffer resolves to undefined), so treat it like everything
  // else: externalize and ship the real folder.
  "@ronomon/direct-io",
  "@ronomon/queue",
  // If a rebuild throws "No native build was found" for @ronomon/direct-io,
  // add "@ronomon" here too — it currently ships fine via the ".node": "file"
  // loader below because it does a static require('./binding.node').
];

const TARGETS = [
  {
    name:    "linux-x86_64",
    nodePkg: `node-v${NODE_VER}-linux-x64`,
    nodeExt: ".tar.gz",
    nodeBin: "node",
    goOS:    "linux",
    goArch:  "amd64",
    winExe:  false,
    hostOS:  "linux",
    hostArch: "x64",
  },
  {
    name:    "linux-arm64",
    nodePkg: `node-v${NODE_VER}-linux-arm64`,
    nodeExt: ".tar.gz",
    nodeBin: "node",
    goOS:    "linux",
    goArch:  "arm64",
    winExe:  false,
    hostOS:  "linux",
    hostArch: "arm64",
  },
  {
    name:    "macos-x86_64",
    nodePkg: `node-v${NODE_VER}-darwin-x64`,
    nodeExt: ".tar.gz",
    nodeBin: "node",
    goOS:    "darwin",
    goArch:  "amd64",
    winExe:  false,
    hostOS:  "darwin",
    hostArch: "x64",
  },
  {
    name:    "macos-arm64",
    nodePkg: `node-v${NODE_VER}-darwin-arm64`,
    nodeExt: ".tar.gz",
    nodeBin: "node",
    goOS:    "darwin",
    goArch:  "arm64",
    winExe:  false,
    hostOS:  "darwin",
    hostArch: "arm64",
  },
  {
    name:    "windows-x86_64",
    nodePkg: `node-v${NODE_VER}-win-x64`,
    nodeExt: ".zip",
    nodeBin: "node.exe",
    goOS:    "windows",
    goArch:  "amd64",
    winExe:  true,
    hostOS:  "win32",
    hostArch: "x64",
  },
];

// ─── Resolve which single target to build ─────────────────────────────────────

function resolveTarget() {
  const argFlag = process.argv.find((a) => a.startsWith("--target="));
  const requested = argFlag ? argFlag.split("=")[1] : process.env.LVA_BUILD_TARGET;

  if (requested) {
    const found = TARGETS.find((t) => t.name === requested);
    if (!found) {
      throw new Error(
        `Unknown --target="${requested}". Valid targets: ${TARGETS.map((t) => t.name).join(", ")}`
      );
    }
    return found;
  }

  // Auto-detect from the current host — used for local dev builds with no
  // --target given. CI always passes --target explicitly (one per matrix job).
  const found = TARGETS.find((t) => t.hostOS === os.platform() && t.hostArch === os.arch());
  if (!found) {
    throw new Error(
      `Could not auto-detect a target for platform=${os.platform()} arch=${os.arch()}. ` +
      `Pass --target explicitly, e.g. --target=linux-x86_64`
    );
  }
  return found;
}

const target = resolveTarget();
console.log(`Building lva-installer for: ${target.name}\n`);

await mkdir("dist",             { recursive: true });
await mkdir("bin",              { recursive: true });
await mkdir("dist/node-cache",  { recursive: true });

// ─── Step 1: Bundle TS + npm deps → single CJS file ──────────────────────────

console.log("1. Bundling with esbuild...");
await build({
  entryPoints: ["src/main.ts"],
  bundle:   true,
  platform: "node",
  target:   "node20",
  format:   "cjs",
  outfile:  BUNDLE,
  external: [
    "*.node",                    // native addons — shipped as files
    "winusb-driver-generator",   // Windows-only, not needed on Linux/macOS
    ...NATIVE_PKGS,               // runtime-resolved / unbundlable packages — shipped as full folders (includes ext2fs)
  ],
  loader: {
    ".node": "file",             // tell esbuild to treat .node as external file asset
  },
  sourcemap: false,
  minify:   false,
  logLevel: "info",
});
console.log(`   → ${BUNDLE}\n`);

// ─── Step 2: Compile Go wrapper for THIS platform only ────────────────────────
// Running natively means we compile for the host we're already on — no
// cross-compilation needed (and no CGO_ENABLED=0 workaround required either,
// though we keep it since the wrapper has zero cgo dependencies anyway).

console.log(`2. Compiling Go launcher for ${target.name}...`);
const launcherName = target.winExe ? "lva-installer.exe" : "lva-installer";
const launcherOutPath = path.join("dist", launcherName);
await execFileAsync("go", [
  "build",
  "-ldflags=-s -w",  // strip debug info for smaller binary
  "-o", launcherOutPath,
  "wrapper.go",
], {
  env: { ...process.env, GOOS: target.goOS, GOARCH: target.goArch, CGO_ENABLED: "0" },
});
console.log(`   ✓ ${target.name}\n`);

// ─── Step 3: Fetch this platform's real Node binary ───────────────────────────

console.log(`3. Fetching Node ${NODE_VER} for ${target.name}...`);
const cachedNode = path.join("dist/node-cache", target.name + (target.winExe ? ".exe" : ""));

if (!existsSync(cachedNode)) {
  const archivePath = path.join("dist/node-cache", target.nodePkg + target.nodeExt);
  if (!existsSync(archivePath)) {
    console.log(`   Downloading ${target.nodePkg}${target.nodeExt}...`);
    await downloadFile(`${BASE_URL}/${target.nodePkg}${target.nodeExt}`, archivePath);
  }
  console.log("   Extracting node binary...");
  if (target.nodeExt === ".tar.gz") {
    const inner = `${target.nodePkg}/bin/node`;
    await tar.x({ file: archivePath, cwd: "dist/node-cache", filter: (p) => p === inner });
    await copyFile(path.join("dist/node-cache", inner), cachedNode);
  } else {
    // .zip (Windows Node distribution) — use the archiver-adjacent extractor
    // (unzipper) rather than shelling out to `unzip`, which doesn't exist on
    // native Windows runners.
    const { default: unzipper } = await import("unzipper");
    const inner = `${target.nodePkg}/node.exe`;
    await new Promise((resolve, reject) => {
      createWriteStream(cachedNode)
        .on("finish", resolve)
        .on("error", reject)
        .on("pipe", () => {});
      createReadStream(archivePath)
        .pipe(unzipper.ParseOne(new RegExp(inner.replace(/[/\\]/g, "[/\\\\]"))))
        .pipe(createWriteStream(cachedNode))
        .on("finish", resolve)
        .on("error", reject);
    });
  }
}
console.log(`   ✓ ${cachedNode}\n`);

// ─── Step 4: Assemble staging directory ───────────────────────────────────────

console.log(`4. Packaging lva-installer-${target.name}...`);

const stageName = `lva-installer-${target.name}`;
const stageDir  = path.join("bin", stageName);
await rm(stageDir, { recursive: true, force: true });
await mkdir(stageDir, { recursive: true });

// 1. Go launcher → lva-installer(.exe)
const launcherDest = path.join(stageDir, launcherName);
await copyFile(launcherOutPath, launcherDest);
if (!target.winExe) await chmod(launcherDest, 0o755);

// 2. Node binary
const nodeDest = path.join(stageDir, target.nodeBin);
await copyFile(cachedNode, nodeDest);
if (!target.winExe) await chmod(nodeDest, 0o755);

// 3. esbuild bundle
await copyFile(BUNDLE, path.join(stageDir, "main.cjs"));

// 4. Native addon packages — copy full package directories (not just .node
// files) so runtime __dirname-relative resolution (node-gyp-build/bindings)
// finds prebuilds/package.json/etc right where it expects them, next to
// node_modules/<pkg>/ under the staged main.cjs. These are the REAL,
// natively-built binaries for this platform since npm ci ran natively here.
for (const pkg of NATIVE_PKGS) {
  const src = path.join("node_modules", pkg);
  if (!existsSync(src)) {
    console.log(`   ! skipping ${pkg} (not found in node_modules)`);
    continue;
  }
  const dest = path.join(stageDir, "node_modules", pkg);
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
}

// ─── Step 5: Create release archive (pure JS, no tar/zip/unzip shell-outs) ────

const archiveName = target.winExe
  ? `${stageName}.zip`
  : `${stageName}.tar.gz`;
const archiveOut = path.join("bin", archiveName);

if (target.winExe) {
  await createZip(stageDir, archiveOut, stageName);
} else {
  await tar.c(
    { gzip: true, file: archiveOut, cwd: "bin" },
    [stageName]
  );
}

// Clean up staging dir
await rm(stageDir, { recursive: true, force: true });

console.log(`   ✓ ${archiveOut}\n`);
console.log("Done.");
console.log("\nUsage:");
if (target.winExe) {
  console.log(`  ${stageName}\\lva-installer.exe (as Administrator)`);
} else {
  console.log(`  sudo ./${stageName}/lva-installer`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const request = (u) => get(u, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return request(res.headers.location);
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    }).on("error", reject);
    request(url);
  });
}

function createZip(sourceDir, outPath, rootName) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(sourceDir, rootName);
    archive.finalize();
  });
}