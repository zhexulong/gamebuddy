import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { type Mixer } from "./gateway.js";

const MAX_PCM_BYTES = 1_920_000;
const POWERSHELL_TIMEOUT_MS = 12_000;
const SCRIPT_PATH = fileURLToPath(new URL("../windows-waveout.ps1", import.meta.url));

export type WindowsOutputDevice = Readonly<{ id: string; name: string }>;
export type WindowsOutputSelection = "default" | `waveout:${number}`;
export type WindowsAudioMixer = Mixer &
  Readonly<{
    readonly device: WindowsOutputSelection;
    readonly failureReason?: string;
    probePcm(pcm16: Uint8Array): Promise<void>;
  }>;
type CommandRunner = (arguments_: readonly string[], signal: AbortSignal) => Promise<string>;

/**
 * A deliberately narrow Windows PCM16 render adapter. `default` resolves by
 * passing WAVE_MAPPER to winmm on every probe/play; named selections bind a
 * numbered waveOut endpoint. A write is acknowledged only after the driver
 * marks the submitted buffer complete. This does not capture microphone data.
 */
export async function listWindowsOutputDevices(
  run: CommandRunner = runPowerShell,
): Promise<readonly WindowsOutputDevice[]> {
  if (process.platform !== "win32") throw new Error("windows_audio_required");
  const text = await run(["-Mode", "list"], new AbortController().signal);
  const value: unknown = JSON.parse(text);
  const records = Array.isArray(value) ? value : value === null ? [] : [value];
  const devices = records.map(parseDevice);
  if (devices.length === 0) throw new Error("windows_output_device_missing");
  return Object.freeze(devices);
}

/** Opens default or selected output and submits a short silent PCM16 buffer. */
export async function probeWindowsOutput(
  selection: WindowsOutputSelection,
  run: CommandRunner = runPowerShell,
): Promise<void> {
  await run(["-Mode", "probe", "-Device", validateSelection(selection)], new AbortController().signal);
}

/**
 * Starts fail-closed. It becomes ready only after an open/write/completion
 * probe. Every later playback failure revokes readiness for this process; the
 * Host must restart/reprobe rather than silently switching endpoint.
 */
export async function createWindowsAudioMixer(
  selection: WindowsOutputSelection,
  run: CommandRunner = runPowerShell,
): Promise<WindowsAudioMixer> {
  const device = validateSelection(selection);
  try {
    await probeWindowsOutput(device, run);
  } catch (error) {
    return unavailableMixer(device, reason(error));
  }
  return new WaveOutMixer(device, run);
}

function parseDevice(value: unknown): WindowsOutputDevice {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^waveout:[0-9]{1,4}$/.test(value.id) ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    value.name.length > 256
  ) {
    throw new Error("windows_output_device_list_invalid");
  }
  return Object.freeze({ id: value.id, name: value.name.trim() });
}
function validateSelection(value: string): WindowsOutputSelection {
  if (value === "default" || /^waveout:[0-9]{1,4}$/.test(value)) return value as WindowsOutputSelection;
  throw new Error("invalid_windows_output_device");
}
function unavailableMixer(device: WindowsOutputSelection, failureReason: string): WindowsAudioMixer {
  return Object.freeze({
    device,
    ready: false,
    failureReason,
    async probePcm() {
      throw new Error(failureReason);
    },
    play() {},
    stop() {},
  });
}
function reason(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 128) : "windows_audio_failed";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class WaveOutMixer implements WindowsAudioMixer {
  public failureReason: string | undefined;
  public get ready(): boolean {
    return !this.#stopped && this.failureReason === undefined;
  }
  #stopped = false;
  #pending = new Map<string, AbortController>();
  public constructor(
    public readonly device: WindowsOutputSelection,
    private readonly run: CommandRunner,
  ) {}

  public async play(_jobId: string, _epoch: number, pcm16: Uint8Array): Promise<void> {
    if (
      this.#stopped ||
      this.failureReason !== undefined ||
      pcm16.byteLength === 0 ||
      pcm16.byteLength > MAX_PCM_BYTES ||
      pcm16.byteLength % 2 !== 0
    ) {
      this.revoke("windows_playback_rejected");
      throw new Error(this.failureReason);
    }
    const id = randomUUID();
    const controller = new AbortController();
    this.#pending.set(id, controller);
    await this.playAsync(id, pcm16, controller.signal);
  }

  public async probePcm(pcm16: Uint8Array): Promise<void> {
    await this.play("voice_probe", 0, pcm16);
  }

  public stop(): void {
    this.#stopped = true;
    for (const controller of this.#pending.values()) controller.abort("mixer_stopped");
    this.#pending.clear();
  }

  private async playAsync(id: string, pcm16: Uint8Array, signal: AbortSignal): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "gamebuddy-waveout-"));
    const pcmPath = join(directory, `${id}.pcm`);
    try {
      if (signal.aborted || this.#stopped) throw new Error("mixer_stopped");
      await writeFile(pcmPath, pcm16);
      await this.run(["-Mode", "play", "-Device", this.device, "-PcmPath", pcmPath], signal);
    } catch (error) {
      if (!signal.aborted) this.revoke(reason(error));
      throw error;
    } finally {
      this.#pending.delete(id);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private revoke(value: string): void {
    if (this.failureReason !== undefined) return;
    this.failureReason = value;
    this.stop();
  }
}

function runPowerShell(arguments_: readonly string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT_PATH, ...arguments_],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("windows_audio_timeout"));
    }, POWERSHELL_TIMEOUT_MS);
    const abort = () => {
      child.kill();
      reject(new Error("windows_audio_cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error(safePowerShellReason(stderr) ?? `windows_audio_exit_${code ?? -1}`));
    });
  });
}
function safePowerShellReason(stderr: string): string | undefined {
  const match = stderr.match(/(?:Exception|Error)[^\r\n]*?([a-z][a-z0-9_:-]{2,80})/i);
  return match?.[1]?.toLowerCase() ?? (stderr.trim().length > 0 ? "windows_audio_failed" : undefined);
}
