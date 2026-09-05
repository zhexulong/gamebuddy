import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AsrProvider, REQUIRED_PCM_FORMAT } from "./gateway.js";

const SENSEVOICE_RUNTIME_ID = "funasr-llamacpp";
// The source runtime's binary is currently `llama-funasr-cli`: it requires a
// SenseVoice audio encoder plus a llama decoder and therefore is not a
// one-file SenseVoice executable.

export type SenseVoiceAssetManifest = Readonly<{
  runtimeId: typeof SENSEVOICE_RUNTIME_ID;
  runtimeRevision: string;
  executablePath: string;
  /** Native Fun-ASR GGUF audio encoder (passed as --enc). */
  encoderPath: string;
  encoderSha256: string;
  /** Native llama.cpp decoder GGUF (passed as -m). */
  modelPath: string;
  modelSha256: string;
  /** Kept audited for an opt-in future VAD path; normal PTT uses fixed chunks. */
  vadPath: string;
  vadSha256: string;
  /** Fixed decoding window. Avoids VAD silently dropping early PTT speech. */
  transcriptionChunkSeconds?: number;
}>;

type CommandResult = Readonly<{ stdout: string; stderr: string; exitCode: number }>;
type CommandRunner = (executable: string, arguments_: readonly string[], signal: AbortSignal) => Promise<CommandResult>;

/**
 * CPU-only SenseVoiceSmall/FSMN-VAD adapter for the audited external FunASR
 * llama.cpp runtime. The runtime, weights, and hashes are operator-provided;
 * neither is bundled into the Host, Mod, or repository. PCM is written only to
 * a private transient WAV file and removed in every completion/cancellation
 * path. SenseVoice metadata tags are stripped instead of being interpreted.
 */
export class SenseVoiceCliAsrProvider implements AsrProvider {
  public readonly providerId = "sensevoice-small-local";
  public readonly modelRevision: string;

  public constructor(
    private readonly assets: SenseVoiceAssetManifest,
    private readonly run: CommandRunner = runCommand,
  ) {
    validateAssets(assets);
    this.modelRevision = `${assets.runtimeId}:${assets.runtimeRevision}:${assets.modelSha256.slice(0, 12)}`;
  }

  public async transcribe(pcm16: Uint8Array, _locale: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error("asr_cancelled");
    if (pcm16.byteLength === 0 || pcm16.byteLength % 2 !== 0) throw new Error("invalid_pcm16_audio");
    const directory = await mkdtemp(join(tmpdir(), "gamebuddy-sensevoice-"));
    const audioPath = join(directory, `${randomUUID()}.wav`);
    try {
      await writeFile(audioPath, pcm16ToWav(pcm16));
      const result = await this.run(
        this.assets.executablePath,
        [
          "--enc",
          this.assets.encoderPath,
          "-m",
          this.assets.modelPath,
          "--chunk",
          String(transcriptionChunkSeconds(this.assets)),
          "-a",
          audioPath,
        ],
        signal,
      );
      if (signal.aborted) throw new Error("asr_cancelled");
      if (result.exitCode !== 0) throw new SenseVoiceRuntimeError(result.stderr);
      const text = extractTranscript(result.stdout);
      if (text.length === 0) throw new Error("sensevoice_no_speech");
      return text;
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Accept only an audited manifest with absolute hashes, never a guessed model. */
export function validateAssets(assets: SenseVoiceAssetManifest): void {
  if (
    assets.runtimeId !== SENSEVOICE_RUNTIME_ID ||
    !/^[A-Za-z0-9._-]{1,96}$/.test(assets.runtimeRevision) ||
    !isNonEmptyPath(assets.executablePath) ||
    !isNonEmptyPath(assets.encoderPath) ||
    !isNonEmptyPath(assets.modelPath) ||
    !isNonEmptyPath(assets.vadPath) ||
    !isSha256(assets.encoderSha256) ||
    !isSha256(assets.modelSha256) ||
    !isSha256(assets.vadSha256) ||
    (assets.transcriptionChunkSeconds !== undefined &&
      (!Number.isInteger(assets.transcriptionChunkSeconds) ||
        assets.transcriptionChunkSeconds < 1 ||
        assets.transcriptionChunkSeconds > 15))
  ) {
    throw new Error("invalid_sensevoice_asset_manifest");
  }
}

/** Verify operator-installed CPU runtime/model assets before a real ASR start. */
export async function auditSenseVoiceAssets(assets: SenseVoiceAssetManifest): Promise<void> {
  validateAssets(assets);
  await Promise.all([
    access(assets.executablePath),
    access(assets.encoderPath),
    access(assets.modelPath),
    access(assets.vadPath),
  ]).catch(() => {
    throw new Error("sensevoice_asset_missing");
  });
  const [encoderHash, modelHash, vadHash] = await Promise.all([
    sha256File(assets.encoderPath),
    sha256File(assets.modelPath),
    sha256File(assets.vadPath),
  ]);
  if (
    encoderHash !== assets.encoderSha256.toLowerCase() ||
    modelHash !== assets.modelSha256.toLowerCase() ||
    vadHash !== assets.vadSha256.toLowerCase()
  ) {
    throw new Error("sensevoice_asset_hash_mismatch");
  }
}

/** Strip model language/event/emotion tags; they are not product semantics. */
export function extractTranscript(stdout: string): string {
  return stdout
    .replace(/<\|[^|>]+\|>/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:transcript|text|result)\s*[:：]\s*/i, "").trim())
    .filter((line) => line.length > 0 && !/^\[[^\]]+\]$/.test(line) && !isNoSpeechMarker(line))
    .join(" ")
    .trim();
}

/** Native Fun-ASR's silence tokens are control outcomes, never player text. */
function isNoSpeechMarker(line: string): boolean {
  return /^(?:\/?sil(?:ence)?|<\/?sil(?:ence)?>|\[?no[ _-]?speech\]?)$/i.test(line);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Chunk every bounded PTT instead of trusting VAD to select only speech spans. */
function transcriptionChunkSeconds(assets: SenseVoiceAssetManifest): number {
  return assets.transcriptionChunkSeconds ?? 6;
}
function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}
function isNonEmptyPath(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4096;
}

function pcm16ToWav(pcm16: Uint8Array): Uint8Array {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm16.byteLength, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(REQUIRED_PCM_FORMAT.channels, 22);
  header.writeUInt32LE(REQUIRED_PCM_FORMAT.sampleRate, 24);
  const byteRate = REQUIRED_PCM_FORMAT.sampleRate * REQUIRED_PCM_FORMAT.channels * 2;
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(REQUIRED_PCM_FORMAT.channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm16.byteLength, 40);
  return Uint8Array.from(Buffer.concat([header, Buffer.from(pcm16)]));
}

class SenseVoiceRuntimeError extends Error {
  public constructor(stderr: string) {
    super(`sensevoice_runtime_failed:${sanitizeRuntimeFailure(stderr)}`);
  }
}
function sanitizeRuntimeFailure(stderr: string): string {
  const concise = stderr
    .replace(/[\r\n]+/g, " ")
    .replace(/[A-Za-z]:\\[^\s]+/g, "<path>")
    .trim();
  return concise.length === 0 ? "no_diagnostics" : concise.slice(0, 240);
}

function runCommand(executable: string, arguments_: readonly string[], signal: AbortSignal): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const abort = () => {
      child.kill();
      reject(new Error("asr_cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (exitCode) => {
      signal.removeEventListener("abort", abort);
      resolvePromise({ stdout, stderr, exitCode: exitCode ?? -1 });
    });
  });
}
