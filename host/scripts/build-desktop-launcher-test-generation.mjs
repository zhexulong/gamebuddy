import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readdir, readFile, rm } from "node:fs/promises";
import { buildWindowsStardewBootstrapGuardian } from "./build-windows-stardew-bootstrap-guardian.mjs";
import { buildFixedReleaseProductionArtifactForTest } from "./build-production-artifact.mjs";
import { withSyntheticVerifiedReleaseBundledRuntimeFixedReleaseCompositionForTest } from "./node-runtime-release-acquisition.mjs";

const outputRoot = process.argv[2];
const fixtureRuntimeRoot = process.argv[3];
if (typeof outputRoot !== "string" || outputRoot.length === 0 || typeof fixtureRuntimeRoot !== "string" || fixtureRuntimeRoot.length === 0) {
  throw new Error("desktop_launcher_test_generation_output_and_fixture_runtime_required");
}

const hash = (value) => createHash("sha256").update(value).digest("hex");
const u16 = (value) => { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value); return bytes; };
const u32 = (value) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };

// The test-only runtime is the published exact-child fixture, never a repository or system Node runtime.
async function syntheticRuntimeFixture(root) {
  const nodePath = resolve(root, "node.exe");
  const entries = [{ name: "node.exe", bytes: await readFile(nodePath) }];
  const node = entries.find((entry) => entry.name === "node.exe")?.bytes;
  if (node === undefined) throw new Error("desktop_launcher_test_fixture_node_missing");
  const archiveRoot = "node-v24.20.0-win-x64";
  let offset = 0;
  const locals = [];
  const centralEntries = [];
  for (const entry of entries) {
    const name = Buffer.from(`${archiveRoot}/${entry.name}`);
    const local = Buffer.concat([Buffer.from("504b0304", "hex"), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0), u32(entry.bytes.length), u32(entry.bytes.length), u16(name.length), u16(0), name, entry.bytes]);
    locals.push(local);
    centralEntries.push(Buffer.concat([Buffer.from("504b0102", "hex"), u16(0), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0), u32(entry.bytes.length), u32(entry.bytes.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += local.length;
  }
  const central = Buffer.concat(centralEntries);
  const zipBytes = Buffer.concat([...locals, central, Buffer.from("504b0506", "hex"), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(central.length), u32(offset), u16(0)]);
  return Object.freeze({
    zipBytes,
    descriptor: Object.freeze({
      sourceUrl: "https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip",
      archiveSha256: hash(zipBytes),
      archiveRoot,
      nodeSha256: hash(node),
    }),
  });
}

const canonicalOutputRoot = resolve(outputRoot);
await rm(canonicalOutputRoot, { recursive: true, force: true });
await buildWindowsStardewBootstrapGuardian();
const runtime = await syntheticRuntimeFixture(resolve(fixtureRuntimeRoot));
await withSyntheticVerifiedReleaseBundledRuntimeFixedReleaseCompositionForTest(
  runtime,
  async () => await buildFixedReleaseProductionArtifactForTest({ outputRoot: canonicalOutputRoot }),
);
