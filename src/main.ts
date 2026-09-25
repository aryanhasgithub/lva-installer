// xz-decompress prints its wasm module to stdout on init — suppress it
const _origWrite = process.stdout.write.bind(process.stdout);
(process.stdout as any).write = (chunk: any, ...args: any[]) => {
  if (typeof chunk === "string" && chunk.includes("createWasm")) return true;
  return _origWrite(chunk, ...args);
};

import chalk from "chalk";
import { program } from "commander";
import {
  printBanner,
  promptBoard,
  promptNetwork,
  promptTimezone,
  promptDrive,
  promptConfirm,
  createProgressSpinner,
  renderProgress,
} from "./ui/prompts.js";
import { fetchManifest, getImageUrl, getVersion, downloadImage } from "./core/image.js";
import { injectCredentials } from "./core/credentials.js";
import { listRemovableDrives, flashImage } from "./core/flash.js";
import type { FlashProgress } from "./types.js";

// ─── CLI flags ────────────────────────────────────────────────────────────────

program
  .name("lva-installer")
  .description("LVA-OS USB installer")
  .version("0.1.0")
  .option("--no-verify", "skip post-flash verification")
  .option("--reuse-image", "reuse cached image from /tmp if it exists (dev)")
  .parse();

const opts = program.opts<{ verify: boolean; reuseImage: boolean }>();

// ─── Main flow ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  printBanner();

  // 1. Board
  const board = await promptBoard();
  console.log();

  // 2. Network
  const wifi = await promptNetwork();
  console.log();

  // 2b. Timezone
  const timezone = await promptTimezone();
  console.log();

  // 3. Drive selection
  const scanSpinner = createProgressSpinner("Scanning for removable drives...");
  const drives = await listRemovableDrives();
  scanSpinner.stop();

  const drive = await promptDrive(drives);
  console.log();

  // 4. Confirm
  const confirmed = await promptConfirm(drive);
  if (!confirmed) {
    console.log(chalk.yellow("\nAborted."));
    process.exit(0);
  }
  console.log();

  // 5. Fetch manifest
  const manifestSpinner = createProgressSpinner("Fetching release manifest...");
  let imageUrl: string;
  let version: string;
  try {
    const manifest = await fetchManifest();
    imageUrl = getImageUrl(manifest, board);
    version = getVersion(manifest, board);
    manifestSpinner.succeed(`LVA-OS ${chalk.cyan(version)} found`);
  } catch (err) {
    manifestSpinner.fail(`Failed to fetch manifest: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log();

  // 6. Download image
  const dlSpinner = createProgressSpinner("Starting download...");
  let imagePath: string;
  try {
    imagePath = await downloadImage(imageUrl!, opts.reuseImage ?? false, (p: FlashProgress) => {
      renderProgress(dlSpinner, p);
    });
    dlSpinner.succeed(`Downloaded LVA-OS ${chalk.cyan(version!)}`);
  } catch (err) {
    dlSpinner.fail(`Download failed: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log();

  // 7. Flash
  const flashSpinner = createProgressSpinner("Preparing to flash...");
  try {
    await flashImage(imagePath!, drive, (p: FlashProgress) => {
      renderProgress(flashSpinner, p);
    }, opts.verify);
    flashSpinner.succeed(chalk.green.bold("Flash complete!"));
  } catch (err) {
    flashSpinner.fail(`Flash failed: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log();

  // 8. Add CONFIG partition + write firstboot credentials
  const credSpinner = createProgressSpinner("Writing config to CONFIG partition...");
  try {
    const devicePath = (drive as any).drive?.device ?? (drive as any).path;
    // Let the OS settle its view of the device after etcher-sdk's writes/eject
    await new Promise((r) => setTimeout(r, 2000));
    await injectCredentials(devicePath, wifi, timezone);
    const parts: string[] = [];
    if (wifi) parts.push(`WiFi (${wifi.ssid})`);
    if (timezone) parts.push(`timezone (${timezone})`);
    credSpinner.succeed(
      parts.length > 0
        ? `Config written: ${chalk.cyan(parts.join(", "))}`
        : "CONFIG partition created (no settings to apply)"
    );
  } catch (err) {
    credSpinner.fail(`Config write failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // 9. Done
  console.log();
  console.log(chalk.green.bold("  ✓ LVA-OS installed successfully!"));
  console.log(chalk.dim("  Insert the drive into your device and power it on."));
  if (wifi) {
    console.log(chalk.dim(`  It will connect to '${wifi.ssid}' on first boot.`));
  } else {
    console.log(chalk.dim("  Connect an ethernet cable before powering on."));
  }
  console.log();
  process.exit(0);
}

main().catch((err: Error) => {
  console.error(chalk.red.bold("\nUnexpected error:"), err.message);
  process.exit(1);
});