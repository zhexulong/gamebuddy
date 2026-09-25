import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { buildWindowsBootstrapGuardian } from "./build-windows-bootstrap-guardian.mjs";
import { buildFixedReleaseProductionArtifactForTest } from "./build-production-artifact.mjs";
import { withSyntheticVerifiedReleaseBundledRuntimeFixedReleaseCompositionForTest } from "./node-runtime-release-acquisition.mjs";

const outputRoot = process.argv[2];
const fixtureRuntimeRoot = process.argv[3];
if (typeof outputRoot !== "string" || outputRoot.length === 0 || typeof fixtureRuntimeRoot !== "string" || fixtureRuntimeRoot.length === 0) {
  throw new Error("desktop_launcher_test_generation_output_and_fixture_runtime_required");
}

const hash = (value) => createHash("sha256").update(value).digest("hex");

/** True when `root` contains a regular file with this exact name. */
async function directoryHasEntry(root, name) {
  try {
    return (await stat(resolve(root, name))).isFile();
  } catch {
    return false;
  }
}
const u16 = (value) => { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value); return bytes; };
const u32 = (value) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };

// The test-only runtime is the published exact-child fixture, never a repository or system Node runtime.
//
// The fixture must be a self-contained single-file native image: the generation
// carries exactly one runtime executable (`runtime/node.exe`), and the admission
// sidecar hashes that one file. A framework-dependent apphost would need the
// sibling managed closure (`node.dll`, `node.runtimeconfig.json`, hostfxr and the
// framework libraries) beside it, which the single-executable generation contract
// cannot represent — the child would exit before the bootstrap pipe ever
// connected, and the supervisor would report an opaque bootstrap timeout.
//
// That fallback happens silently when the AOT toolchain is absent: `PublishAot`
// needs the MSVC linker (`link.exe`), so a machine without the Visual Studio C++
// build tools produces an apphost plus `node.dll` instead of a self-contained
// executable. Refuse it here, by name, so the cause is the message.
async function syntheticRuntimeFixture(root) {
  const nodePath = resolve(root, "node.exe");
  if (!(await directoryHasEntry(root, "node.exe"))) throw new Error("desktop_launcher_test_fixture_node_missing");
  if (await directoryHasEntry(root, "node.dll"))
    throw new Error(
      "desktop_launcher_test_fixture_not_self_contained: the exact-child fixture was published as a framework-dependent apphost " +
        "(node.dll is present beside node.exe). Publish it with the MSVC linker available (PublishAot=true, SelfContained=true) so it " +
        "produces one self-contained executable; the generation carries only runtime/node.exe.",
    );
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
await buildWindowsBootstrapGuardian();
const runtime = await syntheticRuntimeFixture(resolve(fixtureRuntimeRoot));
await withSyntheticVerifiedReleaseBundledRuntimeFixedReleaseCompositionForTest(
  runtime,
  async () => await buildFixedReleaseProductionArtifactForTest({ outputRoot: canonicalOutputRoot }),
);
