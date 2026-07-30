import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditSenseVoiceAssets, extractTranscript, SenseVoiceCliAsrProvider, type SenseVoiceAssetManifest, validateAssets } from "./sensevoice.js";

const assets: SenseVoiceAssetManifest = {
  runtimeId: "funasr-llamacpp",
  runtimeRevision: "v0.1.1",
  executablePath: "C:\\tools\\llama-funasr-sensevoice.exe",
  modelPath: "C:\\models\\sensevoice-small-q8.gguf",
  modelSha256: "a".repeat(64),
  vadPath: "C:\\models\\fsmn-vad.gguf",
  vadSha256: "b".repeat(64),
};

test("SenseVoice adapter uses a transient WAV, strips metadata tags, and passes audited assets", async () => {
  let executable = ""; let arguments_: readonly string[] = [];
  const provider = new SenseVoiceCliAsrProvider(assets, async (path, args) => {
    executable = path; arguments_ = args;
    return { stdout: "<|zh|><|NEUTRAL|><|Speech|> transcript: 去农场看看\n", stderr: "", exitCode: 0 };
  });
  const transcript = await provider.transcribe(new Uint8Array([0, 0, 1, 0]), "zh", new AbortController().signal);
  assert.equal(transcript, "去农场看看");
  assert.equal(provider.providerId, "sensevoice-small-local");
  assert.equal(executable, assets.executablePath);
  assert.deepEqual(arguments_.slice(0, 5), ["-m", assets.modelPath, "--vad", assets.vadPath, "-a"]);
  assert.equal(arguments_.includes("--language"), true);
  assert.equal(arguments_.includes("zh"), true);
});

test("SenseVoice asset audit verifies both manifest paths and SHA-256", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-sensevoice-audit-"));
  const executable = join(directory, "runtime.exe"); const model = join(directory, "model.gguf"); const vad = join(directory, "vad.gguf");
  try {
    await Promise.all([writeFile(executable, "runtime"), writeFile(model, "model"), writeFile(vad, "vad")]);
    const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
    const manifest = { ...assets, executablePath: executable, modelPath: model, vadPath: vad, modelSha256: sha256("model"), vadSha256: sha256("vad") };
    await auditSenseVoiceAssets(manifest);
    await assert.rejects(() => auditSenseVoiceAssets({ ...manifest, vadSha256: "0".repeat(64) }), /sensevoice_asset_hash_mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("SenseVoice adapter fails closed for unaudited assets, empty output, and cancellation", async () => {
  assert.throws(() => validateAssets({ ...assets, modelSha256: "not-a-hash" }), /invalid_sensevoice_asset_manifest/);
  const empty = new SenseVoiceCliAsrProvider(assets, async () => ({ stdout: "<|zh|>\n", stderr: "", exitCode: 0 }));
  await assert.rejects(() => empty.transcribe(new Uint8Array([0, 0]), "zh", new AbortController().signal), /sensevoice_empty_transcript/);
  const controller = new AbortController(); controller.abort();
  const provider = new SenseVoiceCliAsrProvider(assets, async () => ({ stdout: "should not run", stderr: "", exitCode: 0 }));
  await assert.rejects(() => provider.transcribe(new Uint8Array([0, 0]), "zh", controller.signal), /asr_cancelled/);
  assert.equal(extractTranscript("<|en|><|HAPPY|> text: hello world"), "hello world");
});
