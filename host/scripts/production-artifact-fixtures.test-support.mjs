/**
 * The fixtures `host/scripts/production-artifact*.test.mjs` publish into: one throwaway
 * Host root with the fixed runtime/bootstrap facts, the emitted tree a publication reads,
 * and the Windows helper pairs the several provenance journeys stage by hand.
 *
 * They are one module because they are one layout. A second copy of `productionConfig` or
 * `emit` is a fixture that agrees with the pipeline today and drifts from it tomorrow, and
 * the pipeline is exactly what these journeys are here to pin.
 */
import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_SUITE_TIMEOUT_MS, childAlreadyExited, runBoundedChild } from "./child-process-tool.mjs";
import { withSyntheticVerifiedReleaseBundledRuntimeForTest } from "./node-runtime-release-acquisition.mjs";
import { createIncompleteRuntimeFixture } from "./production-artifact-runtime-test-support.mjs";
import { publishTestArtifact } from "./production-artifact-test-support.mjs";
import { REQUIRED_VERIFICATION_ROOTS } from "./production-artifact.mjs";

export const hostRoot = fileURLToPath(new URL("..", import.meta.url));

export const BUNDLED_RUNTIME = {
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
export function productionConfig(config) {
  return {
    schema: "gamebuddy-host-production-artifact-config/v3",
    verificationRoots: REQUIRED_VERIFICATION_ROOTS,
    bundledRuntime: BUNDLED_RUNTIME,
    ...config,
  };
}

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-production-artifact-"));
  await mkdir(join(root, "resources"), { recursive: true });
  await mkdir(join(root, "node_modules", "typebox"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { typebox: "1.1.38" } }));
  await writeFile(join(root, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox", main: "index.js" }));
  await writeFile(join(root, "node_modules", "typebox", "index.js"), "export {};\n");
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] } })));
  await writeFile(join(root, "resources/windows-named-mutex-broker.ps1"), "broker");
  if (process.platform === "win32") {
    const pairRoot = join(root, "native/windows-reparse-inspector/win-x64");
    const helper = "GameBuddy.WindowsReparseInspector.exe"; const binary = Buffer.from("test-only reparse inspector");
    await mkdir(pairRoot, { recursive: true }); await writeFile(join(pairRoot, helper), binary);
    await writeFile(join(pairRoot, "windows-reparse-inspector.manifest.json"), `{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"${helper}","sha256":"${createHash("sha256").update(binary).digest("hex")}"}\n`);
    const config = JSON.parse(await readFile(join(root, "production-artifact.config.json"), "utf8"));
    config.windowsReparseInspector = { kind: "verified_windows_reparse_inspector", destination: "native/windows-reparse-inspector/win-x64", helper, manifest: "windows-reparse-inspector.manifest.json", probeEvidence: "windows-reparse-inspector.probe-evidence.json" };
    config.browserArtifact = { kind: "verified_tavern_browser_artifact", destination: "browser/tavern/v1", browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.tavern.browser.v1", manifest: "tavern-browser-artifact-manifest.json" };
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(config));
  }
  await createIncompleteRuntimeFixture(root);
  return root;
}
export async function withFixture(run) { const root = await fixture(); try { await run(root); } finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } }
/**
 * Resolves when the child exits, or fails by name at the deadline. `exit` fires once, so a
 * listener attached after the event never settles: a launcher that dies early must fail the
 * waiting test instead of hanging it. The deadline asks the launcher to stop first, because a
 * launcher owns the game child tree it spawned.
 */
export async function waitForChildExit(child, deadlineMs, describe) {
  if (childAlreadyExited(child)) return [child.exitCode, child.signalCode];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`child ${String(child.pid)} did not exit within ${deadlineMs}ms: ${describe()}`));
    }, deadlineMs);
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve([code, signal]); });
  });
}
export const testHash = (value) => createHash("sha256").update(value).digest("hex");
export const testU16 = (value) => { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value); return bytes; };
export const testU32 = (value) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
export function syntheticRuntimeZip(files = [{ path: "node.exe", bytes: Buffer.from("test node runtime") }]) {
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
export async function publishTestArtifactForFixture({ hostRoot: publishingHostRoot, emittedRoot, outputRoot }) { const { bytes, node } = syntheticRuntimeZip(); const descriptor = { sourceUrl: "https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip", archiveSha256: testHash(bytes), archiveRoot: "node-v24.20.0-win-x64", nodeSha256: testHash(node) }; return withSyntheticVerifiedReleaseBundledRuntimeForTest({ descriptor, zipBytes: bytes }, async (runtimeSource) => publishTestArtifact({ hostRoot: publishingHostRoot, emittedRoot, outputRoot, runtimeSource })); }

// Exercise production-private seams without widening their release API. The
// probe copies the implementation under test and adds exports only to its
// disposable test-local copy; the production module's public surface is intact.
export async function withProductionRuntimeContractProbe(run) {
  const probeRoot = await mkdtemp(join(scriptRoot, ".production-runtime-contract-"));
  const probePath = join(probeRoot, "production-artifact.mjs");
  try {
    const source = await readFile(join(scriptRoot, "production-artifact.mjs"), "utf8");
    await writeFile(probePath, `${source}\nexport { copyVerifiedBundledRuntimeSource, publishProductionArtifactWithRuntimeCopier, currentGeneration, verifyCurrentRuntimeAdmissionAssociation, verifyRuntimeAdmission };\n`);
    await cp(join(scriptRoot, "production-artifact-esm-resolution-probe.mjs"), join(probeRoot, "production-artifact-esm-resolution-probe.mjs"));
    // The probe copy also resolves the closure-staging module relatively.
    await cp(join(scriptRoot, "production-artifact-closure-staging.mjs"), join(probeRoot, "production-artifact-closure-staging.mjs"));
    // The probe copy resolves the shared voice fixture publisher relatively.
    await cp(join(scriptRoot, "voice-artifact-fixture-publisher.mjs"), join(probeRoot, "voice-artifact-fixture-publisher.mjs"));
    // The probe copy resolves the persona-hygiene import relatively (production-artifact.mjs imports it).
    await cp(join(scriptRoot, "check-release-persona-hygiene.mjs"), join(probeRoot, "check-release-persona-hygiene.mjs"));
    return await run(await import(`${pathToFileURL(probePath).href}?test=${Date.now()}`));
  } finally { await rm(probeRoot, { recursive: true, force: true }); }
}

export async function installArtifactTestDependencies(root) {
  await rm(join(root, "node_modules"), { recursive: true, force: true });
  await mkdir(join(root, "node_modules", "typescript"), { recursive: true });
  await cp(join(hostRoot, "node_modules", "typescript", "lib"), join(root, "node_modules", "typescript", "lib"), { recursive: true });
  await writeFile(join(root, "node_modules", "typescript", "package.json"), JSON.stringify({ name: "typescript", main: "./lib/typescript.js" }));
  await mkdir(join(root, "node_modules", "typebox"), { recursive: true });
  await writeFile(join(root, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox", type: "module", main: "index.js" }));
  await writeFile(join(root, "node_modules", "typebox", "index.js"), "export {};\n");
}

export const scriptRoot = join(fileURLToPath(new URL(".", import.meta.url)), "");

export async function runChild(command, args, options) {
  return runBoundedChild({
    command,
    args,
    cwd: options.cwd,
    stdio: options.stdio === "inherit" ? "inherit" : "pipe",
    timeoutMs: DEFAULT_SUITE_TIMEOUT_MS,
  });
}

export async function treeDigest(root) {
  const digest = createHash("sha256");
  async function visit(path, relative) {
    let entry;
    try { entry = await lstat(path); } catch (error) {
      if (error?.code === "ENOENT") { digest.update(`absent:${relative}\n`); return; }
      throw error;
    }
    if (entry.isSymbolicLink()) { digest.update(`link:${relative}:${await readlink(path)}\n`); return; }
    if (entry.isFile()) { digest.update(`file:${relative}:`).update(await readFile(path)).update("\n"); return; }
    if (!entry.isDirectory()) throw new Error(`unexpected_artifact_entry:${relative}`);
    digest.update(`directory:${relative}\n`);
    for (const name of (await readdir(path)).sort()) await visit(join(path, name), `${relative}/${name}`);
  }
  await visit(root, ".");
  return digest.digest("hex");
}

export function validRootSource(label) {
  return `import "typebox";\nexport const generation = ${JSON.stringify(label)};\n`;
}

export async function emit(root, content = "export {};\n") {
  const emitted = join(root, "emitted");
  await rm(emitted, { recursive: true, force: true });
  await mkdir(join(emitted, "tavern"), { recursive: true });
  await writeFile(join(emitted, "main.js"), `import "typebox";\n${content}`);
  await mkdir(join(emitted, "bootstrap", "entry"), { recursive: true });
  await writeFile(join(emitted, "bootstrap", "entry", "desktop-host-entry.internal.js"), "export {};\n");
  for (const verificationRoot of REQUIRED_VERIFICATION_ROOTS) {
    await mkdir(dirname(join(emitted, verificationRoot)), { recursive: true });
    await writeFile(join(emitted, verificationRoot), "export {};\n");
  }
  if (process.platform === "win32") {
    const config = JSON.parse(await readFile(join(root, "production-artifact.config.json"), "utf8"));
    if (config.windowsReparseInspector !== undefined) {
      const pair = "native/windows-reparse-inspector/win-x64";
      await mkdir(join(emitted, pair), { recursive: true });
      await cp(join(root, pair), join(emitted, pair), { recursive: true });
    }
    if (config.browserArtifact !== undefined) {
      const browserRoot = join(emitted, "browser/tavern/v1"); const asset = "assets/app-abcdef12.js"; const assetBytes = Buffer.from("export {};\n");
      await mkdir(join(browserRoot, "assets"), { recursive: true }); await writeFile(join(browserRoot, "index.html"), "<!doctype html>"); await writeFile(join(browserRoot, asset), assetBytes);
      await writeFile(join(browserRoot, "tavern-browser-artifact-manifest.json"), JSON.stringify({ schemaVersion: 1, browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.tavern.browser.v1", entryHtml: "index.html", assets: [{ path: asset, sha256: createHash("sha256").update(assetBytes).digest("hex"), bytes: assetBytes.length, mime: "text/javascript" }] }));
    }
  }
  return emitted;
}

export const windowsReparseInspectorDescriptor = {
  kind: "verified_windows_reparse_inspector",
  destination: "native/windows-reparse-inspector/win-x64",
  helper: "GameBuddy.WindowsReparseInspector.exe",
  manifest: "windows-reparse-inspector.manifest.json",
  probeEvidence: "windows-reparse-inspector.probe-evidence.json",
};
export async function addCanonicalWindowsReparseInspector(emitted) {
  const pairRoot = join(emitted, "native", "windows-reparse-inspector", "win-x64");
  const helper = Buffer.from("canonical Windows reparse inspector");
  const helperSha256 = createHash("sha256").update(helper).digest("hex");
  await mkdir(pairRoot, { recursive: true });
  await writeFile(join(pairRoot, windowsReparseInspectorDescriptor.helper), helper);
  await writeFile(join(pairRoot, windowsReparseInspectorDescriptor.manifest), `{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"GameBuddy.WindowsReparseInspector.exe","sha256":"${helperSha256}"}\n`);
  // Handwritten all-passed data is deliberately indistinguishable from any
  // audit file here because it is not evidence authority.
  await writeFile(join(pairRoot, windowsReparseInspectorDescriptor.probeEvidence), `{"schemaVersion":1,"probes":{"regular":"passed","junction":"passed","directorySymlink":"passed","nonLinkReparse":"passed"}}\n`);
}

export const windowsStaleLockReclaimerDescriptor = {
  kind: "verified_windows_stale_lock_reclaimer",
  destination: "native/windows-stale-lock-reclaimer/win-x64",
  helper: "GameBuddy.WindowsStaleLockReclaimer.exe",
  manifest: "windows-stale-lock-reclaimer.manifest.json",
};
// The artifact pipeline copies the reclaimer pair from the fixture's fixed
// build-publication root, so a fixture must provide that exact source layout.
export async function addCanonicalWindowsStaleLockReclaimer(fixtureRoot) {
  const pairRoot = join(fixtureRoot, "native", "windows-stale-lock-reclaimer", ".dist", "win-x64");
  const helper = Buffer.from("canonical Windows stale-lock reclaimer");
  const helperSha256 = createHash("sha256").update(helper).digest("hex");
  await mkdir(pairRoot, { recursive: true });
  await writeFile(join(pairRoot, windowsStaleLockReclaimerDescriptor.helper), helper);
  await writeFile(join(pairRoot, windowsStaleLockReclaimerDescriptor.manifest), `{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"GameBuddy.WindowsStaleLockReclaimer.exe","sha256":"${helperSha256}"}\n`);
}

export const windowsStardewFolderPickerDescriptor = {
  kind: "verified_windows_stardew_folder_picker",
  destination: "native/windows-stardew-folder-picker/win-x64",
  helper: "GameBuddy.WindowsStardewFolderPicker.exe",
  manifest: "windows-stardew-folder-picker.manifest.json",
};
export async function addCanonicalWindowsStardewFolderPicker(fixtureRoot) {
  const pairRoot = join(fixtureRoot, "native", "windows-stardew-folder-picker", ".dist", "win-x64");
  const helper = Buffer.from("canonical Windows Stardew folder picker");
  const helperSha256 = createHash("sha256").update(helper).digest("hex");
  await mkdir(pairRoot, { recursive: true });
  await writeFile(join(pairRoot, windowsStardewFolderPickerDescriptor.helper), helper);
  await writeFile(join(pairRoot, windowsStardewFolderPickerDescriptor.manifest), `{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"GameBuddy.WindowsStardewFolderPicker.exe","sha256":"${helperSha256}"}\n`);
}

export const windowsBootstrapGuardianDescriptor = {
  kind: "verified_windows_bootstrap_guardian",
  destination: "native/windows-bootstrap-guardian/win-x64",
  helper: "GameBuddy.WindowsBootstrapGuardian.exe",
  manifest: "windows-bootstrap-guardian.manifest.json",
};
export async function addCanonicalWindowsBootstrapGuardian(fixtureRoot) {
  const pairRoot = join(fixtureRoot, "native", "windows-bootstrap-guardian", ".dist", "win-x64");
  const helper = Buffer.from("canonical Windows bootstrap Guardian");
  const helperSha256 = createHash("sha256").update(helper).digest("hex");
  await mkdir(pairRoot, { recursive: true });
  await writeFile(join(pairRoot, windowsBootstrapGuardianDescriptor.helper), helper);
  await writeFile(join(pairRoot, windowsBootstrapGuardianDescriptor.manifest), `{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"GameBuddy.WindowsBootstrapGuardian.exe","sha256":"${helperSha256}"}\n`);
}

export async function addBrowserArtifact(root, emitted, { extra = false, assetPath = "assets/app-abcdef12.js", profileId = "gamebuddy.tavern.browser.v1", schemaVersion = 1 } = {}) {
  const browserRoot = join(emitted, "browser", "tavern", "v1");
  const content = Buffer.from("console.log('browser artifact');\n");
  await mkdir(join(browserRoot, "assets"), { recursive: true });
  await writeFile(join(browserRoot, "index.html"), "<!doctype html><title>Tavern</title>");
  await writeFile(join(browserRoot, assetPath), content);
  await writeFile(join(browserRoot, "tavern-browser-artifact-manifest.json"), JSON.stringify({
    schemaVersion,
    browserContract: "tavern_browser_api/v1",
    profileId,
    entryHtml: "index.html",
    assets: [{ path: assetPath, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length, mime: "text/javascript" }],
  }));
  if (extra) await writeFile(join(browserRoot, "assets", "extra-abcdef12.js"), "extra");
}
export const browserArtifactDescriptor = {
  kind: "verified_tavern_browser_artifact",
  destination: "browser/tavern/v1",
  browserContract: "tavern_browser_api/v1",
  profileId: "gamebuddy.tavern.browser.v1",
  manifest: "tavern-browser-artifact-manifest.json",
};
export async function configureBrowserArtifact(root, descriptor = browserArtifactDescriptor) {
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({
    entryRoots: ["main.js"],
    resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }],
    browserArtifact: descriptor,
    externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] },
  })));
}
