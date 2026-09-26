import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Readable } from "stream";
import type { ReleaseManifest, FlashProgress } from "../types.js";
import { MANIFEST_BASE_URL } from "../types.js";

export async function fetchManifest(): Promise<ReleaseManifest> {
  const url = `${MANIFEST_BASE_URL}/stable.json`;
  const res = await axios.get<ReleaseManifest>(url, { timeout: 10_000 });
  return res.data;
}

export function getImageUrl(manifest: ReleaseManifest, board: string): string {
  const boardVersions = manifest["lva-os"];
  if (!boardVersions?.[board]) {
    const available = Object.keys(boardVersions ?? {}).join(", ");
    throw new Error(`Board '${board}' not in manifest. Available: ${available}`);
  }
  const version = boardVersions[board];

  // ota field is the raucb URL template — swap extension for img.xz
  return manifest.ota
    .replaceAll("{version}", version)
    .replaceAll("{board}", board)
    .replace(".raucb", ".img.xz");
}

export function getVersion(manifest: ReleaseManifest, board: string): string {
  return manifest["lva-os"]?.[board] ?? "unknown";
}

export async function downloadImage(
  url: string,
  reuseImage: boolean,
  onProgress: (p: FlashProgress) => void
): Promise<string> {
  const imgDest = path.join(os.tmpdir(), "lva-os.img");

  // Skip download if --reuse-image flag is set and file exists
  if (reuseImage && fs.existsSync(imgDest)) {
    process.stderr.write(`\n[dev] Reusing cached image: ${imgDest}\n\n`);
    onProgress({ type: "download", percentage: 100 });
    return imgDest;
  }
  
  if (fs.existsSync(imgDest)) {
    try {
      fs.unlinkSync(imgDest);
    } catch (e) {
      throw new Error(
        `Could not overwrite cached image at ${imgDest}: ${(e as Error).message}. ` +
          `If a previous run used sudo, remove it manually or rerun with sudo.`
      );
    }
  }
  
  const res = await axios.get<NodeJS.ReadableStream>(url, {
    responseType: "stream",
    timeout: 0,
    headers: {
      "User-Agent": "lva-installer",
    },
  });

  const total = parseInt(String(res.headers["content-length"] ?? "0"), 10);
  let downloaded = 0;
  let lastEmit = Date.now();
  const startTime = Date.now();

  const { XzReadableStream } = await import("xz-decompress");

  const httpStream = res.data;

  const trackingStream = new Readable({ read() {} });

  httpStream.on("data", (chunk: Buffer) => {
    downloaded += chunk.length;
    const now = Date.now();
    if (now - lastEmit > 250) {
      const elapsed = (now - startTime) / 1000;
      const speed = downloaded / elapsed;
      const remaining = total > 0 ? (total - downloaded) / speed : undefined;
      onProgress({
        type: "download",
        percentage: total > 0 ? (downloaded / total) * 100 : 0,
        speed,
        eta: remaining,
      });
      lastEmit = now;
    }
    trackingStream.push(chunk);
  });
  httpStream.on("end", () => trackingStream.push(null));
  httpStream.on("error", (e: Error) => trackingStream.destroy(e));

  const webStream = Readable.toWeb(trackingStream) as ReadableStream<Uint8Array>;
  const decompressedStream = new XzReadableStream(webStream);

  const writer = fs.createWriteStream(imgDest);
  const reader = decompressedStream.getReader();

  await new Promise<void>((resolve, reject) => {
    async function pump() {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          writer.write(value);
        }
        writer.end();
        writer.on("finish", resolve);
      } catch (e) {
        writer.destroy(e as Error);
        reject(e);
      }
    }
    pump();
    writer.on("error", reject);
  });

  onProgress({ type: "download", percentage: 100 });
  return imgDest;
}
