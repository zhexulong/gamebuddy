import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_CAPTURE_BYTES = 960_000;
const POWERSHELL_TIMEOUT_MS = 65_000;
const SCRIPT_PATH = fileURLToPath(new URL("../windows-wavein.ps1", import.meta.url));

export type WindowsInputDevice = Readonly<{ id: string; name: string }>;
export type WindowsInputSelection = "default" | `wavein:${number}`;
export type WindowsInputProbe = Readonly<{
  selection: WindowsInputSelection;
  resolvedDevice: WindowsInputDevice;
  pcm16Bytes: number;
}>;
export type WindowsCaptureCleanupFailure = Readonly<{
  phase: "native" | "filesystem";
  code: "native_completion_failed" | "filesystem_remove_failed" | "filesystem_absence_unverified";
  attempts: number;
}>;
export class WindowsCaptureCleanupError extends Error {
  public readonly code = "windows_capture_cleanup_failed";
  public constructor(public readonly failures: readonly WindowsCaptureCleanupFailure[]) {
    super("windows_capture_cleanup_failed");
    this.name = "WindowsCaptureCleanupError";
  }
}
type CommandRunner = (arguments_: readonly string[], signal: AbortSignal) => Promise<string>;
export interface CaptureFileSystem {
  mkdtemp(prefix: string): Promise<string>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  stat(path: string): Promise<{ isFile(): boolean }>;
}
export type WindowsPttCaptureOptions = Readonly<{
  fileSystem?: CaptureFileSystem;
  wait?: (milliseconds: number) => Promise<void>;
  cleanupRetryDelaysMs?: readonly number[];
}>;
const defaultFileSystem: CaptureFileSystem = { mkdtemp, readFile, rm, stat };
const DEFAULT_CLEANUP_RETRY_DELAYS_MS = Object.freeze([25, 100]);

/** Windows waveIn PTT adapter: no ambient capture, no frame persistence, no fallback endpoint. */
export class WindowsPttCapture {
  #active: ActiveCapture | undefined;
  #lastResolvedDevice: WindowsInputDevice | undefined;
  private readonly fileSystem: CaptureFileSystem;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly cleanupRetryDelaysMs: readonly number[];
  public constructor(
    public readonly device: WindowsInputSelection,
    private readonly run: CommandRunner = runPowerShell,
    options: WindowsPttCaptureOptions = {},
  ) {
    validateSelection(device);
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
    this.wait = options.wait ?? delay;
    this.cleanupRetryDelaysMs = options.cleanupRetryDelaysMs ?? DEFAULT_CLEANUP_RETRY_DELAYS_MS;
    if (this.cleanupRetryDelaysMs.some((milliseconds) => !Number.isSafeInteger(milliseconds) || milliseconds < 0))
      throw new Error("invalid_capture_cleanup_retry_delays");
  }
  public get active(): boolean {
    return this.#active !== undefined;
  }
  /** Resolved only after a completed native PTT capture; no device is guessed. */
  public get lastResolvedDevice(): WindowsInputDevice | undefined {
    return this.#lastResolvedDevice;
  }

  public async start(maxDurationMs = 30_000): Promise<void> {
    if (this.#active !== undefined) throw new Error("capture_already_active");
    if (!Number.isInteger(maxDurationMs) || maxDurationMs < 100 || maxDurationMs > 30_000)
      throw new Error("invalid_capture_duration");
    const completion = deferred<string>();
    const active: ActiveCapture = {
      controller: new AbortController(),
      completion: completion.promise,
      settleCompletion: completion,
      cancelRequested: false,
      nativeStarted: false,
      startupReady: deferred<void>(),
    };
    // Publish the operation before mkdtemp's first await. cancel() can now
    // linearize against startup and prevent the native helper from launching.
    this.#active = active;
    try {
      active.directory = await this.fileSystem.mkdtemp(join(tmpdir(), "gamebuddy-wavein-"));
      if (active.cancelRequested) {
        active.settleCompletion.resolve("capture_cancelled");
        active.startupReady.resolve();
        await this.cleanup(active);
        throw new Error("capture_cancelled");
      }
      active.eventName = `GameBuddyWaveIn_${randomUUID().replaceAll("-", "")}`;
      active.pcmPath = join(active.directory, "capture.pcm");
      const readyPath = join(active.directory, "capture.ready");
      active.receiptPath = join(active.directory, "capture.receipt.json");
      active.nativeStarted = true;
      let nativeCompletion: Promise<string>;
      try {
        nativeCompletion = this.run(
          [
            "-Mode",
            "capture",
            "-Device",
            this.device,
            "-PcmPath",
            active.pcmPath,
            "-ReadyPath",
            readyPath,
            "-ReceiptPath",
            active.receiptPath,
            "-EventName",
            active.eventName,
            "-MaxDurationMs",
            String(maxDurationMs),
          ],
          active.controller.signal,
        );
      } catch (error) {
        nativeCompletion = Promise.reject(error);
      }
      // Keep one stable completion promise so cancel() during mkdtemp can
      // safely await startup without racing assignment of a native promise.
      void nativeCompletion.then(completion.resolve, completion.reject);
      void active.completion.catch(() => undefined);
      active.startupReady.resolve();
      // Do not report capturing until the wave driver opened, allocated and
      // started its buffer. The helper writes no PCM until PTT stop.
      await waitForFile(readyPath, active.completion, 5_000, this.fileSystem, this.wait);
    } catch (error) {
      if (!active.nativeStarted) active.settleCompletion.resolve("capture_cancelled");
      active.startupReady.resolve();
      try {
        await this.cleanup(active);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "windows_capture_start_failed");
      }
      throw error;
    }
  }

  public async stop(): Promise<Uint8Array> {
    const active = this.requireActive();
    if (active.eventName === undefined || active.pcmPath === undefined || active.receiptPath === undefined)
      throw new Error("capture_not_ready");
    let result: Uint8Array | undefined;
    let failure: unknown;
    try {
      await this.run(
        ["-Mode", "stop", "-Device", this.device, "-EventName", active.eventName],
        new AbortController().signal,
      );
      await active.completion;
      const receipt = parseCaptureReceipt(await this.fileSystem.readFile(active.receiptPath, "utf8"));
      this.#lastResolvedDevice = receipt.resolvedDevice;
      const pcm16 = await this.fileSystem.readFile(active.pcmPath);
      if (pcm16.byteLength === 0 || pcm16.byteLength > MAX_CAPTURE_BYTES || pcm16.byteLength % 2 !== 0)
        throw new Error("invalid_capture_pcm16");
      result = Uint8Array.from(pcm16);
    } catch (error) {
      failure = error;
    }
    try {
      await this.cleanup(active);
    } catch (cleanupError) {
      throw failure === undefined
        ? cleanupError
        : new AggregateError([failure, cleanupError], "windows_capture_stop_failed");
    }
    if (failure !== undefined) throw failure;
    return result!;
  }

  public async cancel(): Promise<void> {
    const active = this.#active;
    if (active === undefined) return;
    active.cancelRequested = true;
    active.controller.abort("capture_cancelled");
    if (active.eventName !== undefined) {
      try {
        await this.run(
          ["-Mode", "stop", "-Device", this.device, "-EventName", active.eventName],
          new AbortController().signal,
        );
      } catch {
        /* The native process may already have exited; completion is still awaited below. */
      }
    } else {
      // The startup continuation will resolve completion after mkdtemp returns.
      // cleanup() intentionally waits for that continuation before rm.
    }
    await this.cleanup(active);
  }

  private requireActive(): ActiveCapture {
    if (this.#active === undefined) throw new Error("capture_not_active");
    return this.#active;
  }
  private async cleanup(active: ActiveCapture): Promise<void> {
    const existing = cleanupPromises.get(active);
    if (existing !== undefined) return existing;
    active.controller.abort("capture_finished");
    const cleanup = (async () => {
      const failures: WindowsCaptureCleanupFailure[] = [];
      await active.startupReady.promise;
      try {
        await active.completion;
      } catch (error) {
        if (active.nativeStarted && !isExpectedCancellation(error))
          failures.push({ phase: "native", code: "native_completion_failed", attempts: 1 });
      }
      if (active.directory !== undefined) {
        const filesystemFailure = await removeCaptureDirectory(
          active.directory,
          this.fileSystem,
          this.wait,
          this.cleanupRetryDelaysMs,
        );
        if (filesystemFailure !== undefined) failures.push(filesystemFailure);
      }
      if (this.#active === active) this.#active = undefined;
      if (failures.length > 0) throw new WindowsCaptureCleanupError(failures);
    })();
    cleanupPromises.set(active, cleanup);
    return cleanup;
  }
}
type ActiveCapture = {
  directory?: string;
  eventName?: string;
  pcmPath?: string;
  receiptPath?: string;
  controller: AbortController;
  completion: Promise<string>;
  settleCompletion: ReturnType<typeof deferred<string>>;
  cancelRequested: boolean;
  nativeStarted: boolean;
  startupReady: ReturnType<typeof deferred<void>>;
};
const cleanupPromises = new WeakMap<ActiveCapture, Promise<void>>();

export async function listWindowsInputDevices(
  run: CommandRunner = runPowerShell,
): Promise<readonly WindowsInputDevice[]> {
  if (process.platform !== "win32") throw new Error("windows_audio_required");
  const value: unknown = JSON.parse(await run(["-Mode", "list"], new AbortController().signal));
  const records = Array.isArray(value) ? value : value === null ? [] : [value];
  const devices = records.map(parseDevice);
  if (devices.length === 0) throw new Error("windows_input_device_missing");
  return Object.freeze(devices);
}

/** Opens a device and receives bounded PCM. This intentionally does not transcribe. */
export async function probeWindowsInput(
  selection: WindowsInputSelection,
  run: CommandRunner = runPowerShell,
): Promise<WindowsInputProbe> {
  validateSelection(selection);
  const text = await run(["-Mode", "probe", "-Device", selection], new AbortController().signal);
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    value.state !== "passed" ||
    typeof value.pcm16Bytes !== "number" ||
    !Number.isSafeInteger(value.pcm16Bytes) ||
    value.pcm16Bytes <= 0 ||
    value.pcm16Bytes > MAX_CAPTURE_BYTES ||
    value.pcm16Bytes % 2 !== 0 ||
    typeof value.resolvedDeviceId !== "string" ||
    typeof value.resolvedDeviceName !== "string"
  )
    throw new Error("windows_input_probe_invalid");
  let resolvedDevice: WindowsInputDevice;
  try {
    resolvedDevice = parseDevice({ id: value.resolvedDeviceId, name: value.resolvedDeviceName });
  } catch {
    throw new Error("windows_input_probe_invalid");
  }
  return Object.freeze({ selection, resolvedDevice, pcm16Bytes: value.pcm16Bytes });
}

function parseDevice(value: unknown): WindowsInputDevice {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^wavein:[0-9]{1,4}$/.test(value.id) ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    value.name.length > 256
  )
    throw new Error("windows_input_device_list_invalid");
  return Object.freeze({ id: value.id, name: value.name.trim() });
}
function parseCaptureReceipt(text: string): Readonly<{ resolvedDevice: WindowsInputDevice }> {
  let value: unknown;
  try {
    value = JSON.parse(text.trim().replace(/^\uFEFF/, ""));
  } catch {
    value = undefined;
  }
  if (
    !isRecord(value) ||
    value.state !== "passed" ||
    typeof value.resolvedDeviceId !== "string" ||
    typeof value.resolvedDeviceName !== "string"
  )
    throw new Error("windows_capture_receipt_invalid");
  try {
    return Object.freeze({
      resolvedDevice: parseDevice({ id: value.resolvedDeviceId, name: value.resolvedDeviceName }),
    });
  } catch {
    throw new Error("windows_capture_receipt_invalid");
  }
}
function isExpectedCancellation(error: unknown): boolean {
  return (
    error instanceof Error && (error.message === "windows_capture_cancelled" || error.message === "capture_cancelled")
  );
}
function validateSelection(value: string): WindowsInputSelection {
  if (value === "default" || /^wavein:[0-9]{1,4}$/.test(value)) return value as WindowsInputSelection;
  throw new Error("invalid_windows_input_device");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
async function waitForFile(
  path: string,
  completion: Promise<string>,
  timeoutMs: number,
  fileSystem: CaptureFileSystem,
  wait: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fileSystem.stat(path)).isFile()) return;
    } catch {
      /* driver has not yet opened. */
    }
    if (Date.now() >= deadline) throw new Error("windows_capture_open_timeout");
    const race = await Promise.race([completion.then(() => "ended" as const), wait(25).then(() => "wait" as const)]);
    if (race === "ended") throw new Error("capture_ended_before_ready");
  }
}
async function removeCaptureDirectory(
  directory: string,
  fileSystem: CaptureFileSystem,
  wait: (milliseconds: number) => Promise<void>,
  retryDelaysMs: readonly number[],
): Promise<WindowsCaptureCleanupFailure | undefined> {
  const attempts = retryDelaysMs.length + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await fileSystem.rm(directory, { recursive: true, force: true });
    } catch {
      if (attempt + 1 < attempts) {
        await wait(retryDelaysMs[attempt]!);
        continue;
      }
      return { phase: "filesystem", code: "filesystem_remove_failed", attempts };
    }
    try {
      await fileSystem.stat(directory);
      if (attempt + 1 < attempts) {
        await wait(retryDelaysMs[attempt]!);
        continue;
      }
      return { phase: "filesystem", code: "filesystem_absence_unverified", attempts };
    } catch (error) {
      if (isMissingPath(error)) return undefined;
      if (attempt + 1 < attempts) {
        await wait(retryDelaysMs[attempt]!);
        continue;
      }
      return { phase: "filesystem", code: "filesystem_absence_unverified", attempts };
    }
  }
  return { phase: "filesystem", code: "filesystem_remove_failed", attempts };
}
function isMissingPath(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
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
    let settled = false;
    let requestedFailure: Error | undefined;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      callback();
    };
    const requestTermination = (failure: Error) => {
      requestedFailure ??= failure;
      child.kill();
    };
    const timer = setTimeout(() => requestTermination(new Error("windows_capture_timeout")), POWERSHELL_TIMEOUT_MS);
    const abort = () => requestTermination(new Error("windows_capture_cancelled"));
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
      requestedFailure ??= error;
      child.kill();
    });
    child.once("close", (code) =>
      settle(() => {
        if (requestedFailure !== undefined) {
          reject(requestedFailure);
          return;
        }
        code === 0
          ? resolvePromise(stdout.trim())
          : reject(
              new Error(stderr.trim().length === 0 ? `windows_capture_exit_${code ?? -1}` : "windows_capture_failed"),
            );
      }),
    );
  });
}
