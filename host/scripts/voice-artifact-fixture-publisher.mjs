import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";

const SCHEMA = "gamebuddy-host-voice-gateway-admission/v1";
export const VOICE_GATEWAY_ADMISSION = "voice-gateway-admission.json";
const SAFE = /^(?![\\/])(?![A-Za-z]:)(?!.*(?:^|[\\/])\.\.?([\\/]|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** Canonical voice inventory digest: one entry record then one protocol
 * record, each with its exact single file. Both publication and verification
 * derive it from the same pure function so the binding cannot drift. */
const voiceInventoryDigest = (entryFile, protocolFile) => sha256(JSON.stringify([
  { label: "entry", files: [entryFile] },
  { label: "protocol", files: [protocolFile] },
]));
const slash = (value) => value.replaceAll("\\", "/");
const contained = (root, value) => { const r = relative(root, value); return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !r.startsWith(sep)); };

async function regularTree(root, label) {
  const result = [];
  async function visit(dir) {
    for (const name of await readdir(dir)) {
      const path = resolve(dir, name); const stat = await lstat(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`voice_fixture_${label}_unsafe_path`);
      if (stat.isDirectory()) await visit(path);
      else result.push(path);
    }
  }
  const stat = await lstat(root).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`voice_fixture_${label}_missing`);
  if (stat.isDirectory()) await visit(root); else result.push(root);
  return result;
}

function validateRelative(value, label) {
  if (typeof value !== "string" || !SAFE.test(value)) throw new Error(`voice_fixture_${label}_unsafe_path`);
  return value;
}

/** Voice Gateway artifact staging seam, shared by the fixture tests and the
 * production artifact publisher. `publishVoiceGatewayFixture` copies one
 * entry file and one protocol file into a staging root, rejects symlink,
 * traversal, special and multi-file inputs, and binds both files into a
 * voice-gateway-admission.json sidecar. `verifyPublishedVoiceGateway`
 * rechecks a staged or published copy read-only. */
export async function publishVoiceGatewayFixture({ stagingRoot, descriptor }) {
  if (descriptor === undefined) return undefined;
  if (!descriptor || typeof descriptor !== "object") throw new Error("voice_fixture_descriptor_invalid");
  const generation = typeof descriptor.generation === "string" && descriptor.generation.length > 0 ? descriptor.generation : "fixture-generation";
  const entry = descriptor.entry; const protocol = descriptor.protocol;
  if (!entry || !protocol) throw new Error("voice_fixture_entry_protocol_required");
  const pairs = [[entry, "entry"], [protocol, "protocol"]];
  const records = [];
  for (const [pair, label] of pairs) {
    if (!pair || typeof pair !== "object") throw new Error(`voice_fixture_${label}_invalid`);
    const source = resolve(String(pair.source ?? ""));
    const destination = validateRelative(pair.destination, `${label}_destination`);
    if (!contained(resolve(stagingRoot), resolve(stagingRoot, destination))) throw new Error(`voice_fixture_${label}_unsafe_path`);
    const sourceFiles = await regularTree(source, label);
    const target = resolve(stagingRoot, destination); await mkdir(target, { recursive: true });
    await cp(source, target, { recursive: true, errorOnExist: false, force: true, dereference: false });
    const copiedFiles = await regularTree(target, label);
    if (copiedFiles.length !== sourceFiles.length) throw new Error(`voice_fixture_${label}_copy_mismatch`);
    const rootFiles = [];
    for (const path of copiedFiles.sort()) rootFiles.push({ path: slash(relative(resolve(stagingRoot), path)), sha256: sha256(await readFile(path)) });
    const rootDigest = sha256(JSON.stringify(rootFiles));
    records.push({ label, destination, files: rootFiles, digest: rootDigest });
  }
  const entryFile = records[0].files.length === 1 ? records[0].files[0] : undefined;
  const protocolFile = records[1].files.length === 1 ? records[1].files[0] : undefined;
  if (!entryFile || !protocolFile) throw new Error("voice_fixture_entry_protocol_must_be_single_files");
  const inventoryDigest = voiceInventoryDigest(entryFile, protocolFile);
  const sidecar = {
    schema: SCHEMA, generation, inventoryDigest,
    entryPath: entryFile.path, entrySha256: entryFile.sha256,
    protocolPath: protocolFile.path, protocolSha256: protocolFile.sha256,
    nodeVersion: "v24.20.0", platform: "win32", arch: "x64",
  };
  const sidecarPath = resolve(stagingRoot, VOICE_GATEWAY_ADMISSION);
  await writeFile(sidecarPath, `${JSON.stringify(sidecar)}\n`, "utf8");
  const parsed = JSON.parse(await readFile(sidecarPath, "utf8"));
  if (parsed.schema !== SCHEMA || !SAFE.test(parsed.entryPath) || !SAFE.test(parsed.protocolPath)
    || !/^[a-f0-9]{64}$/.test(parsed.inventoryDigest) || !/^[a-f0-9]{64}$/.test(parsed.entrySha256)
    || !/^[a-f0-9]{64}$/.test(parsed.protocolSha256)
    || parsed.inventoryDigest !== inventoryDigest || parsed.entrySha256 !== entryFile.sha256 || parsed.protocolSha256 !== protocolFile.sha256) throw new Error("voice_fixture_inventory_binding_failed");
  return { sidecarPath, admission: parsed, inventoryDigest, records };
}

/** Read-only verification of a staged or published voice gateway admission.
 * Re-checks the sidecar shape, path safety, single-file destinations, exact
 * file digests and the canonical voice inventory binding without copying or
 * mutating anything. When `descriptor` is supplied its entry/protocol
 * destinations must each contain exactly the bound single file. */
export async function verifyPublishedVoiceGateway({ artifactRoot, descriptor }) {
  const root = resolve(artifactRoot);
  const sidecarPath = resolve(root, VOICE_GATEWAY_ADMISSION);
  let sidecarState;
  try { sidecarState = await lstat(sidecarPath); } catch { throw new Error("voice_gateway_admission_missing"); }
  if (sidecarState.isSymbolicLink() || !sidecarState.isFile()) throw new Error("voice_gateway_admission_invalid");
  let admission;
  try { admission = JSON.parse(await readFile(sidecarPath, "utf8")); } catch { throw new Error("voice_gateway_admission_invalid"); }
  if (admission === null || typeof admission !== "object" || Array.isArray(admission)
    || admission.schema !== SCHEMA || typeof admission.generation !== "string" || admission.generation.length === 0
    || !SAFE.test(admission.entryPath) || !SAFE.test(admission.protocolPath)
    || !/^[a-f0-9]{64}$/.test(admission.inventoryDigest)
    || !/^[a-f0-9]{64}$/.test(admission.entrySha256) || !/^[a-f0-9]{64}$/.test(admission.protocolSha256))
    throw new Error("voice_gateway_admission_invalid");
  const files = [];
  for (const [declaredPath, label, declaredSha256] of [
    [admission.entryPath, "entry", admission.entrySha256],
    [admission.protocolPath, "protocol", admission.protocolSha256],
  ]) {
    const absolute = resolve(root, declaredPath);
    if (!contained(root, absolute) || absolute === root) throw new Error(`voice_gateway_${label}_unsafe_path`);
    const state = await lstat(absolute).catch(() => undefined);
    if (!state || state.isSymbolicLink() || !state.isFile()) throw new Error(`voice_gateway_${label}_missing`);
    const actualPath = slash(relative(root, absolute));
    if (actualPath !== declaredPath) throw new Error(`voice_gateway_${label}_path_mismatch`);
    const actualSha256 = sha256(await readFile(absolute));
    if (actualSha256 !== declaredSha256) throw new Error(`voice_gateway_${label}_mismatch`);
    files.push({ path: declaredPath, sha256: actualSha256 });
  }
  if (descriptor !== undefined) {
    for (const [side, destination, file] of [
      ["entry", descriptor.entry?.destination, files[0]],
      ["protocol", descriptor.protocol?.destination, files[1]],
    ]) {
      if (typeof destination !== "string" || !SAFE.test(destination)) throw new Error(`voice_gateway_${side}_destination_invalid`);
      const dir = resolve(root, destination);
      if (!contained(root, dir) || dir === root) throw new Error(`voice_gateway_${side}_unsafe_path`);
      const dirState = await lstat(dir).catch(() => undefined);
      if (!dirState || dirState.isSymbolicLink() || !dirState.isDirectory()) throw new Error(`voice_gateway_${side}_destination_missing`);
      const names = await readdir(dir);
      if (names.length !== 1 || names[0] !== basename(file.path)) throw new Error(`voice_gateway_${side}_must_be_single_files`);
    }
  }
  if (admission.inventoryDigest !== voiceInventoryDigest(files[0], files[1]))
    throw new Error("voice_gateway_inventory_binding_failed");
  return Object.freeze({
    generation: admission.generation,
    inventoryDigest: admission.inventoryDigest,
    entryPath: admission.entryPath,
    entrySha256: admission.entrySha256,
    protocolPath: admission.protocolPath,
    protocolSha256: admission.protocolSha256,
  });
}
