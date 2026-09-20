import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";

const SCHEMA = "gamebuddy-host-voice-gateway-admission/v1";
const SAFE = /^(?![\\/])(?![A-Za-z]:)(?!.*(?:^|[\\/])\.\.?([\\/]|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
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

/** Fixture-only publisher seam. It is intentionally not referenced by the release publisher. */
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
  const inventoryDigest = sha256(JSON.stringify(records.map(({ label, files }) => ({ label, files }))));
  const sidecar = {
    schema: SCHEMA, generation, inventoryDigest,
    entryPath: entryFile.path, entrySha256: entryFile.sha256,
    protocolPath: protocolFile.path, protocolSha256: protocolFile.sha256,
    nodeVersion: "v24.20.0", platform: "win32", arch: "x64",
  };
  const sidecarPath = resolve(stagingRoot, "voice-gateway-admission.json");
  await writeFile(sidecarPath, `${JSON.stringify(sidecar)}\n`, "utf8");
  const parsed = JSON.parse(await readFile(sidecarPath, "utf8"));
  if (parsed.schema !== SCHEMA || !SAFE.test(parsed.entryPath) || !SAFE.test(parsed.protocolPath)
    || !/^[a-f0-9]{64}$/.test(parsed.inventoryDigest) || !/^[a-f0-9]{64}$/.test(parsed.entrySha256)
    || !/^[a-f0-9]{64}$/.test(parsed.protocolSha256)
    || parsed.inventoryDigest !== inventoryDigest || parsed.entrySha256 !== entryFile.sha256 || parsed.protocolSha256 !== protocolFile.sha256) throw new Error("voice_fixture_inventory_binding_failed");
  return { sidecarPath, admission: parsed, inventoryDigest, records };
}
