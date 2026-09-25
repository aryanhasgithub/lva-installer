import * as sdk from "etcher-sdk";
import type { FlashProgress } from "../types.js";

export type DriveInfo = sdk.scanner.adapters.DrivelistDrive;

export async function listRemovableDrives(): Promise<DriveInfo[]> {
  return new Promise((resolve, reject) => {
    const adapters: sdk.scanner.adapters.Adapter[] = [
      new sdk.scanner.adapters.BlockDeviceAdapter({
        includeSystemDrives: () => true,
      }),
    ];

    const scanner = new sdk.scanner.Scanner(adapters);

    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      // Read drives BEFORE stopping — stopping clears the set
      const all = [...scanner.drives] as DriveInfo[];
      resolve(filterRemovable(all));
    };

    // Wait 3s after start for attach events to fire
    scanner.on("ready", () => setTimeout(finish, 3000));
    scanner.on("error", (err: Error) => { scanner.stop(); reject(err); });

    // Hard fallback at 8s
    setTimeout(finish, 8000);

    scanner.start();
  });
}

function filterRemovable(drives: DriveInfo[]): DriveInfo[] {
  return drives.filter((d) => {
    const a = d as any;
    if ((a.path ?? "").startsWith("/dev/loop")) return false;
    if (a.drive?.isSystem) return false;
    if (a.drive?.isVirtual) return false;
    return true;
  });
}

export async function flashImage(
  imagePath: string,
  drive: DriveInfo,
  onProgress: (p: FlashProgress) => void,
  verify = true
): Promise<void> {
  const source = new sdk.sourceDestination.File({
    path: imagePath,
  });

  const destination = new sdk.sourceDestination.BlockDevice({
    drive,
    unmountOnSuccess: true,
    direct: true,
    write: true,// direct I/O (O_DIRECT) breaks on Node 22
  });

  await sdk.multiWrite.pipeSourceToDestinations({
    source,
    destinations: [destination],
    onFail: (_dst: unknown, err: Error) => {
      throw err;
    },
    onProgress: (state: sdk.multiWrite.MultiDestinationProgress) => {
      if (state.type === "flashing") {
        onProgress({
          type: "flash",
          percentage: state.percentage ?? 0,
          speed: state.speed,
          eta: state.eta,
        });
      } else if (state.type === "verifying") {
        onProgress({
          type: "verify",
          percentage: state.percentage ?? 0,
        });
      }
    },
    verify,
  });
}