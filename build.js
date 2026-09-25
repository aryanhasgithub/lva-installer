// build.js — packages lva-installer as self-contained per-platform archives
// Stack: esbuild (bundle TS) + Go (native launcher) + official Node binary + .node addons
//
// Archive layout:
//   lva-installer-linux-x86_64/
//     lva-installer    ← Go launcher binary (native executable)
//     node             ← official Node 20 binary
//     main.cjs         ← esbuild bundle of all TS/JS deps
//     node_modules/    ← full package dirs for native addons (node-gyp-build/bindings-style)

import { build } from "esbuild";
import { execFile, exec } from "child_process";
import { promisify } from "util";
import {
  mkdir, copyFile, writeFile, rm, chmod
} from "fs/promises";
import { existsSync, createWriteStream } from "fs";
import { get } from "https";
import path from "path";

const execAsync    = promisify(exec);
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
  },
  {
    name:    "linux-arm64",
    nodePkg: `node-v${NODE_VER}-linux-arm64`,
    nodeExt: ".tar.gz",
    nodeBin: "node",
    goOS:    "linux",
    goArch:  "arm64",
    winExe:  false,
  },
  {
    name:    "macos-x86_64",
    nodePkg: `node-v${NODE_VER}-darwin-x64`,
    nodeExt: ".tar.gz",
    nodeBin: "node",
    goOS:    "darwin",
    goArch:  "amd64",
    winExe:  false,
  },
  {
    name:    "macos-arm64",
    nodePkg: `node-v${NODE_VER}-darwin-arm64`,
    nodeExt: ".tar.gz",
    nodeBin: "node",
    goOS:    "darwin",
    goArch:  "arm64",
    winExe:  false,
  },
  {
    name:    "windows-x86_64",
    nodePkg: `node-v${NODE_VER}-win-x64`,
    nodeExt: ".zip",
    nodeBin: "node.exe",
    goOS:    "windows",
    goArch:  "amd64",
    winExe:  true,
  },
];

await mkdir("dist",             { recursive: true });
await mkdir("bin",              { recursive: true });
await mkdir("dist/node-cache",  { recursive: true });
await mkdir("dist/go-wrappers", { recursive: true });

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

// ─── Step 2: Compile Go wrapper for all platforms ─────────────────────────────

console.log("2. Compiling Go launcher for all platforms...");
for (const t of TARGETS) {
  const outName = t.winExe ? "lva-installer.exe" : "lva-installer";
  const outPath = path.join("dist/go-wrappers", `${t.name}-${outName}`);
  if (!existsSync(outPath)) {
    process.env.GOOS   = t.goOS;
    process.env.GOARCH = t.goArch;
    process.env.CGO_ENABLED = "0"; // pure Go, no cgo needed
    await execFileAsync("go", [
      "build",
      "-ldflags=-s -w",  // strip debug info for smaller binary
      "-o", outPath,
      "wrapper.go",
    ], { env: { ...process.env, GOOS: t.goOS, GOARCH: t.goArch, CGO_ENABLED: "0" } });
    console.log(`   ✓ ${t.name}`);
  } else {
    console.log(`   ✓ ${t.name} (cached)`);
  }
}
console.log();

// ─── Step 3: Per-platform archive ─────────────────────────────────────────────

for (const target of TARGETS) {
  console.log(`3. Packaging lva-installer-${target.name}...`);

  // Download + extract Node binary if not cached
  const cachedNode = path.join("dist/node-cache",
    target.name + (target.winExe ? ".exe" : ""));

  if (!existsSync(cachedNode)) {
    const archivePath = path.join("dist/node-cache", target.nodePkg + target.nodeExt);
    if (!existsSync(archivePath)) {
      console.log(`   Downloading ${target.nodePkg}${target.nodeExt}...`);
      await downloadFile(`${BASE_URL}/${target.nodePkg}${target.nodeExt}`, archivePath);
    }
    console.log(`   Extracting node binary...`);
    if (target.nodeExt === ".tar.gz") {
      const inner = `${target.nodePkg}/bin/node`;
      await execAsync(`tar -xzf "${archivePath}" -C "dist/node-cache" "${inner}"`);
      await copyFile(`dist/node-cache/${inner}`, cachedNode);
    } else {
      const inner = `${target.nodePkg}/node.exe`;
      await execAsync(`unzip -o "${archivePath}" "${inner}" -d "dist/node-cache"`);
      await copyFile(`dist/node-cache/${inner}`, cachedNode);
    }
  }

  // Build staging directory
  const stageName = `lva-installer-${target.name}`;
  const stageDir  = path.join("bin", stageName);
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });

  // 1. Go launcher → lva-installer(.exe)
  const launcherName = target.winExe ? "lva-installer.exe" : "lva-installer";
  const launcherSrc  = path.join("dist/go-wrappers", `${target.name}-${launcherName}`);
  const launcherDest = path.join(stageDir, launcherName);
  await copyFile(launcherSrc, launcherDest);
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
  // node_modules/<pkg>/ under the staged main.cjs.
  for (const pkg of NATIVE_PKGS) {
    const src = path.join("node_modules", pkg);
    if (!existsSync(src)) {
      console.log(`   ! skipping ${pkg} (not found in node_modules)`);
      continue;
    }
    const dest = path.join(stageDir, "node_modules", pkg);
    await mkdir(path.dirname(dest), { recursive: true });
    await execAsync(`cp -R "${src}" "${dest}"`);
  }

  // Create release archive
  const archiveName = target.winExe
    ? `lva-installer-${target.name}.zip`
    : `lva-installer-${target.name}.tar.gz`;
  const archiveOut = path.join("bin", archiveName);

  if (target.winExe) {
    await execAsync(`cd bin && zip -r "${archiveName}" "${stageName}/"`);
  } else {
    await execAsync(`tar -czf "${archiveOut}" -C bin "${stageName}/"`);
  }

  // Clean up staging dir
  await rm(stageDir, { recursive: true, force: true });

  console.log(`   ✓ bin/${archiveName}\n`);
}

console.log("Done. Release archives in ./bin/");
console.log("\nUsage:");
console.log("  Linux/macOS: sudo ./lva-installer-linux-x86_64/lva-installer");
console.log("  Windows:     lva-installer-windows-x86_64\\lva-installer.exe (as Administrator)");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const request = (u) => get(u, res => {
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