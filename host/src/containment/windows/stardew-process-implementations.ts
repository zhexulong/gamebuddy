import { spawn, spawnSync } from "node:child_process";
import {
  type StardewAiClientProcessProbeResult,
  type StardewAiClientProcessSpawnResult,
} from "../../stardew-ai-client-process-owner.js";
import {
  type StardewPlayerHostProcessProbeResult,
  type StardewPlayerHostProcessSpawnResult,
} from "../../stardew-player-host-process-owner.js";

export function productionSpawn(
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly shell: boolean;
    readonly windowsHide: boolean;
    readonly env: Readonly<NodeJS.ProcessEnv>;
  },
): StardewAiClientProcessSpawnResult {
  const child = spawn(executable, args, options);
  const pid = child.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    child.kill();
    throw new Error("spawned_child_missing_valid_pid");
  }
  return Object.freeze({ pid, kill: () => child.kill() });
}

export function productionProbe(pid: number): StardewAiClientProcessProbeResult {
  return probeWindowsProcess(pid);
}

export function productionPlayerHostSpawn(
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly shell: boolean;
    readonly windowsHide: boolean;
    readonly env: Readonly<NodeJS.ProcessEnv>;
  },
): StardewPlayerHostProcessSpawnResult {
  const child = spawn(executable, args, options);
  const pid = child.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    child.kill();
    throw new Error("spawned_player_host_child_missing_valid_pid");
  }
  return Object.freeze({ pid, kill: () => child.kill() });
}

export function productionPlayerHostProbe(pid: number): StardewPlayerHostProcessProbeResult {
  return probeWindowsProcess(pid);
}

export function probeWindowsProcess(pid: number): Readonly<{ pid: number; creationDate: string }> | null {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId, CreationDate | ConvertTo-Json -Compress`,
    ],
    { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, encoding: "utf8" },
  );
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) return null;
  const trimmed = (result.stdout ?? "").trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) return null;
    const resultPid = parsed.ProcessId ?? parsed.pid;
    const creationDate = parsed.CreationDate ?? parsed.creationDate;
    if (typeof resultPid !== "number" || resultPid <= 0 || typeof creationDate !== "string" || creationDate.length === 0) return null;
    return { pid: resultPid, creationDate };
  } catch { return null; }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
