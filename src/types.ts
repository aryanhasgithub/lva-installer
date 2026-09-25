// Shared types for lva-installer

export interface Board {
  label: string;
  value: string;
}

export interface WiFiConfig {
  ssid: string;
  password: string;
  country: string;
}

export interface FirstbootConfig {
  version: 1;
  wifi?: WiFiConfig;
  timezone?: string;
}

export interface ReleaseManifest {
  lva: string;
  "lva-audio": string;
  "lva-portal": string;
  "lva-supervisor": string;
  "lva-cli": string;
  "lva-os": Record<string, string>; // board → version e.g. { "rpi4-64": "0.1" }
  ota: string; // URL template with {board} and {version} placeholders
}

export interface FlashProgress {
  type: "download" | "flash" | "verify";
  percentage: number;
  speed?: number; // bytes/sec
  eta?: number;   // seconds
}

export const BOARDS: Board[] = [
  { label: "Raspberry Pi 4", value: "rpi4-64" },
  { label: "Raspberry Pi 5", value: "rpi5-64" },
  { label: "Raspberry Pi 3", value: "rpi3-64" },
  { label: "Raspberry Pi Zero 2W", value: "rpi0-2w" },
  { label: "Generic x86-64", value: "generic-x86-64" },
  { label: "Generic aarch64", value: "generic-aarch64" },
];

export const MANIFEST_BASE_URL =
  "https://raw.githubusercontent.com/aryanhasgithub/lva-version/main";