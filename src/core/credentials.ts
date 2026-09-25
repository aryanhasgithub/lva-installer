import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import GPT from "gpt";
import type { WiFiConfig } from "../types.js";

const execFileAsync = promisify(execFile);
const BLOCK_SIZE = 512;
const CONFIG_SIZE_MB = 32;
const CONFIG_PARTITION_SECTORS = (CONFIG_SIZE_MB * 1024 * 1024) / BLOCK_SIZE;
const CONFIG_LABEL = "CONFIG";
const LINUX_DATA_TYPE = "0FC63DAF-8483-4772-8E79-3D69D8477DE4";
const ALIGN_SECTORS = BigInt((1024 * 1024) / BLOCK_SIZE); // 1MiB alignment

/**
 * After etcher-sdk flashes the LVA-OS image, append a CONFIG partition to
 * the GPT, format it with a filesystem native to the host OS, set the label
 * to CONFIG, mount it, write the firstboot config files, then unmount.
 *
 * mnt-config.mount uses:
 *   What=/dev/disk/by-label/CONFIG
 *   Type=auto
 * so any filesystem with label CONFIG will be auto-detected and mounted.
 *
 * IMPORTANT: CONFIG is anchored to the PHYSICAL END of the disk, not placed
 * immediately after the last partition in the flashed image. This leaves the
 * gap between the image's last partition (lvaos-data) and CONFIG free, so
 * that lva-os-expand can grow lvaos-data into it on first boot. If CONFIG
 * were placed directly after lvaos-data (the old behavior), lvaos-data would
 * have nowhere to grow and lva-os-expand's sfdisk resize would fail with
 * "Failed to resize partition #8".
 *
 * Per-OS formatter used (all built-in, zero extra installs):
 *   Linux   → mkfs.ext4  (e2fsprogs, base package on every distro)
 *   macOS   → newfs_hfs  (built-in HFS+) or diskutil
 *   Windows → Format-Volume (PowerShell, built-in Windows 10+)
 */
export async function injectCredentials(
  devicePath: string,
  wifi: WiFiConfig | null,
  timezone: string | null
): Promise<void> {
  const files: { relPath: string; content: string }[] = [];

  if (wifi) {
    files.push({ relPath: "network/lva-wifi", content: buildNmKeyfile(wifi) });
    files.push({ relPath: "wifi-country",     content: `${wifi.country}\n` });
  }
  if (timezone) {
    files.push({ relPath: "timezone", content: `${timezone}\n` });
  }

  // 1. Append CONFIG partition to GPT + write back both header copies
  const partitionPath = await appendConfigPartition(devicePath);

  // 2. Re-read partition table so kernel sees the new partition
  await rereadPartitionTable(devicePath);
  await sleep(2000); // let udev create the device node

  // 3. Format with OS-native tool, label = CONFIG
  await formatPartition(partitionPath);

  // 4. Mount, write files, unmount
  if (files.length > 0) {
    await writeFiles(partitionPath, files);
  }
}

// ─── NM keyfile builder ───────────────────────────────────────────────────────

function buildNmKeyfile(wifi: WiFiConfig): string {
  return [
    "[connection]",
    "id=lva-wifi",
    "type=wifi",
    "",
    "[wifi]",
    `ssid=${wifi.ssid}`,
    "band=bg",
    "",
    "[wifi-security]",
    "key-mgmt=wpa-psk",
    `psk=${wifi.password}`,
    "",
    "[ipv4]",
    "method=auto",
    "",
    "[ipv6]",
    "method=auto",
    "",
  ].join("\n");
}

// ─── Device-naming helpers ─────────────────────────────────────────────────────

/**
 * Build the Nth partition's device path for a given whole-disk path,
 * handling both Linux naming conventions:
 *   /dev/sda      + 9  → /dev/sda9        (no separator: sd*, hd*, vd*)
 *   /dev/mmcblk0  + 9  → /dev/mmcblk0p9   (p-separator: mmcblk*, nvme*, loop*)
 * A disk name needs the "p" separator whenever it already ends in a digit —
 * otherwise the partition number would be ambiguous with the disk number
 * (e.g. "mmcblk0" + "9" reads as "mmcblk09", not "mmcblk0 partition 9").
 */
function partitionDevicePath(devicePath: string, partNum: number): string {
  if (os.platform() === "darwin") {
    return `${devicePath}s${partNum}`; // /dev/disk2s9
  }
  const endsInDigit = /\d$/.test(devicePath);
  const sep = endsInDigit ? "p" : "";
  return `${devicePath}${sep}${partNum}`;
}

// ─── GPT manipulation ─────────────────────────────────────────────────────────

async function getDiskSectors(devicePath: string): Promise<number> {
  // stat().size returns 0 for block devices on Linux — use sysfs.
  // devicePath is always the whole disk here (e.g. /dev/sda, /dev/mmcblk0),
  // never a partition — no suffix stripping needed.
  const devName = path.basename(devicePath);
  try {
    const raw = await fs.promises.readFile(`/sys/block/${devName}/size`, "utf-8");
    return parseInt(raw.trim(), 10);
  } catch {
    // macOS
    if (os.platform() === "darwin") {
      const { stdout } = await execFileAsync("diskutil", ["info", "-plist", devicePath]);
      const m = stdout.match(/<key>TotalSize<\/key>\s*<integer>(\d+)<\/integer>/);
      if (m) return Math.floor(parseInt(m[1], 10) / BLOCK_SIZE);
    }
    throw new Error(`Cannot determine disk size for ${devicePath}`);
  }
}

/**
 * Align a start LBA up to the next 1MiB boundary.
 */
function alignUp(lba: bigint): bigint {
  const rem = lba % ALIGN_SECTORS;
  return rem === 0n ? lba : lba + (ALIGN_SECTORS - rem);
}

/**
 * Align an end LBA down to the previous 1MiB boundary (so the partition
 * that starts right after it still lands on an aligned sector).
 */
function alignDown(lba: bigint): bigint {
  const rem = lba % ALIGN_SECTORS;
  return rem === 0n ? lba : lba - rem;
}

async function appendConfigPartition(devicePath: string): Promise<string> {
  const totalSectors = await getDiskSectors(devicePath);
  const fd = await fs.promises.open(devicePath, "r+");

  try {
    const gpt = new GPT({ blockSize: BLOCK_SIZE });

    // Read + parse primary GPT header (LBA 1)
    const headerBuf = Buffer.alloc(BLOCK_SIZE);
    await fd.read(headerBuf, 0, BLOCK_SIZE, BLOCK_SIZE);
    gpt.parseHeader(headerBuf);

    // Read + parse full partition table
    const tableSize = Number(gpt.tableSize);
    const tableBuf = Buffer.alloc(tableSize);
    await fd.read(tableBuf, 0, tableSize, Number(gpt.tableOffset) * BLOCK_SIZE);
    gpt.parseTable(tableBuf, 0, tableSize);

    if (gpt.partitions.length === 0) {
      throw new Error("No partitions found — flash may have failed");
    }

    // Find end of last existing partition (informational / sanity-check only —
    // CONFIG is no longer placed relative to this; see below).
    let lastEndLBA = 0n;
    for (const p of gpt.partitions) {
      const end = typeof p.lastLBA === "bigint" ? p.lastLBA : BigInt(p.lastLBA);
      if (end > lastEndLBA) lastEndLBA = end;
    }

    // Relocate backup GPT to physical end of disk
    // (image backup GPT sits at image EOF, not physical drive end)
    const physicalLastSector = BigInt(totalSectors) - 1n;
    const physicalLastUsable = BigInt(totalSectors) - 34n; // reserve 33 sectors for backup header+table, minus 1
    gpt.backupLBA = physicalLastSector;
    gpt.lastLBA   = physicalLastUsable;

    // Anchor CONFIG to the PHYSICAL END of the disk, working backward, instead
    // of placing it immediately after the last partition in the image. This
    // leaves the space between the image's last partition and CONFIG free for
    // lva-os-expand to grow lvaos-data into on first boot.
    const endLBA = alignDown(physicalLastUsable);
    // Align the start DOWNWARD (not up) so the resulting partition never
    // extends past endLBA/physicalLastUsable. Aligning up here would risk
    // pushing finalEndLBA past the ceiling by up to (ALIGN_SECTORS - 1)
    // sectors, which is what was causing "Not enough space for CONFIG
    // partition" to fire incorrectly on some drive sizes.
    const startLBA = alignDown(endLBA - BigInt(CONFIG_PARTITION_SECTORS) + 1n);
    // Recompute endLBA from the aligned start so the partition is exactly
    // CONFIG_PARTITION_SECTORS long.
    const finalEndLBA = startLBA + BigInt(CONFIG_PARTITION_SECTORS) - 1n;

    if (startLBA <= lastEndLBA) {
      throw new Error(
        `Not enough space for CONFIG partition — need ${CONFIG_SIZE_MB}MB free ` +
        `at the end of the disk, after the OS image's last partition (ends at sector ${lastEndLBA})`
      );
    }
    if (finalEndLBA >= physicalLastUsable) {
      throw new Error(
        `Not enough space for CONFIG partition — need ${CONFIG_SIZE_MB}MB free before the backup GPT`
      );
    }

    gpt.partitions.push(new GPT.PartitionEntry({
      type:      LINUX_DATA_TYPE,
      guid:      crypto.randomUUID().toUpperCase(),
      name:      CONFIG_LABEL,
      firstLBA:  startLBA,
      lastLBA:   finalEndLBA,
      attr:      0n,
    }));

    // Write primary GPT header+table starting at LBA 1
    const primaryBuf = Buffer.alloc(33 * BLOCK_SIZE, 0);
    gpt.write(primaryBuf, 0);
    await fd.write(primaryBuf, 0, primaryBuf.length, BLOCK_SIZE);

    // Write backup GPT at physical end of disk
    const backupBuf = Buffer.alloc(33 * BLOCK_SIZE, 0);
    gpt.writeBackupFromPrimary(backupBuf);
    await fd.write(backupBuf, 0, backupBuf.length,
      (Number(physicalLastSector) - 32) * BLOCK_SIZE);

    // Derive partition device path, e.g.:
    //   /dev/sdb      → /dev/sdb9
    //   /dev/mmcblk0  → /dev/mmcblk0p9
    const partNum = gpt.partitions.length;
    return partitionDevicePath(devicePath, partNum);
  } finally {
    await fd.close();
  }
}

async function rereadPartitionTable(devicePath: string): Promise<void> {
  try { await execFileAsync("partprobe", [devicePath]); } catch {
    try { await execFileAsync("blockdev", ["--rereadpt", devicePath]); } catch {
      // best-effort — udev may pick it up anyway
    }
  }
}

// ─── OS-native filesystem formatting ─────────────────────────────────────────

async function formatPartition(partitionPath: string): Promise<void> {
  switch (os.platform()) {
    case "linux":
      // mkfs.ext4 is part of e2fsprogs — a base package on every Linux distro.
      // No extra install needed on Ubuntu, Debian, Fedora, Arch, etc.
      // -L sets the filesystem label that /dev/disk/by-label/CONFIG resolves to.
      await execFileAsync("mkfs.ext4", ["-L", CONFIG_LABEL, "-F", partitionPath]);
      break;

    case "darwin":
      // newfs_hfs is Apple's built-in HFS+ formatter. diskutil is also fine.
      // Type=auto on Linux will detect HFS+ without issue.
      await execFileAsync("diskutil", [
        "eraseVolume", "JHFS+", CONFIG_LABEL, partitionPath,
      ]);
      break;

    case "win32":
      // Format-Volume is built into Windows 10+ PowerShell.
      // We use NTFS since FAT32 > 32GB has restrictions on Windows.
      // Type=auto on Linux detects NTFS fine (ntfs-3g or kernel ntfs driver).
      await execFileAsync("powershell", ["-Command",
        `$p = (Get-Disk | Where-Object { $_.Path -like '*${partitionPath}*' } | Get-Partition | Where-Object { $_.IsActive -eq $false } | Select-Object -Last 1); ` +
        `Format-Volume -Partition $p -FileSystem NTFS -NewFileSystemLabel ${CONFIG_LABEL} -Force -Confirm:$false`,
      ]);
      break;

    default:
      throw new Error(`Unsupported platform: ${os.platform()}`);
  }
}

// ─── File writing via mount ───────────────────────────────────────────────────

async function writeFiles(
  partitionPath: string,
  files: { relPath: string; content: string }[]
): Promise<void> {
  switch (os.platform()) {
    case "linux":   await writeFilesLinux(partitionPath, files);   break;
    case "darwin":  await writeFilesDarwin(partitionPath, files);  break;
    case "win32":   await writeFilesWin32(partitionPath, files);   break;
    default: throw new Error(`Unsupported platform: ${os.platform()}`);
  }
}

async function writeFilesLinux(
  partitionPath: string,
  files: { relPath: string; content: string }[]
): Promise<void> {
  const mountPoint = path.join(os.tmpdir(), `lva-config-${Date.now()}`);
  await fs.promises.mkdir(mountPoint, { recursive: true });
  try {
    await execFileAsync("mount", [partitionPath, mountPoint]);
    try {
      for (const file of files) {
        const dest = path.join(mountPoint, ...file.relPath.split("/"));
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.writeFile(dest, file.content, "utf-8");
      }
    } finally {
      await execFileAsync("umount", [mountPoint]);
    }
  } finally {
    await fs.promises.rm(mountPoint, { recursive: true, force: true });
  }
}

async function writeFilesDarwin(
  partitionPath: string,
  files: { relPath: string; content: string }[]
): Promise<void> {
  const { stdout } = await execFileAsync("diskutil", ["mount", partitionPath]);
  const match = stdout.match(/mounted at (.+)/i);
  if (!match) throw new Error("Could not get mount point from diskutil output");
  const mountPoint = match[1].trim();
  try {
    for (const file of files) {
      const dest = path.join(mountPoint, ...file.relPath.split("/"));
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, file.content, "utf-8");
    }
  } finally {
    await execFileAsync("diskutil", ["unmount", partitionPath]);
  }
}

async function writeFilesWin32(
  partitionPath: string,
  files: { relPath: string; content: string }[]
): Promise<void> {
  const { stdout } = await execFileAsync("powershell", [
    "-Command", `(Get-Volume -FileSystemLabel ${CONFIG_LABEL}).DriveLetter`,
  ]);
  const letter = stdout.trim();
  if (!letter) throw new Error("Could not find CONFIG volume drive letter");
  for (const file of files) {
    const dest = path.join(`${letter}:\\`, ...file.relPath.split("/"));
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, file.content, "utf-8");
  }
}


function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}