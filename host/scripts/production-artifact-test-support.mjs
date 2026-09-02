import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { copyApprovedResources, readArtifactConfig, verifyArtifact, verifyWindowsReparseInspectorPair, verifyWindowsStaleLockReclaimerPair, verifyWindowsStardewBootstrapGuardianPair, verifyWindowsStardewFolderPickerPair } from "./production-artifact.mjs";

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
function testDescriptor(source) { return { runtimePath: "runtime/node.exe", bootstrapPath: "desktop-runtime-bootstrap.internal.js", nodeSha256: source.descriptor.nodeSha256 }; }
function testAdmission(inventory, generation, descriptor) { const runtime = inventory.entries.find((entry) => entry.path === descriptor.runtimePath); const bootstrap = inventory.entries.find((entry) => entry.path === descriptor.bootstrapPath); if (runtime === undefined || bootstrap === undefined) throw new Error("test_runtime_admission_required_entry_missing"); return `${JSON.stringify({ schema: "gamebuddy-host-test-runtime-admission/v1", inventoryDigest: inventory.digest, generation, runtimePath: descriptor.runtimePath, runtimeSha256: runtime.sha256, bootstrapPath: descriptor.bootstrapPath, bootstrapSha256: bootstrap.sha256 })}\n`; }
const windowsHelpers = [
  ["windowsReparseInspector", "native/windows-reparse-inspector/win-x64", verifyWindowsReparseInspectorPair, true],
  ["windowsStaleLockReclaimer", "native/windows-stale-lock-reclaimer/.dist/win-x64", verifyWindowsStaleLockReclaimerPair, false],
  ["windowsStardewFolderPicker", "native/windows-stardew-folder-picker/.dist/win-x64", verifyWindowsStardewFolderPickerPair, false],
  ["windowsStardewBootstrapGuardian", "native/windows-stardew-bootstrap-guardian/.dist/win-x64", verifyWindowsStardewBootstrapGuardianPair, false],
];

async function copyConfiguredWindowsHelpers({ hostRoot, stagingRoot, config, origins }) {
  if (process.platform !== "win32") return;
  for (const [configKey, sourcePath, verify, hasAudit] of windowsHelpers) {
    const descriptor = config[configKey];
    if (descriptor === undefined) continue;
    const sourceRoot = resolve(hostRoot, sourcePath);
    const sourceDescriptor = configKey === "windowsReparseInspector"
      ? descriptor
      : { ...descriptor, destination: configKey === "windowsStardewBootstrapGuardian" ? "." : "win-x64" };
    const source = await verify({ root: configKey === "windowsReparseInspector" ? hostRoot : (configKey === "windowsStardewBootstrapGuardian" ? sourceRoot : resolve(sourceRoot, "..")), descriptor: sourceDescriptor });
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
    await copyConfiguredWindowsHelpers({ hostRoot, stagingRoot: staging, config, origins });
    const inventory = await verifyArtifact({ artifactRoot: staging, hostRoot, config, origins });
    await writeFile(resolve(staging, "production-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
    await verifyArtifact({ artifactRoot: staging, hostRoot, config, origins, expectedInventory: inventory });
    if (process.platform === "win32" && config.windowsStardewBootstrapGuardian !== undefined) {
      const verified = await verifyWindowsStardewBootstrapGuardianPair({ root: staging, descriptor: config.windowsStardewBootstrapGuardian });
      const manifestSha256 = digest(await readFile(verified.manifest));
      await writeFile(resolve(staging, "guardian-admission.json"), `${JSON.stringify({ schema: "gamebuddy-host-guardian-admission/v1", inventoryDigest: inventory.digest, helperPath: `${config.windowsStardewBootstrapGuardian.destination}/${config.windowsStardewBootstrapGuardian.helper}`, manifestPath: `${config.windowsStardewBootstrapGuardian.destination}/${config.windowsStardewBootstrapGuardian.manifest}`, helperSha256: verified.helperSha256, manifestSha256, manifestSchemaVersion: 1, manifestProtocolVersion: 1, manifestRid: "win-x64", manifestHelperFileName: config.windowsStardewBootstrapGuardian.helper })}\n`, { flag: "wx" });
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
  const config = testConfig(await readArtifactConfig(hostRoot), { runtimePath: "runtime/node.exe", bootstrapPath: "desktop-runtime-bootstrap.internal.js" });
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
  const sidecar = resolve(artifactRoot, ADMISSION); const sidecarHold = resolve(outputRoot, `.verified-${pointer.generation}-${ADMISSION}`);
  await rename(sidecar, sidecarHold);
  for (const entry of manifest.entries) if (entry.origin?.kind === "test_runtime") origins.set(entry.path, entry.origin);
  let inventory; try { inventory = await verifyArtifact({ artifactRoot, hostRoot, config, origins, expectedInventory: manifest }); } finally { await rename(sidecarHold, sidecar); }
  const admission = await readFile(sidecar); if (digest(admission) !== pointer.testRuntimeAdmissionSha256 || admission.toString("utf8") !== testAdmission(inventory, pointer.generation, config.bundledRuntime)) throw new Error("test_runtime_admission_invalid");
  if (inventory.digest !== pointer.inventoryDigest) throw new Error("test_current_pointer_inventory_mismatch");
  return { ...inventory, generation: pointer.generation, artifactRoot };
}
export async function assertCompleteTestArtifact(options) { return selectedTestArtifact(options); }
export async function resolveTestArtifactEntry({ hostRoot, outputRoot, entry }) { if (typeof entry !== "string" || !/^[A-Za-z0-9._-]+\.js$/.test(entry)) throw new Error("test_entry_not_configured"); const config = await readArtifactConfig(hostRoot); if (!config.entryRoots.includes(entry)) throw new Error("test_entry_not_configured"); const selected = await selectedTestArtifact({ hostRoot, outputRoot }); const entryPath = resolve(selected.artifactRoot, entry); if (!inside(selected.artifactRoot, entryPath)) throw new Error("test_entry_not_configured"); await regular(entryPath, "test_entry_missing"); return { ...selected, entryPath, artifactKind: "test" }; }
export async function recheckTestArtifactEntry({ hostRoot, selected }) { const rechecked = await selectedTestArtifact({ hostRoot, outputRoot: resolve(selected.artifactRoot, "..", "..") }); if (rechecked.generation !== selected.generation || rechecked.digest !== selected.digest) throw new Error("test_selected_generation_integrity_mismatch"); await regular(selected.entryPath, "test_entry_missing"); return selected; }
export async function resolveTestArtifactModule({ selected, module }) { if (typeof module !== "string" || !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.js$/.test(module)) throw new Error("test_module_not_configured"); const modulePath = resolve(selected.artifactRoot, module); if (!inside(selected.artifactRoot, modulePath)) throw new Error("test_module_escapes_generation"); const entry = selected.entries.find((value) => value.path === module); if (entry?.type !== "file" || digest(await readFile(modulePath)) !== entry.sha256) throw new Error("test_module_integrity_mismatch"); return { ...selected, module, modulePath }; }
