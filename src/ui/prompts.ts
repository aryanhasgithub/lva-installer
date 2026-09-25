import inquirer from "inquirer";
import ora from "ora";
import chalk from "chalk";
import { BOARDS } from "../types.js";
import type { WiFiConfig, FlashProgress } from "../types.js";
import type { DriveInfo } from "../core/flash.js";

// ─── Branding ────────────────────────────────────────────────────────────────

export function printBanner(): void {
  console.clear();
  console.log(chalk.cyan.bold(`
  ██╗     ██╗   ██╗ █████╗       ██████╗ ███████╗
  ██║     ██║   ██║██╔══██╗     ██╔═══██╗██╔════╝
  ██║     ██║   ██║███████║     ██║   ██║███████╗
  ██║     ╚██╗ ██╔╝██╔══██║     ██║   ██║╚════██║
  ███████╗ ╚████╔╝ ██║  ██║     ╚██████╔╝███████║
  ╚══════╝  ╚═══╝  ╚═╝  ╚═╝      ╚═════╝ ╚══════╝
  `));
  console.log(chalk.dim("  Linux Voice Assistant OS — Installer\n"));
}

// ─── Board selection ─────────────────────────────────────────────────────────

export async function promptBoard(): Promise<string> {
  const { board } = await inquirer.prompt([
    {
      type: "list",
      name: "board",
      message: "Select your target board:",
      choices: BOARDS.map((b) => ({ name: b.label, value: b.value })),
    },
  ]);
  return board;
}

// ─── Network config ───────────────────────────────────────────────────────────

export async function promptNetwork(): Promise<WiFiConfig | null> {
  const { networkType } = await inquirer.prompt([
    {
      type: "list",
      name: "networkType",
      message: "How will LVA-OS connect to your network?",
      choices: [
        { name: "WiFi (enter credentials)", value: "wifi" },
        { name: "Ethernet (skip WiFi setup)", value: "ethernet" },
      ],
    },
  ]);

  if (networkType === "ethernet") {
    console.log(chalk.dim("  → Ethernet selected, skipping WiFi config\n"));
    return null;
  }

  const { ssid } = await inquirer.prompt([
    {
      type: "input",
      name: "ssid",
      message: "WiFi network name (SSID):",
      validate: (v: string) => v.trim().length > 0 || "SSID cannot be empty",
    },
  ]);

  const { password } = await inquirer.prompt([
    {
      type: "password",
      name: "password",
      message: "WiFi password:",
      mask: "*",
      validate: (v: string) => v.length > 0 || "Password cannot be empty",
    },
  ]);

  const { country } = await inquirer.prompt([
    {
      type: "input",
      name: "country",
      message: "WiFi country code:",
      default: "US",
      validate: (v: string) =>
        /^[A-Za-z]{2}$/.test(v.trim()) || "Enter a 2-letter country code (e.g. US, GB, IN)",
      filter: (v: string) => v.trim().toUpperCase(),
    },
  ]);

  return { ssid: ssid.trim(), password, country };
}

// ─── Timezone ────────────────────────────────────────────────────────────────

export async function promptTimezone(): Promise<string | null> {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const { setTimezone } = await inquirer.prompt([
    {
      type: "confirm",
      name: "setTimezone",
      message: `Set device timezone to ${chalk.cyan(detected)} (detected from this machine)?`,
      default: true,
    },
  ]);

  if (setTimezone) {
    return detected;
  }

  const { skip } = await inquirer.prompt([
    {
      type: "confirm",
      name: "skip",
      message: "Skip timezone setup (use OS default)?",
      default: false,
    },
  ]);
  if (skip) return null;

  const { timezone } = await inquirer.prompt([
    {
      type: "input",
      name: "timezone",
      message: "Enter IANA timezone (e.g. Europe/London):",
      default: detected,
      validate: (v: string) => v.trim().length > 0 || "Timezone cannot be empty",
      filter: (v: string) => v.trim(),
    },
  ]);
  return timezone;
}

// ─── Drive selection ──────────────────────────────────────────────────────────

export async function promptDrive(drives: DriveInfo[]): Promise<DriveInfo> {
  if (drives.length === 0) {
    throw new Error(
      "No removable drives found. Insert a USB drive and try again."
    );
  }

  const { drive } = await inquirer.prompt([
    {
      type: "list",
      name: "drive",
      message: chalk.red("Select target drive") + chalk.dim(" (ALL DATA WILL BE ERASED):"),
      choices: drives.map((d) => ({
        name: `${(d as any).drive?.description ?? (d as any).path}  ${chalk.dim((d as any).drive?.device ?? "")}  ${chalk.yellow(formatBytes((d as any).drive?.size ?? 0))}`,
        value: d,
      })),
    },
  ]);

  return drive;
}

// ─── Confirmation ─────────────────────────────────────────────────────────────

export async function promptConfirm(drive: DriveInfo): Promise<boolean> {
  const { confirmed } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirmed",
      message: chalk.red.bold(
        `⚠  This will ERASE ALL DATA on ${(drive as any).drive?.description ?? (drive as any).path} (${(drive as any).drive?.device ?? ""}). Continue?`
      ),
      default: false,
    },
  ]);
  return confirmed;
}

// ─── Progress display ─────────────────────────────────────────────────────────

export function createProgressSpinner(label: string): ReturnType<typeof ora> {
  return ora({ text: label, color: "cyan" }).start();
}

export function renderProgress(
  spinner: ReturnType<typeof ora>,
  p: FlashProgress
): void {
  const pct = p.percentage.toFixed(1).padStart(5);
  const speed = p.speed ? `  ${formatBytes(p.speed)}/s` : "";
  const eta = p.eta ? `  ETA ${formatTime(p.eta)}` : "";

  const labels: Record<FlashProgress["type"], string> = {
    download: "Downloading",
    flash: "Flashing",
    verify: "Verifying",
  };

  spinner.text =
    `${labels[p.type]}  ${chalk.cyan(pct + "%")}` +
    chalk.dim(speed + eta);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}