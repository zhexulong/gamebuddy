/**
 * Resident-stream Windows PCM16 render mixer (Phase 2 Slice 2 wiring).
 *
 * The reference-repo pattern (pipecat keeps the output device open and streams
 * 20ms frames in; livekit uses a fake/WebRTC stream) requires a render process
 * that opens the device once. `windows-waveout.ps1 -Mode stream` is that
 * process: it reads [4-byte LE length][PCM16 bytes] frames from stdin, plays
 * them in order, and exits on a zero-length stop frame. This mixer owns the
 * child, feeds frames from `play()`, and sends the stop frame on `stop()` —
 * so 20ms micro-chunks physically stride the device with no per-chunk spawn.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { Mixer } from "./gateway.js";

const SCRIPT_PATH = fileURLToPath(new URL("../windows-waveout.ps1", import.meta.url));
const MAX_FRAME_BYTES = 1_920_000;
const STARTUP_TIMEOUT_MS = 12_000;

export type StreamingWindowsAudioMixer = Mixer &
  Readonly<{
    readonly device: string;
    readonly failureReason?: string;
    probePcm(pcm16: Uint8Array): Promise<void>;
    close(): Promise<void>;
  }>;

export async function createStreamingWindowsAudioMixer(
  selection: string,
  spawnStream: typeof spawn = spawn,
): Promise<StreamingWindowsAudioMixer> {
  const device = validateSelection(selection);
  const child = spawnStream(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT_PATH, "-Mode", "stream", "-Device", device],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let childStderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    childStderr += chunk;
  });

  let failed: string | undefined;
  let closed = false;
  let pending: Readonly<{ reject(error: Error): void }> | undefined;

  const fail = (reason: string, error?: Error): void => {
    if (failed !== undefined) return;
    failed = reason;
    const reject = pending?.reject;
    pending = undefined;
    reject?.(error ?? new Error(reason));
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
  };

  child.once("error", () => fail("windows_stream_spawn_failed"));
  child.once("close", (code) => {
    if (failed !== undefined) return;
    fail(childStderr.length > 0 ? safeReason(childStderr) : `windows_stream_exit_${code ?? -1}`);
  });

  // Startup: wait until the child either accepts its first frame or dies. The
  // child opens the device before reading stdin, so surviving this window
  // means the device asserted. A 10ms silent frame is used as the probe.
  await new Promise<void>((resolvePromise, rejectPromise) => {
    pending = { reject: rejectPromise };
    const timer = setTimeout(() => {
      if (failed === undefined) fail("windows_stream_startup_timeout");
    }, STARTUP_TIMEOUT_MS);
    child.stdin.write(encodeFrame(new Uint8Array(320)), (error) => {
      if (error !== undefined && error !== null) {
        clearTimeout(timer);
        fail("windows_stream_write_failed", error);
        return;
      }
      clearTimeout(timer);
      resolvePromise();
    });
  }).catch((error: unknown) => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    throw error;
  });

  const play = (_jobId: string, _epoch: number, pcm16: Uint8Array): Promise<void> => {
    if (closed) return Promise.reject(new Error("windows_stream_closed"));
    if (failed !== undefined) return Promise.reject(new Error(failed));
    if (pcm16.byteLength === 0 || pcm16.byteLength > MAX_FRAME_BYTES || pcm16.byteLength % 2 !== 0) {
      fail("windows_playback_rejected");
      return Promise.reject(new Error("windows_playback_rejected"));
    }
    return new Promise<void>((resolvePromise, rejectPromise) => {
      pending = { reject: rejectPromise };
      child.stdin.write(encodeFrame(pcm16), (error) => {
        if (error !== undefined && error !== null) {
          fail("windows_stream_write_failed", error);
          return;
        }
        // The resident stream waits for the previous frame's WHDR_DONE before
        // reading the next, so write acceptance implies bounded device pacing.
        resolvePromise();
      });
    });
  };

  const stop = (): void => {
    if (closed || failed !== undefined) return;
    closed = true;
    try {
      child.stdin.write(encodeFrame(new Uint8Array(0)));
    } catch {
      /* closing anyway */
    }
  };

  return Object.freeze({
    device,
    get ready() {
      return failed === undefined && !closed;
    },
    get failureReason() {
      return failed;
    },
    async probePcm(pcm16: Uint8Array) {
      await play("voice_probe", 0, pcm16);
    },
    play,
    stop,
    async close() {
      if (!closed) stop();
      await new Promise<void>((resolvePromise) => {
        const onClose = () => resolvePromise();
        child.once("close", onClose);
        setTimeout(onClose, 2_000).unref();
      }).catch(() => undefined);
    },
  });
}

function encodeFrame(pcm16: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + pcm16.byteLength);
  new DataView(frame.buffer).setUint32(0, pcm16.byteLength, true);
  frame.set(pcm16, 4);
  return frame;
}

function validateSelection(value: string): "default" | `waveout:${number}` {
  if (value === "default" || /^waveout:[0-9]{1,4}$/.test(value)) return value as "default" | `waveout:${number}`;
  throw new Error("invalid_windows_output_device");
}

function safeReason(stderr: string): string {
  const match = stderr.match(/(?:Exception|Error)[^\r\n]*?([a-z][a-z0-9_:-]{2,80})/i);
  return match?.[1]?.toLowerCase() ?? "windows_audio_failed";
}