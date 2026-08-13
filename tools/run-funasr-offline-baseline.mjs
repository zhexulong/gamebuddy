import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const manifestPath = option("--manifest");
const fixturePath = resolve(option("--fixture", "fixtures/voice/funasr-nano-offline-baseline.json"));
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
validateFixture(fixture);
validateManifest(manifest);
const audioPath = resolve("ref/external/Fun-ASR", fixture.source.relativeAudioPath);
const referencePath = resolve("ref/external/Fun-ASR", fixture.source.relativeReferencePath);
await assertHash(audioPath, fixture.source.audioSha256, "audio");
await assertHash(referencePath, fixture.source.referenceSha256, "reference");
const reference = String(await readFile(referencePath, "utf8")).trim();
const result = await run(manifest.executablePath, [
  "--enc",
  manifest.encoderPath,
  "-m",
  manifest.modelPath,
  "--chunk",
  String(manifest.transcriptionChunkSeconds ?? 6),
  "-a",
  audioPath,
]);
const actual = result.code === 0 ? String(result.stdout).trim() : "";
const expectedNormalized = normalize(reference);
const actualNormalized = normalize(actual);
const passed = result.code === 0 && actualNormalized === expectedNormalized;
console.log(
  JSON.stringify(
    {
      state: passed ? "passed" : "failed",
      gate: "funasr_offline_baseline",
      fixtureId: fixture.fixtureId,
      audio: fixture.audio,
      runtime: {
        runtimeId: manifest.runtimeId,
        runtimeRevision: manifest.runtimeRevision,
        modelSha256Prefix: manifest.modelSha256.slice(0, 12),
        chunkSeconds: manifest.transcriptionChunkSeconds ?? 6,
      },
      comparison: {
        mode: fixture.comparison.mode,
        expectedLength: reference.length,
        actualLength: actual.length,
        exactNormalizedMatch: passed,
      },
      failure: passed ? null : result.code === 0 ? "reference_mismatch" : "runtime_failed",
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 2;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing_${name.slice(2)}`);
  }
  if (index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}
function normalize(text) {
  return text.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
}
function validateFixture(value) {
  if (
    value?.schemaVersion !== 1 ||
    !/^[a-z0-9_]{1,96}$/.test(value?.fixtureId ?? "") ||
    value?.source?.license !== "Apache-2.0" ||
    !isSha(value?.source?.audioSha256) ||
    !isSha(value?.source?.referenceSha256) ||
    value?.comparison?.mode !== "exact_normalized"
  )
    throw new Error("invalid_funasr_offline_baseline_fixture");
}
function validateManifest(value) {
  if (
    value?.runtimeId !== "funasr-llamacpp" ||
    !isPath(value?.executablePath) ||
    !isPath(value?.encoderPath) ||
    !isPath(value?.modelPath) ||
    !Number.isInteger(value?.transcriptionChunkSeconds) ||
    value.transcriptionChunkSeconds < 1 ||
    value.transcriptionChunkSeconds > 15
  )
    throw new Error("invalid_sensevoice_asset_manifest");
}
function isSha(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
function isPath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}
async function assertHash(path, expected, kind) {
  await stat(path);
  const actual = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  if (actual !== expected) throw new Error(`funasr_baseline_${kind}_hash_mismatch`);
}
function run(executable, arguments_) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}
