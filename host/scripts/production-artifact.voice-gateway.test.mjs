import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { readArtifactConfig } from "./production-artifact.mjs";
import { assertCompleteTestArtifact, publishTestArtifact, recheckTestArtifactEntry, resolveTestArtifactEntry } from "./production-artifact-test-support.mjs";
import { publishVoiceGatewayFixture, verifyPublishedVoiceGateway, VOICE_GATEWAY_ADMISSION } from "./voice-artifact-fixture-publisher.mjs";
import { withSyntheticVerifiedReleaseBundledRuntimeForTest } from "./node-runtime-release-acquisition.mjs";

const hostRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptRoot = join(fileURLToPath(new URL(".", import.meta.url)), "");
const REQUIRED_VERIFICATION_ROOTS = [
  "tavern/player-turn-acceptance.js",
  "tavern/provider-attempt-claim.js",
  "tavern/chat-provider-start.js",
  "tavern/reference-pipeline-static-shell-composition.js",
  "reference-pipeline-dialogue-web.js",
  "tavern-management-dialogue-web.js",
  "tavern/tavern-management-static-shell-composition.js",
  "tavern/static-artifact/index.js",
];
const BUNDLED_RUNTIME = {
  kind: "verified_host_bundled_node_runtime",
  sourceUrl: "https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip",
  archiveSha256: "6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba",
  archiveRoot: "node-v24.20.0-win-x64",
  runtimePath: "runtime/node.exe",
  nodeSha256: "5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5",
  bootstrapPath: "bootstrap/entry/desktop-host-entry.internal.js",
  runtimeVersion: "v24.20.0",
  runtimePlatform: "win32",
  runtimeArch: "x64",
};
const VOICE_GATEWAY_DESCRIPTOR = { kind: "verified_voice_gateway", entry: { destination: "voice-gateway/entry" }, protocol: { destination: "voice-gateway/protocol" } };
const testHash = (value) => createHash("sha256").update(value).digest("hex");
const testU16 = (value) => { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value); return bytes; };
const testU32 = (value) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };

function productionConfig(config) {
  return {
    schema: "gamebuddy-host-production-artifact-config/v3",
    verificationRoots: REQUIRED_VERIFICATION_ROOTS,
    bundledRuntime: BUNDLED_RUNTIME,
    ...config,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-voice-publisher-"));
  await mkdir(join(root, "resources"), { recursive: true });
  await mkdir(join(root, "node_modules", "typebox"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { typebox: "1.1.38" } }));
  await writeFile(join(root, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox", main: "index.js" }));
  await writeFile(join(root, "node_modules", "typebox", "index.js"), "export {};\n");
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] } })));
  await writeFile(join(root, "resources/windows-named-mutex-broker.ps1"), "broker");
  return root;
}
async function enableVoiceGateway(root) {
  const config = JSON.parse(await readFile(join(root, "production-artifact.config.json"), "utf8"));
  config.voiceGateway = VOICE_GATEWAY_DESCRIPTOR;
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(config));
}
async function voiceSources(root, { entryBytes = Buffer.from("voice gateway entry fixture\n"), protocolBytes = Buffer.from("voice gateway protocol fixture\n") } = {}) {
  const entryRoot = join(root, "voice-gateway", ".dist", "entry");
  const protocolRoot = join(root, "voice-gateway", ".dist", "protocol");
  await mkdir(entryRoot, { recursive: true }); await mkdir(protocolRoot, { recursive: true });
  await writeFile(join(entryRoot, "voice-gateway-entry.mjs"), entryBytes);
  await writeFile(join(protocolRoot, "voice-gateway-protocol.json"), protocolBytes);
  return { entryBytes, protocolBytes };
}

async function emit(root) {
  const emitted = join(root, "emitted");
  await rm(emitted, { recursive: true, force: true });
  await mkdir(join(emitted, "tavern"), { recursive: true });
  await writeFile(join(emitted, "main.js"), "import \"typebox\";\nexport {};\n");
  await mkdir(join(emitted, "bootstrap", "entry"), { recursive: true });
  await writeFile(join(emitted, "bootstrap", "entry", "desktop-host-entry.internal.js"), "export {};\n");
  for (const verificationRoot of REQUIRED_VERIFICATION_ROOTS) {
    await mkdir(dirname(join(emitted, verificationRoot)), { recursive: true });
    await writeFile(join(emitted, verificationRoot), "export {};\n");
  }
  return emitted;
}

function syntheticRuntimeZip(files = [{ path: "node.exe", bytes: Buffer.from("test node runtime") }]) {
  const entries = files.map(({ path, bytes }) => {
    const name = Buffer.from(`node-v24.20.0-win-x64/${path}`);
    const crc = 0;
    const local = Buffer.concat([Buffer.from("504b0304", "hex"), testU16(20), testU16(0), testU16(0), testU16(0), testU16(0), testU32(crc), testU32(bytes.length), testU32(bytes.length), testU16(name.length), testU16(0), name, bytes]);
    return { local, name, bytes };
  });
  const centralOffset = entries.reduce((offset, entry) => offset + entry.local.length, 0);
  let localOffset = 0;
  const central = Buffer.concat(entries.map((entry) => {
    const offset = localOffset;
    localOffset += entry.local.length;
    return Buffer.concat([Buffer.from("504b0102", "hex"), testU16(0x0314), testU16(20), testU16(0), testU16(0), testU16(0), testU16(0), testU32(0), testU32(entry.bytes.length), testU32(entry.bytes.length), testU16(entry.name.length), testU16(0), testU16(0), testU16(0), testU16(0), testU32(0), testU32(offset), entry.name]);
  }));
  return {
    bytes: Buffer.concat([Buffer.concat(entries.map((entry) => entry.local)), central, Buffer.from("504b0506", "hex"), testU16(0), testU16(0), testU16(entries.length), testU16(entries.length), testU32(central.length), testU32(centralOffset), testU16(0)]),
    node: files.find((file) => file.path === "node.exe")?.bytes,
  };
}

// Exercise the production-private publisher seam without widening its release
// API. The probe copies the implementation under test and adds exports only to
// its disposable test-local copy, so the production module's public surface is
// intact. The probe copy resolves the shared voice fixture publisher
// relatively, so that module is copied next to it as well.
async function withProductionPublisherProbe(run) {
  const probeRoot = await mkdtemp(join(scriptRoot, ".voice-production-probe-"));
  const probePath = join(probeRoot, "production-artifact.mjs");
  try {
    const source = await readFile(join(scriptRoot, "production-artifact.mjs"), "utf8");
    await writeFile(probePath, `${source}\nexport { copyVerifiedBundledRuntimeSource, publishProductionArtifactWithRuntimeCopier };\n`);
    await cp(join(scriptRoot, "production-artifact-esm-resolution-probe.mjs"), join(probeRoot, "production-artifact-esm-resolution-probe.mjs"));
    await cp(join(scriptRoot, "voice-artifact-fixture-publisher.mjs"), join(probeRoot, "voice-artifact-fixture-publisher.mjs"));
    return await run(await import(`${pathToFileURL(probePath).href}?test=${Date.now()}`));
  } finally { await rm(probeRoot, { recursive: true, force: true }); }
}

/** Publishes through the production publisher (private copier seam) with the
 * fixture's own config: voice gateway staging participates only when the
 * fixture config carries the voiceGateway descriptor. */
async function publishWithPrivateCopier({ root, outputRoot }) {
  const { bytes, node } = syntheticRuntimeZip();
  const descriptor = { ...BUNDLED_RUNTIME, archiveSha256: testHash(bytes), nodeSha256: testHash(node) };
  return withSyntheticVerifiedReleaseBundledRuntimeForTest({ descriptor, zipBytes: bytes }, async (runtimeSource) =>
    withProductionPublisherProbe(async ({ copyVerifiedBundledRuntimeSource, publishProductionArtifactWithRuntimeCopier }) => {
      return publishProductionArtifactWithRuntimeCopier(
        { hostRoot: root, emittedRoot: await emit(root), outputRoot },
        async (stagingRoot, runtimeDescriptor) => copyVerifiedBundledRuntimeSource({ stagingRoot, descriptor: runtimeDescriptor, source: runtimeSource }),
        descriptor,
      );
    }));
}

async function publishWithTestSupport({ root, outputRoot }) {
  const { bytes, node } = syntheticRuntimeZip();
  const descriptor = { sourceUrl: BUNDLED_RUNTIME.sourceUrl, archiveSha256: testHash(bytes), archiveRoot: BUNDLED_RUNTIME.archiveRoot, nodeSha256: testHash(node) };
  return withSyntheticVerifiedReleaseBundledRuntimeForTest({ descriptor, zipBytes: bytes }, async (runtimeSource) =>
    publishTestArtifact({ hostRoot: root, emittedRoot: await emit(root), outputRoot, runtimeSource }));
}

const withFixture = async (run) => { const root = await fixture(); try { await run(root); } finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } };
const generationRoot = (outputRoot, generation) => join(outputRoot, "generations", generation);

test("default production config never enables the voice gateway descriptor", async () => {
  const config = JSON.parse(await readFile(join(hostRoot, "production-artifact.config.json"), "utf8"));
  assert.equal(config.schema, "gamebuddy-host-production-artifact-config/v3");
  assert.equal(Object.hasOwn(config, "voiceGateway"), false);
});

test("voice gateway absent leaves the published generation voice-free with a stable inventory digest", async () => withFixture(async (root) => {
  const firstRoot = join(root, "dist-first"); const secondRoot = join(root, "dist-second");
  const first = await publishWithPrivateCopier({ root, outputRoot: firstRoot });
  const second = await publishWithPrivateCopier({ root, outputRoot: secondRoot });
  assert.equal(first.digest, second.digest);
  const artifactRoot = generationRoot(firstRoot, first.generation);
  const files = (await readdir(artifactRoot, { recursive: true })).map((path) => path.replaceAll("\\", "/"));
  assert.ok(!files.includes(VOICE_GATEWAY_ADMISSION));
  assert.ok(!files.some((path) => path.startsWith("voice-gateway/")));
}));

test("a legal voice fixture stages single-file entry and protocol bound to the production inventory with a verified admission", async () => withFixture(async (root) => {
  const { entryBytes, protocolBytes } = await voiceSources(root);
  await enableVoiceGateway(root);
  const outputRoot = join(root, "dist");
  const published = await publishWithPrivateCopier({ root, outputRoot });
  const artifactRoot = generationRoot(outputRoot, published.generation);
  const entryPath = "voice-gateway/entry/voice-gateway-entry.mjs";
  const protocolPath = "voice-gateway/protocol/voice-gateway-protocol.json";
  const admission = JSON.parse(await readFile(join(artifactRoot, VOICE_GATEWAY_ADMISSION), "utf8"));
  assert.equal(admission.schema, "gamebuddy-host-voice-gateway-admission/v1");
  assert.equal(admission.generation, published.generation);
  assert.equal(admission.entryPath, entryPath);
  assert.equal(admission.protocolPath, protocolPath);
  assert.equal(admission.entrySha256, testHash(entryBytes));
  assert.equal(admission.protocolSha256, testHash(protocolBytes));
  assert.match(admission.inventoryDigest, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(join(artifactRoot, "voice-gateway", "entry", "voice-gateway-entry.mjs"), "utf8"), entryBytes.toString());
  assert.equal(await readFile(join(artifactRoot, "voice-gateway", "protocol", "voice-gateway-protocol.json"), "utf8"), protocolBytes.toString());
  await assert.doesNotReject(verifyPublishedVoiceGateway({ artifactRoot, descriptor: VOICE_GATEWAY_DESCRIPTOR }));
  const inventory = JSON.parse(await readFile(join(artifactRoot, "production-inventory.json"), "utf8"));
  const entry = inventory.entries.find((item) => item.path === entryPath);
  const protocol = inventory.entries.find((item) => item.path === protocolPath);
  assert.deepEqual(entry.origin, { kind: "verified_voice_gateway", entryPath, entrySha256: testHash(entryBytes), protocolPath, protocolSha256: testHash(protocolBytes) });
  assert.deepEqual(protocol.origin, entry.origin);
  assert.ok(!inventory.entries.some((item) => item.path === VOICE_GATEWAY_ADMISSION), "admission sidecar must be excluded from the inventory");
  await writeFile(join(artifactRoot, "voice-gateway", "entry", "voice-gateway-entry.mjs"), "tampered");
  await assert.rejects(verifyPublishedVoiceGateway({ artifactRoot, descriptor: VOICE_GATEWAY_DESCRIPTOR }), /voice_gateway_entry_mismatch/);
}));

test("a voice-enabled generation survives the complete artifact recheck and tampering fails it", async () => withFixture(async (root) => {
  await voiceSources(root);
  await enableVoiceGateway(root);
  const outputRoot = join(root, "dist");
  const published = await publishWithTestSupport({ root, outputRoot });
  const selected = await resolveTestArtifactEntry({ hostRoot: root, outputRoot, entry: "main.js" });
  assert.equal(selected.generation, published.generation);
  await assert.doesNotReject(recheckTestArtifactEntry({ hostRoot: root, selected }));
  await assert.doesNotReject(assertCompleteTestArtifact({ hostRoot: root, outputRoot }));
  const artifactRoot = join(outputRoot, "test-generations", published.generation);
  const admissionPath = join(artifactRoot, VOICE_GATEWAY_ADMISSION);
  const admission = JSON.parse(await readFile(admissionPath, "utf8"));
  await writeFile(admissionPath, `${JSON.stringify({ ...admission, entrySha256: "0".repeat(64) })}\n`);
  await assert.rejects(assertCompleteTestArtifact({ hostRoot: root, outputRoot }), /voice_gateway_entry_mismatch/);
  await writeFile(admissionPath, "not json\n");
  await assert.rejects(assertCompleteTestArtifact({ hostRoot: root, outputRoot }), /voice_gateway_admission_invalid/);
  await writeFile(admissionPath, `${JSON.stringify(admission)}\n`);
  await writeFile(join(artifactRoot, "voice-gateway", "protocol", "voice-gateway-protocol.json"), "tampered");
  await assert.rejects(assertCompleteTestArtifact({ hostRoot: root, outputRoot }), /voice_gateway_protocol_mismatch/);
}));

test("voice publish fails closed on missing, multi-file and symlinked sources without selecting a candidate", async (t) => {
  // Missing entry source.
  await withFixture(async (root) => {
    await enableVoiceGateway(root);
    const outputRoot = join(root, "dist");
    await assert.rejects(publishWithPrivateCopier({ root, outputRoot }), /voice_fixture_entry_missing/);
    await assert.rejects(lstat(join(outputRoot, "current.json")), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(outputRoot, "generations")).catch(() => []), []);
  });
  // Multi-file entry source.
  await withFixture(async (root) => {
    await voiceSources(root);
    await writeFile(join(root, "voice-gateway", ".dist", "entry", "second.mjs"), "second");
    await enableVoiceGateway(root);
    const outputRoot = join(root, "dist");
    await assert.rejects(publishWithPrivateCopier({ root, outputRoot }), /voice_fixture_entry_protocol_must_be_single_files/);
    await assert.rejects(lstat(join(outputRoot, "current.json")), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(outputRoot, "generations")).catch(() => []), []);
  });
  // Symlinked entry source.
  await withFixture(async (root) => {
    const realEntry = join(root, "voice-gateway", ".dist", "real-entry");
    await mkdir(dirname(realEntry), { recursive: true });
    await writeFile(realEntry, "entry bytes");
    try { await symlink(realEntry, join(root, "voice-gateway", ".dist", "entry")); } catch (error) { t.skip(`symlink creation unavailable: ${error.code ?? error.message}`); return; }
    const protocolRoot = join(root, "voice-gateway", ".dist", "protocol");
    await mkdir(protocolRoot, { recursive: true });
    await writeFile(join(protocolRoot, "voice-gateway-protocol.json"), "protocol bytes");
    await enableVoiceGateway(root);
    const outputRoot = join(root, "dist");
    await assert.rejects(publishWithPrivateCopier({ root, outputRoot }), /voice_fixture_entry_missing/);
    await assert.rejects(lstat(join(outputRoot, "current.json")), { code: "ENOENT" });
  });
});

test("a traversal or drifting voice gateway descriptor is rejected before any publish", async () => withFixture(async (root) => {
  for (const invalid of [
    { ...VOICE_GATEWAY_DESCRIPTOR, entry: { destination: "../escape" } },
    { ...VOICE_GATEWAY_DESCRIPTOR, entry: { destination: "voice-gateway/other" } },
    { ...VOICE_GATEWAY_DESCRIPTOR, protocol: { destination: "/absolute" } },
    { ...VOICE_GATEWAY_DESCRIPTOR, kind: "verified_voice_cleaner" },
    { ...VOICE_GATEWAY_DESCRIPTOR, arbitrary: true },
    { entry: { destination: "voice-gateway/entry" }, protocol: { destination: "voice-gateway/protocol" } },
  ]) {
    const config = JSON.parse(await readFile(join(root, "production-artifact.config.json"), "utf8"));
    config.voiceGateway = invalid;
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(config));
    await assert.rejects(readArtifactConfig(root), /invalid_voice_gateway_descriptor/);
  }
  const config = JSON.parse(await readFile(join(root, "production-artifact.config.json"), "utf8"));
  config.voiceGateway = VOICE_GATEWAY_DESCRIPTOR;
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(config));
  assert.deepEqual((await readArtifactConfig(root)).voiceGateway, VOICE_GATEWAY_DESCRIPTOR);
}));

test("verifyPublishedVoiceGateway rechecks a fixture-published staging root without mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-voice-verify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await mkdtemp(join(tmpdir(), "gamebuddy-voice-verify-input-"));
  t.after(() => rm(input, { recursive: true, force: true }));
  const entry = join(input, "entry"); const protocol = join(input, "protocol");
  await mkdir(entry); await mkdir(protocol);
  const entryBytes = Buffer.from("entry fixture\n"); const protocolBytes = Buffer.from("protocol fixture\n");
  await writeFile(join(entry, "voice-gateway-entry.mjs"), entryBytes);
  await writeFile(join(protocol, "voice-gateway-protocol.json"), protocolBytes);
  const { admission } = await publishVoiceGatewayFixture({
    stagingRoot: root,
    descriptor: { generation: "gen-verify", entry: { source: entry, destination: "voice-gateway/entry" }, protocol: { source: protocol, destination: "voice-gateway/protocol" } },
  });
  const verified = await verifyPublishedVoiceGateway({ artifactRoot: root, descriptor: { entry: { destination: "voice-gateway/entry" }, protocol: { destination: "voice-gateway/protocol" } } });
  assert.equal(verified.generation, "gen-verify");
  assert.equal(verified.entrySha256, testHash(entryBytes));
  assert.equal(verified.protocolSha256, testHash(protocolBytes));
  assert.equal(verified.inventoryDigest, admission.inventoryDigest);
  assert.deepEqual((await readdir(root)).sort(), ["voice-gateway", VOICE_GATEWAY_ADMISSION]);
});