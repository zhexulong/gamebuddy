import { closureOriginsFromInventory } from "./production-artifact-closure-staging.mjs";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { copyApprovedResources, readArtifactConfig, verifyArtifact, verifyWindowsReparseInspectorPair, verifyWindowsStaleLockReclaimerPair, verifyWindowsBootstrapGuardianPair, verifyWindowsStardewFolderPickerPair } from "./production-artifact.mjs";
import { publishVoiceGatewayFixture, verifyPublishedVoiceGateway } from "./voice-artifact-fixture-publisher.mjs";

const MARKER = "TEST_ONLY_NOT_A_PRODUCTION_ARTIFACT.txt";
const POINTER = "test-current.json";
const GENERATIONS = "test-generations";
const LOCK = ".test-publisher.lock";
const ADMISSION = "test-runtime-admission.json";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const inside = (root, path) => { const value = relative(root, path); return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value)); };
const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

async function regular(path, error) { const state = await lstat(path); if (state.isSymbolicLink() || !state.isFile()) throw new Error(error); return state; }
async function allFiles(root, prefix = "") { const result = []; for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) { const item = prefix ? `${prefix}/${entry.name}` : entry.name; if (entry.isDirectory()) result.push(...await allFiles(root, item)); else if (entry.isFile()) result.push(item); else throw new Error("test_artifact_nonregular_file"); } return result; }
async function acquireLock(root) { const path = resolve(root, LOCK); const deadline = Date.now() + 5_000; while (true) { try { const handle = await open(path, "wx", 0o600); return async () => { await handle.close(); await unlink(path); }; } catch (error) { if (error?.code !== "EEXIST") throw error; if (Date.now() >= deadline) throw new Error("test_artifact_publisher_lock_timeout"); await new Promise((done) => setTimeout(done, 50)); } } }
function testDescriptor(source) { return { runtimePath: "runtime/node.exe", bootstrapPath: "bootstrap/entry/desktop-host-entry.internal.js", nodeSha256: source.descriptor.nodeSha256 }; }
function testAdmission(inventory, generation, descriptor) { const runtime = inventory.entries.find((entry) => entry.path === descriptor.runtimePath); const bootstrap = inventory.entries.find((entry) => entry.path === descriptor.bootstrapPath); if (runtime === undefined || bootstrap === undefined) throw new Error("test_runtime_admission_required_entry_missing"); return `${JSON.stringify({ schema: "gamebuddy-host-test-runtime-admission/v1", inventoryDigest: inventory.digest, generation, runtimePath: descriptor.runtimePath, runtimeSha256: runtime.sha256, bootstrapPath: descriptor.bootstrapPath, bootstrapSha256: bootstrap.sha256 })}\n`; }
const windowsHelpers = [
  ["windowsReparseInspector", "native/windows-reparse-inspector/win-x64", verifyWindowsReparseInspectorPair, true],
  ["windowsStaleLockReclaimer", "native/windows-stale-lock-reclaimer/.dist/win-x64", verifyWindowsStaleLockReclaimerPair, false],
  ["windowsStardewFolderPicker", "native/windows-stardew-folder-picker/.dist/win-x64", verifyWindowsStardewFolderPickerPair, false],
  ["windowsBootstrapGuardian", "native/windows-bootstrap-guardian/.dist/win-x64", verifyWindowsBootstrapGuardianPair, false],
];

/**
 * Test-only stager with the production shape: the generation carries a closure
 * tree plus its own resolution manifest, so the closure is verified from the
 * artifact rather than from the repository. It copies the fixture's existing
 * dependencies instead of resolving a real 0.5 GB pnpm closure.
 */
export async function stageFixtureRuntimeClosure({ hostRoot, stagingRoot, externalRuntimeClosure }) {
  const packages = externalRuntimeClosure?.packages;
  if (!Array.isArray(packages) || packages.length === 0) throw new Error("fixture_closure_declaration_required");
  const origins = new Map();
  const origin = Object.freeze({ kind: "declared_external_runtime_closure", source: "host_production_dependency_closure" });
  const manifest = { name: "gamebuddy-host-generation", private: true, type: "module",
    dependencies: Object.fromEntries(packages.map((name) => [name, "*"])) };
  await writeFile(resolve(stagingRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  origins.set("package.json", origin);
  // The closure root exists even when nothing resolves into it. The verifier
  // must reach its own per-package diagnosis (`external_package_unresolvable`)
  // rather than failing on a missing directory.
  await mkdir(resolve(stagingRoot, "node_modules"), { recursive: true });
  for (const name of packages) {
    const source = resolve(hostRoot, "node_modules", ...name.split("/"));
    // Placement only, and only for a link-free package root: a package that is
    // absent, unusable, or reachable only through a link is left absent so the
    // verifier reports its own authoritative `external_package_unused` /
    // `external_package_unresolvable` outcome instead of a staging-time error or
    // a followed junction.
    if (!await linkFreePackageRoot(resolve(hostRoot, "node_modules"), name)) continue;
    const listed = await listRegularFiles(source);
    for (const item of listed) {
      if (/(?:^|\/)(?:[^/]*\.(?:test|test-support)(?:\.[^/]+)?|test-fixtures)(?:\/|$)/i.test(item)) continue;
      const destination = resolve(stagingRoot, "node_modules", ...name.split("/"), ...item.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(resolve(source, item), destination);
      origins.set(`node_modules/${name}/${item}`, origin);
    }
  }
  return origins;
}

/**
 * A declared package is stageable only when every path segment from the modules
 * root down to the package root is a real directory. An intermediate scoped
 * namespace can itself be a link, so checking only the final component would
 * follow a junction out of the host root and silently publish its contents.
 */
async function linkFreePackageRoot(modulesRoot, name) {
  let current = modulesRoot;
  for (const segment of name.split("/")) {
    current = resolve(current, segment);
    const state = await lstat(current).catch(() => null);
    if (state === null || state.isSymbolicLink() || !state.isDirectory()) return false;
  }
  return true;
}

/** List regular files without following links, so a linked subtree cannot be adopted. */
async function listRegularFiles(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const item = prefix ? `${prefix}/${entry.name}` : entry.name;
    const state = await lstat(resolve(root, item));
    if (state.isSymbolicLink()) continue;
    if (state.isDirectory()) result.push(...await listRegularFiles(root, item));
    else if (state.isFile()) result.push(item);
  }
  return result.sort();
}

async function copyConfiguredWindowsHelpers({ hostRoot, stagingRoot, config, origins }) {
  if (process.platform !== "win32") return;
  for (const [configKey, sourcePath, verify, hasAudit] of windowsHelpers) {
    const descriptor = config[configKey];
    if (descriptor === undefined) continue;
    const sourceRoot = resolve(hostRoot, sourcePath);
    const sourceDescriptor = configKey === "windowsReparseInspector"
      ? descriptor
      : { ...descriptor, destination: configKey === "windowsBootstrapGuardian" ? "." : "win-x64" };
    const source = await verify({ root: configKey === "windowsReparseInspector" ? hostRoot : (configKey === "windowsBootstrapGuardian" ? sourceRoot : resolve(sourceRoot, "..")), descriptor: sourceDescriptor });
    const destinationRoot = resolve(stagingRoot, descriptor.destination);
    for (const name of [descriptor.helper, descriptor.manifest]) {
      const destination = resolve(destinationRoot, name);
      try { await regular(destination, "test_windows_helper_destination"); }
      catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(resolve(source.pairRoot, name), destination);
      }
    }
    const verified = await verify({ root: stagingRoot, descriptor });
    const origin = { kind: descriptor.kind, destination: descriptor.destination, helper: descriptor.helper, manifest: descriptor.manifest, helperSha256: verified.helperSha256 };
    origins.set(`${descriptor.destination}/${descriptor.helper}`, origin);
    origins.set(`${descriptor.destination}/${descriptor.manifest}`, origin);
    if (hasAudit) {
      const audit = resolve(verified.pairRoot, descriptor.probeEvidence);
      try { await regular(audit, "test_windows_reparse_audit"); origins.set(`${descriptor.destination}/${descriptor.probeEvidence}`, { kind: "passive_windows_reparse_live_gate_audit", destination: descriptor.destination, audit: descriptor.probeEvidence }); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
  }
}

async function copyRuntime(stagingRoot, source, origins) { const sourceRoot = resolve(source.extractedRoot, source.descriptor.archiveRoot); for (const item of await allFiles(sourceRoot)) { const destinationPath = item === "node.exe" ? "runtime/node.exe" : `runtime/${item}`; const from = resolve(sourceRoot, item); const to = resolve(stagingRoot, destinationPath); await regular(from, "test_runtime_source_invalid"); await mkdir(dirname(to), { recursive: true }); await copyFile(from, to); await regular(to, "test_runtime_copy_invalid"); origins.set(destinationPath, { kind: "test_runtime", source: item, destination: destinationPath }); } }
function testConfig(config, descriptor) { return { ...config, bundledRuntime: descriptor }; }

export async function publishTestArtifact({ hostRoot, emittedRoot, outputRoot, runtimeSource }) {
  if (runtimeSource === null || typeof runtimeSource !== "object") throw new Error("test_runtime_source_required");
  const config = testConfig(await readArtifactConfig(hostRoot), testDescriptor(runtimeSource));
  const generation = `tg-${Date.now().toString(36)}-${randomUUID().replaceAll("-", "")}`;
  await mkdir(outputRoot, { recursive: true });
  const release = await acquireLock(outputRoot);
  const staging = resolve(outputRoot, GENERATIONS, `.staging-${generation}`); const finalRoot = resolve(outputRoot, GENERATIONS, generation); const stagedPointer = resolve(outputRoot, `.test-current-${generation}.json`);
  try {
    const rootEntries = await readdir(outputRoot);
    if (rootEntries.some((entry) => ![MARKER, POINTER, GENERATIONS, LOCK].includes(entry))) throw new Error("test_artifact_output_root_invalid");
    await writeFile(resolve(outputRoot, MARKER), "This directory contains test-only artifacts and is not a production artifact.\n", { flag: rootEntries.includes(MARKER) ? "w" : "wx" });
    await mkdir(resolve(outputRoot, GENERATIONS), { recursive: true }); await mkdir(staging);
    // Serialize the entire candidate transaction. A competing fixture helper may
    // reuse its emitted directory, so snapshot it only after lock acquisition.
    for (const item of await allFiles(emittedRoot)) {
      if (config.browserArtifact === undefined && item.startsWith("browser/")) continue;
      if (windowsHelpers.some(([configKey, destination]) => config[configKey] === undefined && item.startsWith(`${destination.split("/.dist")[0]}/`))) continue;
      const from = resolve(emittedRoot, item); const to = resolve(staging, item); await regular(from, "test_emitted_source_invalid"); await mkdir(dirname(to), { recursive: true }); await copyFile(from, to);
    }
    const origins = await copyApprovedResources({ hostRoot, stagingRoot: staging, config });
    await copyRuntime(staging, runtimeSource, origins);
    // The fixture stager reproduces the production shape: the generation owns its
    // closure tree and resolves it in place, so tests cannot pass via the
    // repository's node_modules.
    for (const [path, origin] of await stageFixtureRuntimeClosure({ hostRoot, stagingRoot: staging, externalRuntimeClosure: config.externalRuntimeClosure })) origins.set(path, origin);
    await copyConfiguredWindowsHelpers({ hostRoot, stagingRoot: staging, config, origins });
    if (config.voiceGateway !== undefined) {
      await publishVoiceGatewayFixture({
        stagingRoot: staging,
        descriptor: {
          generation,
          entry: { source: resolve(hostRoot, "voice-gateway", ".dist", "entry"), destination: config.voiceGateway.entry.destination },
          protocol: { source: resolve(hostRoot, "voice-gateway", ".dist", "protocol"), destination: config.voiceGateway.protocol.destination },
        },
      });
      const verified = await verifyPublishedVoiceGateway({ artifactRoot: staging, descriptor: config.voiceGateway });
      const origin = { kind: config.voiceGateway.kind, entryPath: verified.entryPath, entrySha256: verified.entrySha256, protocolPath: verified.protocolPath, protocolSha256: verified.protocolSha256 };
      origins.set(verified.entryPath, origin);
      origins.set(verified.protocolPath, origin);
    }
    const inventory = await verifyArtifact({ artifactRoot: staging, hostRoot, config, origins, closureHostRoot: staging });
    await writeFile(resolve(staging, "production-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
    await verifyArtifact({ artifactRoot: staging, hostRoot, config, origins, expectedInventory: inventory, closureHostRoot: staging });
    if (config.voiceGateway !== undefined) {
      // Rewrite the voiced sidecar to the full-inventory digest exactly like
      // the production publisher's emitVoiceGatewayAdmission: the staged sidecar
      // carries the voice-pair digest until the generation inventory exists.
      const sidecarPath = resolve(staging, "voice-gateway-admission.json");
      const staged = JSON.parse(await readFile(sidecarPath, "utf8"));
      if (!staged || typeof staged !== "object" || Array.isArray(staged)
        || staged.schema !== "gamebuddy-host-voice-gateway-admission/v1"
        || !/^[a-f0-9]{64}$/.test(staged.inventoryDigest)) throw new Error("voice_gateway_admission_invalid");
      await writeFile(sidecarPath, `${JSON.stringify({ ...staged, inventoryDigest: inventory.digest })}\n`);
      await verifyPublishedVoiceGateway({ artifactRoot: staging, descriptor: config.voiceGateway, expectedInventoryDigest: inventory.digest });
    }
    if (process.platform === "win32" && config.windowsBootstrapGuardian !== undefined) {
      const verified = await verifyWindowsBootstrapGuardianPair({ root: staging, descriptor: config.windowsBootstrapGuardian });
      const manifestSha256 = digest(await readFile(verified.manifest));
      await writeFile(resolve(staging, "guardian-admission.json"), `${JSON.stringify({ schema: "gamebuddy-host-guardian-admission/v1", inventoryDigest: inventory.digest, helperPath: `${config.windowsBootstrapGuardian.destination}/${config.windowsBootstrapGuardian.helper}`, manifestPath: `${config.windowsBootstrapGuardian.destination}/${config.windowsBootstrapGuardian.manifest}`, helperSha256: verified.helperSha256, manifestSha256, manifestSchemaVersion: 1, manifestProtocolVersion: 1, manifestRid: "win-x64", manifestHelperFileName: config.windowsBootstrapGuardian.helper })}\n`, { flag: "wx" });
    }
    const admission = testAdmission(inventory, generation, config.bundledRuntime);
    await writeFile(resolve(staging, ADMISSION), admission, { flag: "wx" });
    await rename(staging, finalRoot);
    const admissionSha256 = digest(await readFile(resolve(finalRoot, ADMISSION)));
    await writeFile(stagedPointer, `${JSON.stringify({ schema: "gamebuddy-host-test-current/v1", generation, inventoryDigest: inventory.digest, testRuntimeAdmissionSha256: admissionSha256 })}\n`);
    await rename(stagedPointer, resolve(outputRoot, POINTER));
    return { ...inventory, generation };
  } catch (error) { await rm(staging, { recursive: true, force: true }); await rm(stagedPointer, { force: true }); throw error; } finally { await release(); }
}

async function selectedTestArtifact({ hostRoot, outputRoot }) {
  const entries = await readdir(outputRoot); if (!entries.includes(MARKER) || entries.some((entry) => ![MARKER, POINTER, GENERATIONS, LOCK].includes(entry))) throw new Error("test_artifact_layout_invalid");
  const pointer = JSON.parse(await readFile(resolve(outputRoot, POINTER), "utf8"));
  if (!exactKeys(pointer, ["schema", "generation", "inventoryDigest", "testRuntimeAdmissionSha256"]) || pointer.schema !== "gamebuddy-host-test-current/v1" || !/^tg-[a-z0-9-]+$/i.test(pointer.generation) || !/^[a-f0-9]{64}$/.test(pointer.inventoryDigest) || !/^[a-f0-9]{64}$/.test(pointer.testRuntimeAdmissionSha256)) throw new Error("invalid_test_current_pointer");
  const artifactRoot = resolve(outputRoot, GENERATIONS, pointer.generation); if (!inside(resolve(outputRoot, GENERATIONS), artifactRoot)) throw new Error("invalid_test_generation");
  const state = await lstat(artifactRoot); if (state.isSymbolicLink() || !state.isDirectory()) throw new Error("invalid_test_generation");
  const config = testConfig(await readArtifactConfig(hostRoot), { runtimePath: "runtime/node.exe", bootstrapPath: "bootstrap/entry/desktop-host-entry.internal.js" });
  const manifest = JSON.parse(await readFile(resolve(artifactRoot, "production-inventory.json"), "utf8"));
  const origins = new Map(config.resources.map((resource) => [resource.destination, { kind: "allowlisted_resource", source: resource.source, destination: resource.destination, config: "production-artifact.config.json" }]));
  if (process.platform === "win32") {
    for (const [configKey, , verify, hasAudit] of windowsHelpers) {
      const descriptor = config[configKey];
      if (descriptor === undefined) continue;
      const verified = await verify({ root: artifactRoot, descriptor });
      const origin = { kind: descriptor.kind, destination: descriptor.destination, helper: descriptor.helper, manifest: descriptor.manifest, helperSha256: verified.helperSha256 };
      origins.set(`${descriptor.destination}/${descriptor.helper}`, origin);
      origins.set(`${descriptor.destination}/${descriptor.manifest}`, origin);
      if (hasAudit) {
        const audit = resolve(verified.pairRoot, descriptor.probeEvidence);
        try { await regular(audit, "test_windows_reparse_audit"); origins.set(`${descriptor.destination}/${descriptor.probeEvidence}`, { kind: "passive_windows_reparse_live_gate_audit", destination: descriptor.destination, audit: descriptor.probeEvidence }); }
        catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
    }
  }
  if (config.voiceGateway !== undefined) {
    const verified = await verifyPublishedVoiceGateway({ artifactRoot, descriptor: config.voiceGateway, expectedInventoryDigest: manifest.digest });
    const origin = { kind: config.voiceGateway.kind, entryPath: verified.entryPath, entrySha256: verified.entrySha256, protocolPath: verified.protocolPath, protocolSha256: verified.protocolSha256 };
    origins.set(verified.entryPath, origin);
    origins.set(verified.protocolPath, origin);
  }
  const sidecar = resolve(artifactRoot, ADMISSION); const sidecarHold = resolve(outputRoot, `.verified-${pointer.generation}-${ADMISSION}`);
  await rename(sidecar, sidecarHold);
  for (const entry of manifest.entries) if (entry.origin?.kind === "test_runtime") origins.set(entry.path, entry.origin);
  // The recheck must verify the same closure claim the publisher recorded, and
  // resolve it from the generation itself rather than from the repository.
  for (const [path, origin] of closureOriginsFromInventory(manifest.entries)) origins.set(path, origin);
  let inventory; try { inventory = await verifyArtifact({ artifactRoot, hostRoot, config, origins, expectedInventory: manifest, closureHostRoot: artifactRoot }); } finally { await rename(sidecarHold, sidecar); }
  const admission = await readFile(sidecar); if (digest(admission) !== pointer.testRuntimeAdmissionSha256 || admission.toString("utf8") !== testAdmission(inventory, pointer.generation, config.bundledRuntime)) throw new Error("test_runtime_admission_invalid");
  if (inventory.digest !== pointer.inventoryDigest) throw new Error("test_current_pointer_inventory_mismatch");
  return { ...inventory, generation: pointer.generation, artifactRoot };
}
export async function assertCompleteTestArtifact(options) { return selectedTestArtifact(options); }
export async function resolveTestArtifactEntry({ hostRoot, outputRoot, entry }) { if (typeof entry !== "string" || !/^[A-Za-z0-9._-]+\.js$/.test(entry)) throw new Error("test_entry_not_configured"); const config = await readArtifactConfig(hostRoot); if (!config.entryRoots.includes(entry)) throw new Error("test_entry_not_configured"); const selected = await selectedTestArtifact({ hostRoot, outputRoot }); const entryPath = resolve(selected.artifactRoot, entry); if (!inside(selected.artifactRoot, entryPath)) throw new Error("test_entry_not_configured"); await regular(entryPath, "test_entry_missing"); return { ...selected, entryPath, artifactKind: "test" }; }
export async function recheckTestArtifactEntry({ hostRoot, selected }) { const rechecked = await selectedTestArtifact({ hostRoot, outputRoot: resolve(selected.artifactRoot, "..", "..") }); if (rechecked.generation !== selected.generation || rechecked.digest !== selected.digest) throw new Error("test_selected_generation_integrity_mismatch"); await regular(selected.entryPath, "test_entry_missing"); return selected; }
export async function resolveTestArtifactModule({ selected, module }) { if (typeof module !== "string" || !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.js$/.test(module)) throw new Error("test_module_not_configured"); const modulePath = resolve(selected.artifactRoot, module); if (!inside(selected.artifactRoot, modulePath)) throw new Error("test_module_escapes_generation"); const entry = selected.entries.find((value) => value.path === module); if (entry?.type !== "file" || digest(await readFile(modulePath)) !== entry.sha256) throw new Error("test_module_integrity_mismatch"); return { ...selected, module, modulePath }; }
