import assert from "node:assert/strict";
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import test from "node:test";
import { DEFAULT_SUITE_TIMEOUT_MS, runBoundedChild } from "@gamebuddy/game-action-devkit/process-supervisor";
import { resolveTypeScriptInvocation, verifyDeclaredMagicContextArtifact } from "./build-production-artifact.mjs";
import { assertCompleteProductionArtifact, copyApprovedResources, createBrowserArtifactSnapshot, createInventory, parseEsmResolutionProbeResult, publishProductionArtifact, readArtifactConfig, recheckProductionEntry, resolveProductionEntry, resolveProductionModule, verifyArtifact, verifyWindowsReparseInspectorPair, verifyWindowsStaleLockReclaimerPair, verifyWindowsStardewBootstrapGuardianPair, verifyWindowsStardewFolderPickerPair } from "./production-artifact.mjs";
import { createProductionChildEnvironment } from "./production-control-launch.mjs";

const hostRoot = fileURLToPath(new URL("..", import.meta.url));
const REQUIRED_VERIFICATION_ROOTS = [
  "tavern/player-turn-acceptance.js",
  "tavern/provider-attempt-claim.js",
  "tavern/chat-provider-start.js",
  "tavern/reference-pipeline-static-shell-composition.js",
  "reference-pipeline-dialogue-web.js",
  "tavern-management-dialogue-web.js",
  "tavern/tavern-management-static-shell-composition.js",
];

function productionConfig(config) {
  return {
    schema: "gamebuddy-host-production-artifact-config/v2",
    verificationRoots: REQUIRED_VERIFICATION_ROOTS,
    ...config,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-production-artifact-"));
  await mkdir(join(root, "resources"), { recursive: true });
  await mkdir(join(root, "node_modules", "typebox"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { typebox: "1.1.38" } }));
  await writeFile(join(root, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox", main: "index.js" }));
  await writeFile(join(root, "node_modules", "typebox", "index.js"), "export {};\n");
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] } })));
  await writeFile(join(root, "resources/windows-named-mutex-broker.ps1"), "broker");
  return root;
}
async function withFixture(run) { const root = await fixture(); try { await run(root); } finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } }
async function installArtifactTestDependencies(root) {
  await rm(join(root, "node_modules"), { recursive: true, force: true });
  await mkdir(join(root, "node_modules", "typescript"), { recursive: true });
  await cp(join(hostRoot, "node_modules", "typescript", "lib"), join(root, "node_modules", "typescript", "lib"), { recursive: true });
  await writeFile(join(root, "node_modules", "typescript", "package.json"), JSON.stringify({ name: "typescript", main: "./lib/typescript.js" }));
  await mkdir(join(root, "node_modules", "typebox"), { recursive: true });
  await writeFile(join(root, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox", type: "module", main: "index.js" }));
  await writeFile(join(root, "node_modules", "typebox", "index.js"), "export {};\n");
}

const scriptRoot = join(fileURLToPath(new URL(".", import.meta.url)), "");

async function runChild(command, args, options) {
  return runBoundedChild({
    command,
    args,
    cwd: options.cwd,
    stdio: options.stdio === "inherit" ? "inherit" : "pipe",
    timeoutMs: DEFAULT_SUITE_TIMEOUT_MS,
  });
}

async function treeDigest(root) {
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

test("Windows reparse helper provenance accepts only the fixed binary and canonical manifest; handwritten evidence is not an authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-reparse-provenance-"));
  const descriptor = { kind: "verified_windows_reparse_inspector", destination: "native/windows-reparse-inspector/win-x64", helper: "GameBuddy.WindowsReparseInspector.exe", manifest: "windows-reparse-inspector.manifest.json", probeEvidence: "windows-reparse-inspector.probe-evidence.json" };
  try {
    const pair = join(root, "native/windows-reparse-inspector/win-x64");
    await mkdir(pair, { recursive: true });
    const binary = Buffer.from("fixed helper");
    const hash = createHash("sha256").update(binary).digest("hex");
    await writeFile(join(pair, descriptor.helper), binary);
    await writeFile(join(pair, descriptor.manifest), `{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"GameBuddy.WindowsReparseInspector.exe","sha256":"${hash}"}\n`);
    const verified = await verifyWindowsReparseInspectorPair({ root, descriptor });
    assert.equal(verified.helperSha256, hash);
    await writeFile(join(pair, "windows-reparse-inspector.probe-evidence.json"), `{"schemaVersion":1,"probes":{"regular":"passed","junction":"passed","directorySymlink":"passed","nonLinkReparse":"passed"}}\n`);
    // The former caller boolean cannot turn this file into current release
    // evidence: helper identity remains the only construction decision here.
    await assert.doesNotReject(verifyWindowsReparseInspectorPair({ root, descriptor, requireProbeEvidence: true }));
    await writeFile(join(pair, descriptor.manifest), "handmade evidence cannot repair a bad helper manifest\n");
    await assert.rejects(verifyWindowsReparseInspectorPair({ root, descriptor }), /windows_reparse_inspector_pair_invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows Stardew folder-picker provenance accepts only the fixed binary and canonical manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-folder-picker-provenance-"));
  const descriptor = { kind: "verified_windows_stardew_folder_picker", destination: "native/windows-stardew-folder-picker/win-x64", helper: "GameBuddy.WindowsStardewFolderPicker.exe", manifest: "windows-stardew-folder-picker.manifest.json" };
  try {
    const pair = join(root, descriptor.destination); await mkdir(pair, { recursive: true });
    const binary = Buffer.from("fixed folder picker"); const hash = createHash("sha256").update(binary).digest("hex");
    await writeFile(join(pair, descriptor.helper), binary);
    await writeFile(join(pair, descriptor.manifest), `{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"${descriptor.helper}","sha256":"${hash}"}\n`);
    assert.equal((await verifyWindowsStardewFolderPickerPair({ root, descriptor })).helperSha256, hash);
    await writeFile(join(pair, descriptor.manifest), "tampered\n");
    await assert.rejects(verifyWindowsStardewFolderPickerPair({ root, descriptor }), /windows_stardew_folder_picker_pair_invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows Stardew bootstrap Guardian provenance accepts only the fixed binary and canonical manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-bootstrap-guardian-provenance-"));
  const descriptor = { kind: "verified_windows_stardew_bootstrap_guardian", destination: "native/windows-stardew-bootstrap-guardian/win-x64", helper: "GameBuddy.WindowsStardewBootstrapGuardian.exe", manifest: "windows-stardew-bootstrap-guardian.manifest.json" };
  try {
    const pair = join(root, descriptor.destination); await mkdir(pair, { recursive: true });
    const binary = Buffer.from("fixed bootstrap guardian"); const hash = createHash("sha256").update(binary).digest("hex");
    await writeFile(join(pair, descriptor.helper), binary);
    await writeFile(join(pair, descriptor.manifest), `{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"${descriptor.helper}","sha256":"${hash}"}\n`);
    assert.equal((await verifyWindowsStardewBootstrapGuardianPair({ root, descriptor })).helperSha256, hash);
    await writeFile(join(pair, descriptor.manifest), "tampered\n");
    await assert.rejects(verifyWindowsStardewBootstrapGuardianPair({ root, descriptor }), /windows_stardew_bootstrap_guardian_pair_invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows stale-lock reclaimer provenance accepts only the fixed binary and canonical manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-reclaimer-provenance-"));
  const descriptor = windowsStaleLockReclaimerDescriptor;
  try {
    const pair = join(root, "native/windows-stale-lock-reclaimer/win-x64");
    await mkdir(pair, { recursive: true });
    const binary = Buffer.from("fixed helper");
    const hash = createHash("sha256").update(binary).digest("hex");
    await writeFile(join(pair, descriptor.helper), binary);
    await writeFile(join(pair, descriptor.manifest), `{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"GameBuddy.WindowsStaleLockReclaimer.exe","sha256":"${hash}"}\n`);
    const verified = await verifyWindowsStaleLockReclaimerPair({ root, descriptor });
    assert.equal(verified.helperSha256, hash);
    await writeFile(join(pair, descriptor.manifest), "handmade evidence cannot repair a bad helper manifest\n");
    await assert.rejects(verifyWindowsStaleLockReclaimerPair({ root, descriptor }), /windows_stale_lock_reclaimer_pair_invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("production config is exact v2 and retains the current Chat/reference verification roots", async () => withFixture(async (root) => {
  const valid = productionConfig({
    entryRoots: ["main.js"],
    resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }],
    externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] },
  });
  for (const invalid of [
    { ...valid, schema: "gamebuddy-host-production-artifact-config/v1" },
    (() => { const { verificationRoots, ...withoutRoots } = valid; return withoutRoots; })(),
    { ...valid, verificationRoots: [] },
    { ...valid, verificationRoots: ["main.js"] },
    { ...valid, verificationRoots: [REQUIRED_VERIFICATION_ROOTS[0]] },
    { ...valid, verificationRoots: [...REQUIRED_VERIFICATION_ROOTS].reverse() },
    { ...valid, verificationRoots: [...REQUIRED_VERIFICATION_ROOTS, "tavern/other.js"] },
    { ...valid, unexpected: true },
  ]) {
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(invalid));
    await assert.rejects(readArtifactConfig(root), /invalid_production_artifact_config/);
  }
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(valid));
  assert.deepEqual((await readArtifactConfig(root)).verificationRoots, REQUIRED_VERIFICATION_ROOTS);
}));

test("production config admits exactly the frozen Windows stale-lock reclaimer descriptor and rejects drift", async () => withFixture(async (root) => {
  const valid = productionConfig({
    entryRoots: ["main.js"],
    resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }],
    windowsStaleLockReclaimer: windowsStaleLockReclaimerDescriptor,
    externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] },
  });
  for (const invalid of [
    { ...valid, windowsStaleLockReclaimer: { ...windowsStaleLockReclaimerDescriptor, kind: "verified_windows_stale_lock_cleaner" } },
    { ...valid, windowsStaleLockReclaimer: { ...windowsStaleLockReclaimerDescriptor, destination: "native/other/win-x64" } },
    { ...valid, windowsStaleLockReclaimer: { ...windowsStaleLockReclaimerDescriptor, helper: "Other.exe" } },
    { ...valid, windowsStaleLockReclaimer: { ...windowsStaleLockReclaimerDescriptor, manifest: "other.manifest.json" } },
    { ...valid, windowsStaleLockReclaimer: { ...windowsStaleLockReclaimerDescriptor, probeEvidence: "extra.json" } },
    { ...valid, windowsStaleLockReclaimer: { ...windowsStaleLockReclaimerDescriptor, arbitrary: true } },
  ]) {
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(invalid));
    await assert.rejects(readArtifactConfig(root), /invalid_windows_stale_lock_reclaimer_descriptor/);
  }
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(valid));
  assert.deepEqual((await readArtifactConfig(root)).windowsStaleLockReclaimer, windowsStaleLockReclaimerDescriptor);
}));

test("TypeScript build invocation is shell-free, argument-separated, and repository-resolved", async () => {
  const invocation = await resolveTypeScriptInvocation({ project: "tsconfig.production.json" });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args.slice(1), ["--project", "tsconfig.production.json"]);
  assert.equal(Object.hasOwn(invocation, "shell"), false);
  assert.equal(invocation.args.some((argument) => argument.includes(" && ") || argument.includes(";")), false);
  assert.equal(invocation.args[0], await realpath(join(hostRoot, "node_modules", "typescript", "lib", "tsc.js")));
});

test("declared Magic Context package resolves to the freshly built approved artifact", async () => {
  const verified = await verifyDeclaredMagicContextArtifact();
  assert.match(verified.entry, /@cortexkit[\\/]pi-magic-context[\\/]dist[\\/]index\.js$/);
  assert.match(verified.sha256, /^[a-f0-9]{64}$/);
});

test("production build refuses a stale declared Magic Context package artifact", async () =>
  withFixture(async (root) => {
    const mismatchedSource = join(root, "different-magic-context-index.js");
    await writeFile(mismatchedSource, "export const stale = true;\n");
    await assert.rejects(
      verifyDeclaredMagicContextArtifact({ sourceEntry: mismatchedSource }),
      /magic_context_declared_package_artifact_stale/,
    );
  }));

test("default TypeScript project typechecks without emitting into an isolated output root", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "gamebuddy-default-typecheck-"));
  try {
    const before = await treeDigest(outputRoot);
    const invocation = await resolveTypeScriptInvocation({ project: "tsconfig.json" });
    const result = await runChild(invocation.command, [...invocation.args, "--outDir", outputRoot], {
      cwd: invocation.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.code, 0, result.stderr.toString("utf8"));
    assert.equal(await treeDigest(outputRoot), before);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("production TypeScript emits exactly the two roots' reachable closure", async () => {
  const emittedRoot = await mkdtemp(join(tmpdir(), "gamebuddy-production-tsc-"));
  try {
    const invocation = await resolveTypeScriptInvocation({ project: "tsconfig.production.json" });
    const result = await runChild(invocation.command, [...invocation.args, "--outDir", emittedRoot], {
      cwd: invocation.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.code, 0, result.stderr.toString("utf8"));
    const emitted = (await readdir(emittedRoot, { recursive: true })).map((path) => path.replaceAll("\\", "/"));
    for (const root of ["main.js", "dialogue-web-main.js", "stardew-attachment.js", ...REQUIRED_VERIFICATION_ROOTS]) assert.ok(emitted.includes(root));
    for (const required of [
      "tavern/player-turn-acceptance.internal.js",
      "tavern/provider-attempt-claim.internal.js",
      "continuity-semantic-provisioning/continuity-semantic-provisioning.internal.js",
      "continuity-semantic-store/continuity-semantic-production-store.js",
      "continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js",
    ]) assert.ok(emitted.includes(required));
    const provisioner = await readFile(
      join(emittedRoot, "continuity-semantic-provisioning", "continuity-semantic-provisioning.internal.js"),
      "utf8",
    );
    for (const forbiddenTestControl of [
      "setFreshPostMarkerHookForTest",
      "setProvisionCloseHookForTest",
      "setCanonicalAdmissionObserverForTest",
      "setAuthorityRootIdentityDerivationObserverForTest",
      "freshPostMarkerHookForTest",
      "provisionCloseHookForTest",
      "canonicalAdmissionObserverForTest",
      "authorityRootIdentityDerivationObserverForTest",
    ]) assert.ok(!provisioner.includes(forbiddenTestControl), `${forbiddenTestControl} leaked into production artifact`);
    for (const unreachable of [
      "continuity-authority-coordinator/continuity-authority-coordinator.js",
      "continuity-semantic-backend/continuity-semantic-backend.js",
          ]) assert.ok(!emitted.includes(unreachable));
  } finally {
    await rm(emittedRoot, { recursive: true, force: true });
  }
});

function validRootSource(label) {
  return `import "typebox";\nexport const generation = ${JSON.stringify(label)};\n`;
}

async function emit(root, content = "export {};\n") {
  const emitted = join(root, "emitted");
  await rm(emitted, { recursive: true, force: true });
  await mkdir(join(emitted, "tavern"), { recursive: true });
  await writeFile(join(emitted, "main.js"), `import "typebox";\n${content}`);
  for (const verificationRoot of REQUIRED_VERIFICATION_ROOTS)
    await writeFile(join(emitted, verificationRoot), "export {};\n");
  return emitted;
}

const windowsReparseInspectorDescriptor = {
  kind: "verified_windows_reparse_inspector",
  destination: "native/windows-reparse-inspector/win-x64",
  helper: "GameBuddy.WindowsReparseInspector.exe",
  manifest: "windows-reparse-inspector.manifest.json",
  probeEvidence: "windows-reparse-inspector.probe-evidence.json",
};
async function addCanonicalWindowsReparseInspector(emitted) {
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

const windowsStaleLockReclaimerDescriptor = {
  kind: "verified_windows_stale_lock_reclaimer",
  destination: "native/windows-stale-lock-reclaimer/win-x64",
  helper: "GameBuddy.WindowsStaleLockReclaimer.exe",
  manifest: "windows-stale-lock-reclaimer.manifest.json",
};
// The artifact pipeline copies the reclaimer pair from the fixture's fixed
// build-publication root, so a fixture must provide that exact source layout.
async function addCanonicalWindowsStaleLockReclaimer(fixtureRoot) {
  const pairRoot = join(fixtureRoot, "native", "windows-stale-lock-reclaimer", ".dist", "win-x64");
  const helper = Buffer.from("canonical Windows stale-lock reclaimer");
  const helperSha256 = createHash("sha256").update(helper).digest("hex");
  await mkdir(pairRoot, { recursive: true });
  await writeFile(join(pairRoot, windowsStaleLockReclaimerDescriptor.helper), helper);
  await writeFile(join(pairRoot, windowsStaleLockReclaimerDescriptor.manifest), `{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"GameBuddy.WindowsStaleLockReclaimer.exe","sha256":"${helperSha256}"}\n`);
}

const windowsStardewFolderPickerDescriptor = {
  kind: "verified_windows_stardew_folder_picker",
  destination: "native/windows-stardew-folder-picker/win-x64",
  helper: "GameBuddy.WindowsStardewFolderPicker.exe",
  manifest: "windows-stardew-folder-picker.manifest.json",
};
async function addCanonicalWindowsStardewFolderPicker(fixtureRoot) {
  const pairRoot = join(fixtureRoot, "native", "windows-stardew-folder-picker", ".dist", "win-x64");
  const helper = Buffer.from("canonical Windows Stardew folder picker");
  const helperSha256 = createHash("sha256").update(helper).digest("hex");
  await mkdir(pairRoot, { recursive: true });
  await writeFile(join(pairRoot, windowsStardewFolderPickerDescriptor.helper), helper);
  await writeFile(join(pairRoot, windowsStardewFolderPickerDescriptor.manifest), `{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"GameBuddy.WindowsStardewFolderPicker.exe","sha256":"${helperSha256}"}\n`);
}

const windowsStardewBootstrapGuardianDescriptor = {
  kind: "verified_windows_stardew_bootstrap_guardian",
  destination: "native/windows-stardew-bootstrap-guardian/win-x64",
  helper: "GameBuddy.WindowsStardewBootstrapGuardian.exe",
  manifest: "windows-stardew-bootstrap-guardian.manifest.json",
};
async function addCanonicalWindowsStardewBootstrapGuardian(fixtureRoot) {
  const pairRoot = join(fixtureRoot, "native", "windows-stardew-bootstrap-guardian", ".dist", "win-x64");
  const helper = Buffer.from("canonical Windows Stardew bootstrap Guardian");
  const helperSha256 = createHash("sha256").update(helper).digest("hex");
  await mkdir(pairRoot, { recursive: true });
  await writeFile(join(pairRoot, windowsStardewBootstrapGuardianDescriptor.helper), helper);
  await writeFile(join(pairRoot, windowsStardewBootstrapGuardianDescriptor.manifest), `{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"GameBuddy.WindowsStardewBootstrapGuardian.exe","sha256":"${helperSha256}"}\n`);
}

test("recheck reconstructs fixed Windows reparse helper origins and rejects helper tampering", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-specific production helper provenance");
    return;
  }
  await withFixture(async (root) => {
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({
      entryRoots: ["main.js"],
      resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }],
      windowsReparseInspector: windowsReparseInspectorDescriptor,
      externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] },
    })));
    const emitted = await emit(root);
    await addCanonicalWindowsReparseInspector(emitted);
    const outputRoot = join(root, "dist");
    await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot });
    const selected = await resolveProductionEntry({ hostRoot: root, outputRoot, entry: "main.js" });
    const helperPath = `${windowsReparseInspectorDescriptor.destination}/${windowsReparseInspectorDescriptor.helper}`;
    assert.deepEqual(selected.entries.find((entry) => entry.path === helperPath)?.origin, {
      kind: windowsReparseInspectorDescriptor.kind,
      destination: windowsReparseInspectorDescriptor.destination,
      helper: windowsReparseInspectorDescriptor.helper,
      manifest: windowsReparseInspectorDescriptor.manifest,
      helperSha256: createHash("sha256").update(Buffer.from("canonical Windows reparse inspector")).digest("hex"),
    });
    assert.deepEqual(selected.entries.find((entry) => entry.path === `${windowsReparseInspectorDescriptor.destination}/${windowsReparseInspectorDescriptor.probeEvidence}`)?.origin, {
      kind: "passive_windows_reparse_live_gate_audit",
      destination: windowsReparseInspectorDescriptor.destination,
      audit: windowsReparseInspectorDescriptor.probeEvidence,
    });
    await assert.doesNotReject(recheckProductionEntry({ hostRoot: root, selected }));
    await writeFile(join(selected.artifactRoot, "native", "windows-reparse-inspector", "win-x64", windowsReparseInspectorDescriptor.helper), "tampered helper");
    await assert.rejects(recheckProductionEntry({ hostRoot: root, selected }), /windows_reparse_inspector_pair_invalid/);
  });
});

test("recheck reconstructs fixed Windows stale-lock reclaimer origins and rejects helper tampering", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-specific production helper provenance");
    return;
  }
  await withFixture(async (root) => {
    await addCanonicalWindowsStaleLockReclaimer(root);
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({
      entryRoots: ["main.js"],
      resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }],
      windowsStaleLockReclaimer: windowsStaleLockReclaimerDescriptor,
      externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] },
    })));
    const emitted = await emit(root);
    const outputRoot = join(root, "dist");
    await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot });
    const selected = await resolveProductionEntry({ hostRoot: root, outputRoot, entry: "main.js" });
    const helperPath = `${windowsStaleLockReclaimerDescriptor.destination}/${windowsStaleLockReclaimerDescriptor.helper}`;
    assert.deepEqual(selected.entries.find((entry) => entry.path === helperPath)?.origin, {
      kind: windowsStaleLockReclaimerDescriptor.kind,
      destination: windowsStaleLockReclaimerDescriptor.destination,
      helper: windowsStaleLockReclaimerDescriptor.helper,
      manifest: windowsStaleLockReclaimerDescriptor.manifest,
      helperSha256: createHash("sha256").update(Buffer.from("canonical Windows stale-lock reclaimer")).digest("hex"),
    });
    await assert.doesNotReject(recheckProductionEntry({ hostRoot: root, selected }));
    await writeFile(join(selected.artifactRoot, "native", "windows-stale-lock-reclaimer", "win-x64", windowsStaleLockReclaimerDescriptor.helper), "tampered helper");
    await assert.rejects(recheckProductionEntry({ hostRoot: root, selected }), /windows_stale_lock_reclaimer_pair_invalid/);
  });
});

test("recheck reconstructs fixed Windows Stardew folder-picker origins and rejects helper tampering", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-specific production helper provenance");
    return;
  }
  await withFixture(async (root) => {
    await addCanonicalWindowsStardewFolderPicker(root);
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({
      entryRoots: ["main.js"],
      resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }],
      windowsStardewFolderPicker: windowsStardewFolderPickerDescriptor,
      externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] },
    })));
    const outputRoot = join(root, "dist");
    await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root), outputRoot });
    const selected = await resolveProductionEntry({ hostRoot: root, outputRoot, entry: "main.js" });
    const helperPath = `${windowsStardewFolderPickerDescriptor.destination}/${windowsStardewFolderPickerDescriptor.helper}`;
    assert.deepEqual(selected.entries.find((entry) => entry.path === helperPath)?.origin, {
      kind: windowsStardewFolderPickerDescriptor.kind,
      destination: windowsStardewFolderPickerDescriptor.destination,
      helper: windowsStardewFolderPickerDescriptor.helper,
      manifest: windowsStardewFolderPickerDescriptor.manifest,
      helperSha256: createHash("sha256").update(Buffer.from("canonical Windows Stardew folder picker")).digest("hex"),
    });
    await assert.doesNotReject(recheckProductionEntry({ hostRoot: root, selected }));
    await writeFile(join(selected.artifactRoot, windowsStardewFolderPickerDescriptor.destination, windowsStardewFolderPickerDescriptor.helper), "tampered helper");
    await assert.rejects(recheckProductionEntry({ hostRoot: root, selected }), /windows_stardew_folder_picker_pair_invalid/);
  });
});

test("recheck reconstructs fixed Windows Stardew bootstrap Guardian origins and rejects helper tampering", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-specific production helper provenance");
    return;
  }
  await withFixture(async (root) => {
    await addCanonicalWindowsStardewBootstrapGuardian(root);
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({
      entryRoots: ["main.js"],
      resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }],
      windowsStardewBootstrapGuardian: windowsStardewBootstrapGuardianDescriptor,
      externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] },
    })));
    const outputRoot = join(root, "dist");
    await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root), outputRoot });
    const selected = await resolveProductionEntry({ hostRoot: root, outputRoot, entry: "main.js" });
    const helperPath = `${windowsStardewBootstrapGuardianDescriptor.destination}/${windowsStardewBootstrapGuardianDescriptor.helper}`;
    assert.deepEqual(selected.entries.find((entry) => entry.path === helperPath)?.origin, {
      kind: windowsStardewBootstrapGuardianDescriptor.kind,
      destination: windowsStardewBootstrapGuardianDescriptor.destination,
      helper: windowsStardewBootstrapGuardianDescriptor.helper,
      manifest: windowsStardewBootstrapGuardianDescriptor.manifest,
      helperSha256: createHash("sha256").update(Buffer.from("canonical Windows Stardew bootstrap Guardian")).digest("hex"),
    });
    await assert.doesNotReject(recheckProductionEntry({ hostRoot: root, selected }));
    await writeFile(join(selected.artifactRoot, windowsStardewBootstrapGuardianDescriptor.destination, windowsStardewBootstrapGuardianDescriptor.helper), "tampered helper");
    await assert.rejects(recheckProductionEntry({ hostRoot: root, selected }), /windows_stardew_bootstrap_guardian_pair_invalid/);
  });
});

test("publishes immutable versioned generations and an atomically replaced current pointer", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  const first = await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "first"), outputRoot: dist });
  const firstEntry = await resolveProductionEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  const second = await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "second"), outputRoot: dist });
  const secondEntry = await resolveProductionEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  assert.notEqual(first.generation, second.generation);
  assert.notEqual(firstEntry.artifactRoot, secondEntry.artifactRoot);
  assert.equal(await readFile(firstEntry.entryPath, "utf8"), 'import "typebox";\nfirst');
  assert.equal(await readFile(secondEntry.entryPath, "utf8"), 'import "typebox";\nsecond');
  assert.deepEqual(second.entries.find((entry) => entry.path === "windows-named-mutex-broker.ps1")?.origin, { kind: "allowlisted_resource", source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1", config: "production-artifact.config.json" });
  await assertCompleteProductionArtifact({ hostRoot: root, outputRoot: dist });
}));

test("Host atomically emits the fixed Guardian admission contract after pair verification", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-specific Guardian admission publication");
  await withFixture(async (root) => {
    await addCanonicalWindowsStardewBootstrapGuardian(root);
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({
      entryRoots: ["main.js"],
      resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }],
      windowsStardewBootstrapGuardian: windowsStardewBootstrapGuardianDescriptor,
      externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] },
    })));
    const outputRoot = join(root, "dist");
    const published = await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root), outputRoot });
    const contract = JSON.parse(await readFile(join(outputRoot, "generations", published.generation, "guardian-admission.json"), "utf8"));
    const helperSha256 = createHash("sha256").update(Buffer.from("canonical Windows Stardew bootstrap Guardian")).digest("hex");
    assert.deepEqual(contract, {
      schema: "gamebuddy-host-guardian-admission/v1",
      inventoryDigest: published.digest,
      helperPath: "native/windows-stardew-bootstrap-guardian/win-x64/GameBuddy.WindowsStardewBootstrapGuardian.exe",
      manifestPath: "native/windows-stardew-bootstrap-guardian/win-x64/windows-stardew-bootstrap-guardian.manifest.json",
      helperSha256,
      manifestSha256: createHash("sha256").update(Buffer.from(`{\"schemaVersion\":1,\"protocolVersion\":1,\"rid\":\"win-x64\",\"helperFileName\":\"GameBuddy.WindowsStardewBootstrapGuardian.exe\",\"sha256\":\"${helperSha256}\"}\n`)).digest("hex"),
      manifestSchemaVersion: 1,
      manifestProtocolVersion: 1,
      manifestRid: "win-x64",
      manifestHelperFileName: "GameBuddy.WindowsStardewBootstrapGuardian.exe",
    });
  });
});

test("rejects unlisted, unused, unresolvable, and undocumented dynamic external closure ingress", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, 'import "unlisted";'), outputRoot: dist }), /external_package_unlisted/);
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox", "unused"] } })));
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist }), /external_package_unused/);
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["missing"] } })));
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, 'import "missing";').then(async (emitted) => { await writeFile(join(emitted, "main.js"), 'import "missing";'); return emitted; }), outputRoot: dist }), /external_package_unresolvable/);
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] } })));
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "await import(process.env.MODULE);"), outputRoot: dist }), /dynamic_module_ingress_forbidden/);
}));

test("resolves declared external runtime packages with Host-root-contained ESM import semantics", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  const voiceProtocolRoot = join(root, "node_modules", "@gamebuddy", "voice-protocol");
  const importOnlyRoot = join(root, "node_modules", "@cortexkit", "pi-magic-context");
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { typebox: "1.1.38", "@gamebuddy/voice-protocol": "workspace:*", "@cortexkit/pi-magic-context": "file:../vendor/magic-context/packages/pi-plugin" } }));
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["@cortexkit/pi-magic-context", "@gamebuddy/voice-protocol", "typebox"] } })));
  await mkdir(voiceProtocolRoot, { recursive: true });
  await writeFile(join(voiceProtocolRoot, "package.json"), JSON.stringify({ name: "@gamebuddy/voice-protocol", exports: "./index.js" }));
  await writeFile(join(voiceProtocolRoot, "index.js"), "export {};\n");
  await mkdir(join(importOnlyRoot, "dist"), { recursive: true });
  await writeFile(join(importOnlyRoot, "package.json"), JSON.stringify({ name: "@cortexkit/pi-magic-context", type: "module", exports: { ".": { import: "./dist/index.js" } } }));
  await writeFile(join(importOnlyRoot, "dist", "index.js"), "export {};\n");
  const published = await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, 'import "@gamebuddy/voice-protocol"; import "@cortexkit/pi-magic-context";'), outputRoot: dist });
  assert.deepEqual(published.externalRuntimeClosure.verifiedPackages, ["@cortexkit/pi-magic-context", "@gamebuddy/voice-protocol", "typebox"]);
  await rm(importOnlyRoot, { recursive: true });
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["@cortexkit/pi-magic-context", "typebox"] } })));
  await assert.rejects(
    publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, 'import "@cortexkit/pi-magic-context";'), outputRoot: dist }),
    /production_external_package_unresolvable:@cortexkit\/pi-magic-context/,
  );
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["@gamebuddy/voice-protocol", "typebox"] } })));
  await rm(voiceProtocolRoot, { recursive: true });
  await assert.rejects(
    publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, 'import "@gamebuddy/voice-protocol";'), outputRoot: dist }),
    /production_external_package_unresolvable:@gamebuddy\/voice-protocol/,
  );
  const requireOnlyRoot = join(root, "node_modules", "require-only-esm");
  await mkdir(requireOnlyRoot, { recursive: true });
  await writeFile(join(requireOnlyRoot, "package.json"), JSON.stringify({ name: "require-only-esm", exports: { ".": { require: "./require.cjs" } } }));
  await writeFile(join(requireOnlyRoot, "require.cjs"), "module.exports = {};\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "require-only-esm": "1.0.0", typebox: "1.1.38" } }));
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["require-only-esm", "typebox"] } })));
  await assert.rejects(
    publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, 'import "require-only-esm";'), outputRoot: dist }),
    /production_external_package_unresolvable:require-only-esm/,
  );
  const nestedHostRoot = join(root, "nested-host");
  await mkdir(join(nestedHostRoot, "resources"), { recursive: true });
  await mkdir(join(nestedHostRoot, "node_modules"));
  await writeFile(join(nestedHostRoot, "package.json"), JSON.stringify({ dependencies: { typebox: "1.1.38" } }));
  await writeFile(join(nestedHostRoot, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] } })));
  await writeFile(join(nestedHostRoot, "resources", "windows-named-mutex-broker.ps1"), "broker");
  await assert.rejects(
    publishProductionArtifact({ hostRoot: nestedHostRoot, emittedRoot: await emit(nestedHostRoot, "export {};"), outputRoot: join(nestedHostRoot, "dist") }),
    /production_external_package_unresolvable:typebox/,
  );
  await assert.rejects(
    publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, 'import "unlisted-runtime-package";'), outputRoot: dist }),
    /production_external_package_unlisted:unlisted-runtime-package:main\.js/,
  );
}));

test("resolver rejects a scoped namespace symlink before package manifest reads", async (t) => withFixture(async (root) => {
  const dist = join(root, "dist");
  const outside = `${root}-outside`;
  const scope = join(root, "node_modules", "@scope");
  try {
    await mkdir(join(outside, "pkg"), { recursive: true });
    await writeFile(join(outside, "pkg", "package.json"), JSON.stringify({ name: "@scope/pkg", exports: "./index.js" }));
    await writeFile(join(outside, "pkg", "index.js"), "export {};\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { typebox: "1.1.38", "@scope/pkg": "1.0.0" } }));
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["@scope/pkg", "typebox"] } })));
    try { await symlink(outside, scope, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if (process.platform === "win32" && error?.code === "EPERM") { t.skip("Windows junction unavailable: EPERM"); return; } throw error; }
    await assert.rejects(
      publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, 'import "@scope/pkg";'), outputRoot: dist }),
      /production_external_package_unresolvable:@scope\/pkg/,
    );
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

test("resolver probe accepts only the exact JSON object and string tuple grammar", () => {
  const specifiers = ["typebox"];
  assert.deepEqual(parseEsmResolutionProbeResult(JSON.stringify({ schema: "gamebuddy-production-esm-resolution/v1", resolved: [["typebox", "file:///package/index.js"]] }), specifiers), [["typebox", "file:///package/index.js"]]);
  for (const value of [
    { schema: "gamebuddy-production-esm-resolution/v1", resolved: [["typebox", "file:///package/index.js"]], extra: true },
    { schema: "gamebuddy-production-esm-resolution/v1", resolved: [["typebox", "file:///package/index.js", "extra"]] },
    { schema: "gamebuddy-production-esm-resolution/v1", resolved: [["typebox", 1]] },
    ["gamebuddy-production-esm-resolution/v1", [["typebox", "file:///package/index.js"]]],
  ]) assert.throws(() => parseEsmResolutionProbeResult(JSON.stringify(value), specifiers), /invalid_esm_probe_result/);
});

test("fixed resolver probe never executes a Host-root collision, entry, or inherited NODE_OPTIONS preload", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  const collision = join(root, ".production-artifact-esm-resolution-probe.mjs");
  const preload = join(root, "hostile-preload.cjs");
  const preloadSentinel = join(root, "preload-executed.txt");
  const entrySentinel = join(root, "entry-executed.txt");
  await writeFile(collision, "collision survives");
  await writeFile(preload, `require("node:fs").writeFileSync(${JSON.stringify(preloadSentinel)}, "executed");`);
  await writeFile(join(root, "node_modules", "typebox", "index.js"), `require("node:fs").writeFileSync(${JSON.stringify(entrySentinel)}, "executed");`);
  const saved = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = `--require=${preload}`;
    await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist });
  } finally { if (saved === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = saved; }
  await assert.rejects(lstat(preloadSentinel), { code: "ENOENT" });
  await assert.rejects(lstat(entrySentinel), { code: "ENOENT" });
  assert.equal(await readFile(collision, "utf8"), "collision survives");
}));

test("resolver rejects package entry escape and package-root symlink", async (t) => withFixture(async (root) => {
  const dist = join(root, "dist");
  await writeFile(join(root, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox", exports: "../outside.js" }));
  await writeFile(join(root, "outside.js"), "export {};\n");
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist }), /production_external_package_unresolvable:typebox/);
  const outside = join(root, "outside-package");
  await mkdir(outside); await writeFile(join(outside, "package.json"), JSON.stringify({ name: "typebox", exports: "./index.js" })); await writeFile(join(outside, "index.js"), "export {};\n");
  await rm(join(root, "node_modules", "typebox"), { recursive: true, force: true });
  try { await symlink(outside, join(root, "node_modules", "typebox"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (process.platform === "win32" && error?.code === "EPERM") { t.skip("Windows symlink unavailable: EPERM"); return; } throw error; }
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist }), /production_external_package_unresolvable:typebox/);
}));

test("rejects every dynamic import or require without an exact module, package, and expression rule", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, 'await import("typebox");'), outputRoot: dist }), /dynamic_module_ingress_forbidden/);
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "await import(process.env.MODULE);"), outputRoot: dist }), /dynamic_module_ingress_forbidden/);
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "require(process.env.MODULE);"), outputRoot: dist }), /dynamic_module_ingress_forbidden/);
  await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, '/* import(process.env.MODULE) */ const text = "require(\\\"typebox\\\")";'), outputRoot: dist });
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [{ package: "typebox", module: "wrong.js", expression: "process.env.MODULE" }] } })));
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "await import(process.env.MODULE);"), outputRoot: dist }), /invalid_declared_external_runtime_closure/);
  const missingModuleRule = { package: "typebox", module: "missing.js", expression: "pathToFileURL(magicContextEntry).href", occurrence: 0 };
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [missingModuleRule] } })));
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist }), /dynamic_external_module_missing/);
  const duplicateRule = { package: "typebox", module: "main.js", expression: "pathToFileURL(magicContextEntry).href" };
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [duplicateRule, duplicateRule] } })));
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist }), /invalid_declared_external_runtime_closure/);
  const duplicateModule = { package: "typebox", module: "main.js", expression: "pathToFileURL(magicContextEntry).href", occurrence: 0 };
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox", "@cortexkit/pi-magic-context"], dynamicExternalImports: [duplicateModule, { ...duplicateModule, package: "@cortexkit/pi-magic-context" }] } })));
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist }), /invalid_declared_external_runtime_closure/);
  const exactRule = { package: "typebox", module: "main.js", expression: "pathToFileURL(magicContextEntry).href", occurrence: 0 };
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [exactRule] } })));
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "await import(pathToFileURL(magicContextEntry).href);\nawait import(pathToFileURL(magicContextEntry).href);"), outputRoot: dist }), /rule_bijection_failed/);
  const outOfRangeRule = { ...exactRule, occurrence: 2 };
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [outOfRangeRule] } })));
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "await import(pathToFileURL(magicContextEntry).href);"), outputRoot: dist }), /dynamic_module_ingress_forbidden/);
  const orderedRules = [{ ...exactRule, occurrence: 0 }, { ...exactRule, occurrence: 1 }];
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: orderedRules } })));
  await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "await import(pathToFileURL(magicContextEntry).href);\nawait import(pathToFileURL(magicContextEntry).href);"), outputRoot: dist });
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [exactRule] } })));
  await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "await import(pathToFileURL(magicContextEntry).href);"), outputRoot: dist });
}));

test("rejects concrete process.getBuiltinModule loader ingress forms without treating comments, strings, or unrelated reflection as ingress", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  for (const source of [
    'const require = process.getBuiltinModule("module").createRequire(import.meta.url); require("unlisted");',
    'const module = process?.getBuiltinModule?.("module");',
    'const getBuiltinModule = process["getBuiltinModule"]; const module = getBuiltinModule("module");',
    'const { getBuiltinModule } = process; const module = getBuiltinModule("module");',
    'const { getBuiltinModule: loader } = process; const module = loader("module");',
    'const loader = Reflect.get(process, "getBuiltinModule"); const module = loader("module");',
    'const descriptor = Object.getOwnPropertyDescriptor?.(process, "getBuiltinModule"); const module = descriptor?.value("module");',
    'const loader = Reflect["get"](process, "getBuiltinModule"); const module = loader("module");',
    'const loader = Reflect["get"]?.(process, "getBuiltinModule"); const module = loader?.("module");',
    'const descriptor = Object["getOwnPropertyDescriptor"](process, "getBuiltinModule"); const module = descriptor.value("module");',
    'const descriptor = Object["getOwnPropertyDescriptor"]?.(process, "getBuiltinModule"); const module = descriptor?.value?.("module");',
    'const descriptor = Object["getOwn" + "PropertyDescriptor"](process, "getBuiltinModule"); const module = descriptor.value("module");',
    'const builtin = globalThis.process["getBuiltin" + "Module"]; const module = builtin("module");',
    'const processRef = globalThis["pro" + "cess"]; const descriptor = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule"); const module = descriptor.value("module");',
    'const processRef = globalThis["process"]; const builtin = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule").value; const raw = builtin("node:module").createRequire(import.meta.url)("./chat-thread-store.js").acceptP4MountedPlayerMessage; void raw;',
    'const processRef = globalThis.global.process; const builtin = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule").value; const raw = builtin("node:module").createRequire(import.meta.url)("./chat-thread-store.js").acceptP4MountedPlayerMessage; void raw;',
    'const processRef = (globalThis).global.process; const builtin = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule").value; const raw = builtin("node:module").createRequire(import.meta.url)("./chat-thread-store.js").acceptP4MountedPlayerMessage; void raw;',
    'const processRef = (process); const builtin = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule").value; const raw = builtin("node:module").createRequire(import.meta.url)("./chat-thread-store.js").acceptP4MountedPlayerMessage; void raw;',
  ]) {
    await assert.rejects(
      publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, source), outputRoot: dist }),
      /production_process_get_builtin_module_ingress_forbidden:main\.js/,
    );
  }
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [{ package: "typebox", module: "main.js", expression: "pathToFileURL(magicContextEntry).href", occurrence: 0 }] } })));
  await publishProductionArtifact({
    hostRoot: root,
    emittedRoot: await emit(root, 'import "node:fs"; await import(pathToFileURL(magicContextEntry).href); /* process.getBuiltinModule("module") */ const text = "process.getBuiltinModule(\\\"module\\\")"; Reflect.get(process, "getBuiltinModuleName"); Object.getOwnPropertyDescriptor(process, "getBuiltinModuleName"); Reflect["get"]?.(process, "getBuiltinModuleName"); Object["getOwnPropertyDescriptor"]?.(process, "getBuiltinModuleName");'),
    outputRoot: dist,
  });
}));

test("rejects node module-loader ingress and its bare alias before createRequire can bypass external closure", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  for (const source of [
    'import { createRequire } from "node:module"; const r = createRequire(import.meta.url); r("unlisted");',
    'import { createRequire } from "module"; const r = createRequire(import.meta.url); r("unlisted");',
    'export { createRequire } from "node:module";',
    'export { createRequire } from "module";',
  ]) {
    await assert.rejects(
      publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, source), outputRoot: dist }),
      /production_module_loader_ingress_forbidden:main\.js:(?:node:)?module/,
    );
  }
}));

test("requires every emitted relative module edge to resolve inside the selected immutable generation", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  const valid = await emit(root, 'import "./support.js";\nexport {};');
  await writeFile(join(valid, "support.js"), "export {};\n");
  await publishProductionArtifact({ hostRoot: root, emittedRoot: valid, outputRoot: dist });

  await assert.rejects(
    publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, 'import "./missing.js";'), outputRoot: dist }),
    /production_relative_module_missing_from_artifact:main\.js:\.\/missing\.js/,
  );
  await assert.rejects(
    publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, 'import "../outside.js";'), outputRoot: dist }),
    /production_relative_module_escapes_artifact:main\.js:\.\.\/outside\.js/,
  );
}));

test("rejects reachable nested game-origin-authority artifacts by category and preserves current", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "known-good"), outputRoot: dist });
  const before = await resolveProductionEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  const emitted = await emit(root, "candidate");
  const forbidden = "game-origin-authority/nested/authority.js";
  await mkdir(join(emitted, "game-origin-authority", "nested"), { recursive: true });
  await writeFile(join(emitted, forbidden), 'import "typebox"; export const reachable = true;');
  await writeFile(join(emitted, "main.js"), 'import "typebox"; import "./game-origin-authority/nested/authority.js";');
  await assert.rejects(
    publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist }),
    /production_legacy_continuity_module_forbidden:game-origin-authority\/nested\/authority\.js/,
  );
  const after = await resolveProductionEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  assert.equal(after.artifactRoot, before.artifactRoot);
  assert.equal(await readFile(after.entryPath, "utf8"), 'import "typebox";\nknown-good');
}));

test("rejects every legacy continuity artifact namespace by category", async () => withFixture(async (root) => {
  const legacyModules = [
    "continuity-authority-coordinator/nested/reintroduced.js",
    "continuity-authority-routing/nested/reintroduced.js",
    "continuity-production-migration/nested/reintroduced.js",
    "continuity-semantic-backend/nested/reintroduced.js",
    "continuity.js",
    "game-origin-authority/nested/reintroduced.js",
    "game-surface-lease.js",
    "game-surface-recovery.js",
    "game-surface-lifecycle/nested/reintroduced.js",
    "integration-bootstrap.js",
    "local-bootstrap.js",
  ];
  for (const module of legacyModules) {
    const emitted = await emit(root, "candidate");
    await mkdir(dirname(join(emitted, module)), { recursive: true });
    await writeFile(join(emitted, module), "export {};\n");
    await assert.rejects(
      createInventory({
        artifactRoot: emitted,
        hostRoot: root,
        externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: [] },
      }),
      (error) => error?.message === `production_legacy_continuity_module_forbidden:${module}`,
    );
  }
}));

test("publishes only the entry-reachable semantic implementation closure", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  const emitted = await emit(root, 'import "./continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";');
  const required = [
    "continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js",
    "continuity-semantic-deployment-composition/continuity-semantic-deployment-composition.js",
    "continuity-semantic-store/continuity-semantic-production-store.js",
    "continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.js",
    "continuity-semantic-chat-runtime-materializer/continuity-semantic-chat-runtime-materializer.js",
    "continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js",
    "continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.js",
  ];
  for (const module of required) {
    await mkdir(join(emitted, module, ".."), { recursive: true });
    await writeFile(join(emitted, module), "export {};\n");
  }
  await writeFile(join(emitted, "main.js"), `import "typebox";\n${required.map((module) => `import "./${module}";`).join("\n")}\n`);
  await mkdir(join(emitted, "unreachable"));
  await writeFile(join(emitted, "unreachable", "otherwise-valid.js"), "export const unreachable = true;\n");
  await assert.rejects(
    publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist }),
    /production_module_unreachable_from_entry_roots:unreachable\/otherwise-valid\.js/,
  );
  await rm(join(emitted, "unreachable"), { recursive: true });
  const published = await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  for (const module of required) assert.ok(published.entries.some((entry) => entry.path === module));
  await writeFile(join(emitted, "main.js"), 'import "./missing.js";');
  await assert.rejects(
    publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist }),
    /production_relative_module_missing_from_artifact:main\.js:\.\/missing\.js/,
  );
}));

test("a failed publication preserves the previous verified current generation", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "known-good"), outputRoot: dist });
  const before = await resolveProductionEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  await writeFile(join(root, "emitted", "physical-fixture-worker.js"), "forbidden");
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: join(root, "emitted"), outputRoot: dist }), /test_artifact/);
  const after = await resolveProductionEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  assert.equal(after.artifactRoot, before.artifactRoot);
  assert.equal(await readFile(after.entryPath, "utf8"), 'import "typebox";\nknown-good');
}));

test("rejects fixture workers broadly, tampering, orphans, symlinks, and invalid start entry names", async (t) => withFixture(async (root) => {
  const dist = join(root, "dist");
  const emitted = await emit(root);
  for (const forbidden of ["helper.test.js", "test-fixtures/worker.js", "continuity-physical-fixture-worker.js", "fixture-worker.js"]) {
    await mkdir(join(emitted, "test-fixtures"), { recursive: true }); await writeFile(join(emitted, forbidden), "");
    await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist }), /test_artifact/);
    await rm(join(emitted, forbidden), { force: true });
  }
  await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  const current = await resolveProductionEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  await writeFile(join(current.artifactRoot, "orphan.js"), 'import "typebox";'); await assert.rejects(assertCompleteProductionArtifact({ hostRoot: root, outputRoot: dist }), /(?:mismatch_or_orphan|module_unreachable_from_entry_roots:orphan\.js)/);
  await rm(join(current.artifactRoot, "orphan.js")); await writeFile(current.entryPath, 'import "typebox";\ntampered'); await assert.rejects(assertCompleteProductionArtifact({ hostRoot: root, outputRoot: dist }), /mismatch_or_orphan/);
  for (const invalid of ["../main.js", "nested/main.js", "/main.js", "unknown.js", "main.js/.."]) await assert.rejects(resolveProductionEntry({ hostRoot: root, outputRoot: dist, entry: invalid }), /production_entry_not_configured/);
  const target = join(root, "outside.ps1"); await writeFile(target, "outside");
  try { await rm(join(root, "resources/windows-named-mutex-broker.ps1")); await symlink(target, join(root, "resources/windows-named-mutex-broker.ps1")); } catch (error) { t.skip(`symlink unavailable: ${error.code}`); return; }
  await assert.rejects(copyApprovedResources({ hostRoot: root, stagingRoot: join(root, "staging"), config: await readArtifactConfig(root) }), /symbolic_link/);
}));

test("a starter retains the verified generation selected before a concurrent publisher changes current", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, validRootSource("old")), outputRoot: dist });
  const selected = await resolveProductionEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, validRootSource("new")), outputRoot: dist });
  assert.equal(await readFile(selected.entryPath, "utf8"), `import "typebox";\n${validRootSource("old")}`);
}));

test("resolves only inventoried, untampered JavaScript modules from a selected immutable generation", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  const emitted = await emit(root, 'import "./support.js"; export {};');
  await writeFile(join(emitted, "support.js"), "export const trusted = true;\n");
  await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  const selected = await resolveProductionEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  const resolved = await resolveProductionModule({ selected, module: "support.js" });
  assert.equal(await readFile(resolved.modulePath, "utf8"), "export const trusted = true;\n");
  for (const module of ["../support.js", "support.mjs", "missing.js", "test-fixtures/worker.js"]) {
    await assert.rejects(resolveProductionModule({ selected, module }), /production_module_(?:not_configured|escapes_generation|missing_from_inventory)/);
  }
  await writeFile(resolved.modulePath, "tampered");
  await assert.rejects(resolveProductionModule({ selected, module: "support.js" }), /production_module_integrity_mismatch/);
}));

test("concurrent publishers serialize, preserve current, and reject stale direct root artifacts", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(dist, { recursive: true }); await writeFile(join(dist, "stale-main.js"), "stale");
  const first = join(root, "first"); const second = join(root, "second");
  for (const emitted of [first, second]) await mkdir(join(emitted, "tavern"), { recursive: true });
  await writeFile(join(first, "main.js"), 'import "typebox"; "first";');
  await writeFile(join(second, "main.js"), 'import "typebox"; "second";');
  for (const verificationRoot of REQUIRED_VERIFICATION_ROOTS) {
    await writeFile(join(first, verificationRoot), "export {};\n");
    await writeFile(join(second, verificationRoot), "export {};\n");
  }
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: first, outputRoot: dist }), /production_output_root_contains_direct_artifact/);
  assert.equal(await readFile(join(dist, "stale-main.js"), "utf8"), "stale");
  await rm(join(dist, "stale-main.js"));
  const published = await Promise.all([publishProductionArtifact({ hostRoot: root, emittedRoot: first, outputRoot: dist }), publishProductionArtifact({ hostRoot: root, emittedRoot: second, outputRoot: dist })]);
  assert.notEqual(published[0].generation, published[1].generation);
  assert.deepEqual((await readdir(dist)).sort(), ["current.json", "generations"]);
  const current = await resolveProductionEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  assert.ok(['import "typebox"; "first";', 'import "typebox"; "second";'].includes(await readFile(current.entryPath, "utf8")));
  await assertCompleteProductionArtifact({ hostRoot: root, outputRoot: dist });
}));

test("production child environment strips inherited Pi and Magic Context selectors", () => {
  const child = createProductionChildEnvironment("main.js", {
    GAMEBUDDY_D0_BOOTSTRAP_TEST: "1",
    GAMEBUDDY_LIVE_SUPERVISOR: "1",
    PI: "developer-pi",
    PI_CODING_AGENT: "1",
    PI_CODING_AGENT_DIR: "developer-agent-dir",
    PI_CODING_AGENT_SESSION_DIR: "developer-sessions",
    PI_MODEL: "developer-model",
    PI_PROVIDER: "developer-provider",
    PI_SESSION_FILE: "developer-session.jsonl",
    PI_SESSION_ID: "developer-session-id",
    PI_SUBAGENT_PARENT_SESSION: "developer-parent-session",
    MAGIC_CONTEXT_PI_SUBAGENT: "1",
    MAGIC_CONTEXT_TEST_DATA_DIR: "developer-magic-context-data",
    SAFE: "ok",
  });
  assert.deepEqual(Object.keys(child).sort(), ["GAMEBUDDY_CONTROL_PIPE", "GAMEBUDDY_CONTROL_TOKEN", "GAMEBUDDY_LIVE_SUPERVISOR", "SAFE"]);
  assert.match(child.GAMEBUDDY_CONTROL_PIPE ?? "", /^[A-Za-z0-9_-]{1,128}$/);
  assert.match(child.GAMEBUDDY_CONTROL_TOKEN ?? "", /^[A-Za-z0-9_-]{16,256}$/);
});

test("Game launcher credentials are fresh, grammar-valid, child-only, and absent for Dialogue", () => {
  const inherited = { GAMEBUDDY_CONTROL_PIPE: "inherited_pipe", GAMEBUDDY_CONTROL_TOKEN: "inherited_token_value", SAFE: "ok" };
  const first = createProductionChildEnvironment("main.js", inherited);
  const second = createProductionChildEnvironment("main.js", inherited);
  assert.match(first.GAMEBUDDY_CONTROL_PIPE ?? "", /^[A-Za-z0-9_-]{1,128}$/);
  assert.match(first.GAMEBUDDY_CONTROL_TOKEN ?? "", /^[A-Za-z0-9_-]{16,256}$/);
  assert.notEqual(first.GAMEBUDDY_CONTROL_PIPE, second.GAMEBUDDY_CONTROL_PIPE);
  assert.notEqual(first.GAMEBUDDY_CONTROL_TOKEN, second.GAMEBUDDY_CONTROL_TOKEN);
  assert.equal(inherited.GAMEBUDDY_CONTROL_PIPE, "inherited_pipe");
  assert.equal(inherited.GAMEBUDDY_CONTROL_TOKEN, "inherited_token_value");
  assert.deepEqual(createProductionChildEnvironment("dialogue-web-main.js", inherited), { SAFE: "ok" });
});


test("launcher rejects any environment-selected control handoff before child spawn", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(join(root, "scripts"));
  for (const script of ["production-artifact.mjs", "production-artifact-esm-resolution-probe.mjs", "production-control-launch.mjs", "start-production-artifact.mjs"]) await cp(join(scriptRoot, script), join(root, "scripts", script));
  await installArtifactTestDependencies(root);
  const emitted = await emit(root);
  await writeFile(join(emitted, "main.js"), 'import "typebox"; process.send?.({ schema: "ordinary-production-ipc", value: 1 }); setTimeout(() => process.exit(0), 40);');
  await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  const child = spawn(process.execPath, [join(root, "scripts", "start-production-artifact.mjs"), "main.js"], { cwd: root, env: { ...process.env, GAMEBUDDY_LIVE_SUPERVISOR: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages = []; let stderr = "";
  child.on("message", (message) => messages.push(message)); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code)); });
  assert.notEqual(result, 0, `starter stderr: ${stderr}`);
  assert.deepEqual(messages, []);
}));

test("launcher relays exact-grammar source evidence and kills malformed source evidence", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(join(root, "scripts"));
  for (const script of ["production-artifact.mjs", "production-artifact-esm-resolution-probe.mjs", "production-control-launch.mjs", "start-production-artifact.mjs"])  await cp(join(scriptRoot, script), join(root, "scripts", script));
  await installArtifactTestDependencies(root);
  const emitted = await emit(root);
  const valid = { schema: "gamebuddy-production-live-source-attestation/v1", evidence: { schema: "gamebuddy-production-live-source-attestation/v1", protocolVersion: 1, evidenceClass: "production_live_source_attestation", launchBindingSha256: "d".repeat(64), runtimeInstanceSha256: "a".repeat(64), kind: "stop_settled", sourceEventSha256: "b".repeat(64), batchIdSha256: null, stopIdSha256: "c".repeat(64), epoch: 1, disposition: null, observationRevision: null } };
  await writeFile(join(emitted, "main.js"), `import "typebox"; process.send?.(${JSON.stringify(valid)}); process.send?.({ schema: "ordinary-production-ipc", value: 1 }); setTimeout(() => process.exit(0), 40);`);
  await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  const child = spawn(process.execPath, [join(root, "scripts", "start-production-artifact.mjs"), "main.js"], { cwd: root, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages = []; child.on("message", (message) => messages.push(message));
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0);
  assert.deepEqual(messages, [valid, { schema: "ordinary-production-ipc", value: 1 }]);
  await writeFile(join(emitted, "main.js"), `import "typebox"; process.send?.(${JSON.stringify({ ...valid, evidence: { ...valid.evidence, observationRevision: 0 } })}); setTimeout(() => process.exit(0), 40);`);
  await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  const malformed = spawn(process.execPath, [join(root, "scripts", "start-production-artifact.mjs"), "main.js"], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const malformedCode = await new Promise((resolve, reject) => { malformed.once("error", reject); malformed.once("exit", resolve); });
  assert.notEqual(malformedCode, 0);
}));

test("active STOP proof receipt is wrapper-owned and leaves the Preview child live", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(join(root, "scripts"));
  for (const script of [
    "active-stop-proof.mjs",
    "production-artifact.mjs",
    "production-artifact-esm-resolution-probe.mjs",
    "production-control-launch.mjs",
    "start-production-artifact.mjs",
  ]) await cp(join(scriptRoot, script), join(root, "scripts", script));
  await installArtifactTestDependencies(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", dependencies: { typebox: "1.1.38" } }));
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({
    entryRoots: ["farmhand-companion-preview.js"],
    resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }],
    externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] },
  })));
  const emitted = await emit(root);
  await rm(join(emitted, "main.js"));
  const entry = join(emitted, "farmhand-companion-preview.js");
  const runtime = "a".repeat(64);
  const batch = "b".repeat(64);
  const stop = "c".repeat(64);
  const source = "d".repeat(64);
  await writeFile(entry, `import "typebox";
const binding = process.env.GAMEBUDDY_LIVE_SOURCE_ATTESTATION_LAUNCH_BINDING_SHA256;
if (!/^[a-f0-9]{64}$/.test(binding ?? "")) process.exit(9);
// The wrapper must not treat child stdout as a proof authority.
process.stdout.write("active_stop_proof_verified\\n");
const base = Object.freeze({ schema: "gamebuddy-production-live-source-attestation/v1", protocolVersion: 1, evidenceClass: "production_live_source_attestation", launchBindingSha256: binding, runtimeInstanceSha256: ${JSON.stringify(runtime)}, sourceEventSha256: ${JSON.stringify(source)} });
const send = (kind, fields) => process.send?.({ schema: base.schema, evidence: { ...base, kind, ...fields } });
send("pi_turn_accepted", { batchIdSha256: ${JSON.stringify(batch)}, stopIdSha256: null, epoch: null, disposition: "steer", observationRevision: null });
send("native_stop_all_observed", { batchIdSha256: null, stopIdSha256: ${JSON.stringify(stop)}, epoch: null, disposition: null, observationRevision: null });
send("stop_sealed", { batchIdSha256: ${JSON.stringify(batch)}, stopIdSha256: ${JSON.stringify(stop)}, epoch: 3, disposition: null, observationRevision: null });
send("stop_settled", { batchIdSha256: ${JSON.stringify(batch)}, stopIdSha256: ${JSON.stringify(stop)}, epoch: 3, disposition: null, observationRevision: null });
send("old_epoch_quiet", { batchIdSha256: ${JSON.stringify(batch)}, stopIdSha256: ${JSON.stringify(stop)}, epoch: 3, disposition: null, observationRevision: 9 });
send("body_settled", { batchIdSha256: ${JSON.stringify(batch)}, stopIdSha256: ${JSON.stringify(stop)}, epoch: 3, disposition: null, observationRevision: 9 });
if (process.argv.includes("--exit-after-proof")) setTimeout(() => process.exit(0), 40);
else {
  setTimeout(() => process.send?.({ schema: "post-proof-ordinary-ipc", value: 1 }), 80);
  setInterval(() => undefined, 1_000);
}
`);
  await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  const wrapper = spawn(process.execPath, [
    join(root, "scripts", "start-production-artifact.mjs"),
    "farmhand-companion-preview.js",
    "--require-active-stop-proof",
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "";
  let stderr = "";
  const messages = [];
  wrapper.on("message", (message) => { messages.push(message); });
  wrapper.stdout.setEncoding("utf8");
  wrapper.stderr.setEncoding("utf8");
  wrapper.stdout.on("data", (chunk) => { stdout += chunk; });
  wrapper.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await Promise.race([
      new Promise((resolve) => wrapper.stdout.on("data", () => {
        if (stdout === "active_stop_proof_verified\n") resolve();
      })),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`proof receipt timeout: ${stdout} ${stderr}`)), 5_000)),
    ]);
    assert.equal(stdout, "active_stop_proof_verified\n");
    assert.equal(wrapper.exitCode, null, `wrapper exited after proof: ${stderr}`);
    assert.equal(wrapper.killed, false);
    await Promise.race([
      new Promise((resolve) => wrapper.on("message", () => {
        if (messages.some((message) => message?.schema === "post-proof-ordinary-ipc" && message.value === 1)) resolve();
      })),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`post-proof IPC timeout: ${JSON.stringify(messages)}`)), 5_000)),
    ]);
  } finally {
    wrapper.kill("SIGTERM");
    await new Promise((resolve) => wrapper.once("exit", resolve));
  }
  const exited = spawn(process.execPath, [
    join(root, "scripts", "start-production-artifact.mjs"),
    "farmhand-companion-preview.js",
    "--require-active-stop-proof",
    "--exit-after-proof",
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let exitedStdout = "";
  let exitedStderr = "";
  exited.stdout.setEncoding("utf8");
  exited.stderr.setEncoding("utf8");
  exited.stdout.on("data", (chunk) => { exitedStdout += chunk; });
  exited.stderr.on("data", (chunk) => { exitedStderr += chunk; });
  const [exitCode] = await new Promise((resolve) => exited.once("exit", (...args) => resolve(args)));
  assert.equal(exitCode, 1);
  assert.equal(exitedStdout, "active_stop_proof_verified\n");
  assert.equal(exitedStderr, "preview_exited_after_active_stop_proof\n");
}));

test("non-D0 starter relays ordinary child IPC and leaves the child live", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(join(root, "scripts"));
  for (const script of ["production-artifact.mjs", "production-artifact-esm-resolution-probe.mjs", "production-control-launch.mjs", "start-production-artifact.mjs"])  await cp(join(scriptRoot, script), join(root, "scripts", script));
  await installArtifactTestDependencies(root);
  const emitted = await emit(root);
  await writeFile(join(emitted, "main.js"), 'import "typebox"; process.on("message", (message) => process.send?.({ schema: "ordinary-parent-ipc-ack", received: message })); process.send?.({ schema: "ordinary-production-ipc", value: 1 }); setTimeout(() => process.exit(0), 80);');
  await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  const child = spawn(process.execPath, [join(root, "scripts", "start-production-artifact.mjs"), "main.js"], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages = []; let stderr = "";
  child.on("message", (message) => messages.push(message));
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.send({ schema: "ordinary-parent-ipc", value: 2 });
  const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code)); });
  assert.equal(result, 0, `starter stderr: ${stderr}`);
  assert.deepEqual(messages, [
    { schema: "ordinary-production-ipc", value: 1 },
    { schema: "ordinary-parent-ipc-ack", received: { schema: "ordinary-parent-ipc", value: 2 } },
  ]);
}));

test("Task 9 starter relays one exact correlated task and one validated v2 terminal aggregate", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(join(root, "scripts"));
  for (const script of ["production-artifact.mjs", "production-artifact-esm-resolution-probe.mjs", "production-control-launch.mjs", "start-production-artifact.mjs"]) await cp(join(scriptRoot, script), join(root, "scripts", script));
  await installArtifactTestDependencies(root);
  const emitted = await emit(root);
  const nonceSha256 = "a".repeat(64);
  const ready = { schema: "gamebuddy-production-game-task-ingress/v1", kind: "ready", surface: "game", nonceSha256, gameSessionId: "game_session_01", piSessionId: "pi_session_01" };
  const dispatch = { ...ready, kind: "dispatch_task", task: "walk to the chest" };
  const terminal = {
    schema: "gamebuddy-game-operational-gate-evidence/v2",
    nonceSha256,
    piSessionId: ready.piSessionId,
    surface: "game",
    capabilityRevision: 3,
    capabilityCount: 4,
    transitions: { count: 2, distinctActionCount: 2, freshObservationCount: 2, allPostconditionsObserved: true },
    terminalState: "completed",
    stopSettled: true,
  };
  await writeFile(join(emitted, "main.js"), `import "typebox";
process.send?.(${JSON.stringify(ready)});
process.on("message", (message) => {
  if (message?.kind !== "dispatch_task") process.exit(11);
  process.send?.(${JSON.stringify(terminal)});
  setTimeout(() => process.exit(0), 40);
});
`);
  await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  const child = spawn(process.execPath, [join(root, "scripts", "start-production-artifact.mjs"), "main.js"], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages = []; let stderr = "";
  child.on("message", (message) => {
    messages.push(message);
    if (message?.kind === "ready") child.send(dispatch);
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code)); });
  assert.equal(result, 0, `starter stderr: ${stderr}`);
  assert.deepEqual(messages, [ready, terminal]);
}));

test("Task 9 starter rejects dispatch before ready and every malformed, foreign, or duplicate terminal protocol message", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(join(root, "scripts"));
  for (const script of ["production-artifact.mjs", "production-artifact-esm-resolution-probe.mjs", "production-control-launch.mjs", "start-production-artifact.mjs"]) await cp(join(scriptRoot, script), join(root, "scripts", script));
  await installArtifactTestDependencies(root);
  const emitted = await emit(root);
  const nonceSha256 = "b".repeat(64);
  const ready = { schema: "gamebuddy-production-game-task-ingress/v1", kind: "ready", surface: "game", nonceSha256, gameSessionId: "game_session_02", piSessionId: "pi_session_02" };
  const validDispatch = { ...ready, kind: "dispatch_task", task: "do the task" };
  const terminal = {
    schema: "gamebuddy-game-operational-gate-evidence/v2",
    nonceSha256,
    piSessionId: ready.piSessionId,
    surface: "game",
    capabilityRevision: 1,
    capabilityCount: 2,
    transitions: { count: 2, distinctActionCount: 2, freshObservationCount: 2, allPostconditionsObserved: true },
    terminalState: "completed",
    stopSettled: true,
  };
  async function runCase(childSource, parentMessage) {
    await writeFile(join(emitted, "main.js"), `import "typebox";\n${childSource}`);
    await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
    const child = spawn(process.execPath, [join(root, "scripts", "start-production-artifact.mjs"), "main.js"], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const messages = []; let stderr = "";
    child.on("message", (message) => {
      messages.push(message);
      if (message?.kind === "ready") child.send(parentMessage);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (value) => resolve(value)); });
    assert.notEqual(code, 0, `starter unexpectedly accepted invalid Task 9 case: ${stderr}`);
    return messages;
  }
  const early = await (async () => {
    await writeFile(join(emitted, "main.js"), `import "typebox"; setTimeout(() => process.send?.(${JSON.stringify(ready)}), 100);`);
    await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
    const child = spawn(process.execPath, [join(root, "scripts", "start-production-artifact.mjs"), "main.js"], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.send(validDispatch);
    return new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => { assert.notEqual(code, 0); resolve(code); }); });
  })();
  assert.notEqual(early, 0);
  await runCase(`process.send?.(${JSON.stringify(ready)}); process.on("message", () => process.send?.(${JSON.stringify(terminal)}));`, { ...validDispatch, task: "\ud800" });
  await runCase(`process.send?.(${JSON.stringify(ready)}); process.on("message", () => process.send?.(${JSON.stringify({ ...terminal, capabilityCount: 2, extra: true })}));`, validDispatch);
  await runCase(`process.send?.(${JSON.stringify(ready)}); process.on("message", () => { process.send?.(${JSON.stringify({ ...terminal, nonceSha256: "c".repeat(64) })}); });`, validDispatch);
  await runCase(`process.send?.(${JSON.stringify(ready)}); process.on("message", () => { process.send?.(${JSON.stringify(terminal)}); process.send?.(${JSON.stringify(terminal)}); });`, validDispatch);
}));

test("Task 9 starter terminates its direct child when the parent IPC disconnects", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(join(root, "scripts"));
  for (const script of ["production-artifact.mjs", "production-artifact-esm-resolution-probe.mjs", "production-control-launch.mjs", "start-production-artifact.mjs"])
    await cp(join(scriptRoot, script), join(root, "scripts", script));
  await installArtifactTestDependencies(root);
  const emitted = await emit(root);
  const ready = { schema: "gamebuddy-production-game-task-ingress/v1", kind: "ready", surface: "game", nonceSha256: "d".repeat(64), gameSessionId: "game_session_disconnect", piSessionId: "pi_session_disconnect" };
  await writeFile(join(emitted, "main.js"), `import "typebox";
process.send?.(${JSON.stringify(ready)});
process.once("SIGTERM", () => process.exit(23));
setInterval(() => undefined, 1000);
`);
  await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  const wrapper = spawn(process.execPath, [join(root, "scripts", "start-production-artifact.mjs"), "main.js"], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  await new Promise((resolve, reject) => {
    wrapper.once("error", reject);
    wrapper.on("message", (message) => {
      if (message?.kind === "ready") resolve();
    });
  });
  wrapper.disconnect();
  const code = await new Promise((resolve, reject) => {
    wrapper.once("error", reject);
    wrapper.once("exit", resolve);
  });
  assert.notEqual(code, 0);
}));

test("starter forwards a fixed ingress stage from its immutable child stdout", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(join(root, "scripts"));
  for (const script of ["production-artifact.mjs", "production-artifact-esm-resolution-probe.mjs", "production-control-launch.mjs", "start-production-artifact.mjs"])
    await cp(join(scriptRoot, script), join(root, "scripts", script));
  await installArtifactTestDependencies(root);
  const emitted = await emit(root);
  const stage = "GameBuddy native chat ingress stage=native_chat_pipe_data_received:received";
  await writeFile(join(emitted, "main.js"), `import "typebox"; console.debug(${JSON.stringify(stage)});`);
  await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });

  const child = await runChild(process.execPath, [join(root, "scripts", "start-production-artifact.mjs"), "main.js"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(child.code, 0, child.stderr.toString());
  assert.equal(child.stdout.toString("utf8"), `${stage}\n`);
  assert.doesNotMatch(child.stderr.toString("utf8"), new RegExp(stage));
}));

test("starter accepts exactly one configured root then forwards config arguments", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(join(root, "scripts"));
  for (const script of ["production-artifact.mjs", "production-artifact-esm-resolution-probe.mjs", "production-control-launch.mjs", "start-production-artifact.mjs"])  await cp(join(scriptRoot, script), join(root, "scripts", script));
  // Use Host-local regular package directories in this isolated fixture.
  await installArtifactTestDependencies(root);
  const start = join(root, "scripts", "start-production-artifact.mjs");
  for (const entry of ["main.js", "dialogue-web-main.js"]) {
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: [entry], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] } })));
    const emitted = join(root, `emitted-${entry}`); await mkdir(join(emitted, "tavern"), { recursive: true });
    for (const verificationRoot of REQUIRED_VERIFICATION_ROOTS)
      await writeFile(join(emitted, verificationRoot), "export {};\n");
    await writeFile(join(emitted, entry), 'import "typebox"; process.stdout.write(JSON.stringify({ args: process.argv.slice(2), controlsPresent: Boolean(process.env.GAMEBUDDY_CONTROL_PIPE || process.env.GAMEBUDDY_CONTROL_TOKEN) }));');
    await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
    const child = await runChild(process.execPath, [start, entry, "--config", `${entry}.json`], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(child.code, 0, child.stderr.toString());
    assert.deepEqual(JSON.parse(child.stdout.toString()), { args: ["--config", `${entry}.json`], controlsPresent: entry === "main.js" });
  }
  for (const entry of ["../main.js", "nested/main.js", "unknown.js"]) {
    await assert.rejects(runChild(process.execPath, [start, entry], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }), /test_runner_failed:code=1/);
  }
}));

async function addBrowserArtifact(root, emitted, { extra = false, assetPath = "assets/app-abcdef12.js", profileId = "gamebuddy.tavern.browser.v1", schemaVersion = 1 } = {}) {
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
const browserArtifactDescriptor = {
  kind: "verified_tavern_browser_artifact",
  destination: "browser/tavern/v1",
  browserContract: "tavern_browser_api/v1",
  profileId: "gamebuddy.tavern.browser.v1",
  manifest: "tavern-browser-artifact-manifest.json",
};
async function configureBrowserArtifact(root, descriptor = browserArtifactDescriptor) {
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({
    entryRoots: ["main.js"],
    resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }],
    browserArtifact: descriptor,
    externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] },
  })));
}
test("publisher admits only the fixed manifest-verified browser artifact subtree with stable provenance", async () => withFixture(async (root) => {
  await configureBrowserArtifact(root);
  const emitted = await emit(root);
  await addBrowserArtifact(root, emitted);
  const published = await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: join(root, "dist") });
  const browserEntries = published.entries.filter((entry) => entry.path.startsWith("browser/tavern/v1/"));
  assert.deepEqual(browserEntries.map((entry) => entry.path), [
    "browser/tavern/v1/assets/app-abcdef12.js",
    "browser/tavern/v1/index.html",
    "browser/tavern/v1/tavern-browser-artifact-manifest.json",
  ]);
  assert.deepEqual(browserEntries[0].origin, {
    kind: "verified_tavern_browser_artifact",
    browserContract: "tavern_browser_api/v1",
    profileId: "gamebuddy.tavern.browser.v1",
    manifest: "tavern-browser-artifact-manifest.json",
    destination: "browser/tavern/v1",
  });
  assert.notEqual(browserEntries[0].origin.kind, "typescript_emit");
  await assertCompleteProductionArtifact({ hostRoot: root, outputRoot: join(root, "dist") });
}));

test("browser artifact descriptor and tree fail closed for extra, escaping, identity, and inventory mismatches", async () => withFixture(async (root) => {
  for (const descriptor of [
    { ...browserArtifactDescriptor, destination: "browser/tavern/v2" },
    { ...browserArtifactDescriptor, source: "arbitrary" },
    { ...browserArtifactDescriptor, entryRoots: ["main.js"] },
    { ...browserArtifactDescriptor, dynamicExternalImports: [] },
    { ...browserArtifactDescriptor, profileId: "other" },
    { kind: browserArtifactDescriptor.kind },
  ]) {
    await configureBrowserArtifact(root, descriptor);
    await assert.rejects(readArtifactConfig(root), /invalid_browser_artifact_descriptor/);
  }
  await configureBrowserArtifact(root);
  for (const options of [
    { extra: true },
    { assetPath: "assets/../escape-abcdef12.js" },
    { profileId: "wrong.browser" },
    { schemaVersion: 2 },
  ]) {
    const emitted = await emit(root);
    await addBrowserArtifact(root, emitted, options);
    await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: join(root, "dist") }), /production_browser_artifact_(?:tree_mismatch|asset_mismatch)|invalid_browser_artifact_manifest/);
  }
  const emitted = await emit(root);
  await addBrowserArtifact(root, emitted);
  await writeFile(join(emitted, "browser", "outside.js"), "unreachable browser escape");
  await assert.rejects(
    publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: join(root, "dist") }),
    /production_browser_artifact_outside_fixed_subtree:browser\/outside\.js/,
  );
  await rm(join(emitted, "browser", "outside.js"));
  const outputRoot = join(root, "dist");
  await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot });
  const selected = await resolveProductionEntry({ hostRoot: root, outputRoot, entry: "main.js" });
  await writeFile(join(selected.artifactRoot, "browser", "tavern", "v1", "assets", "app-abcdef12.js"), "tampered");
  await assert.rejects(assertCompleteProductionArtifact({ hostRoot: root, outputRoot }), /production_browser_artifact_asset_mismatch/);
}));

test("a browser snapshot rejects mutation after its initial verification before inventory can pass", async () => withFixture(async (root) => {
  await configureBrowserArtifact(root);
  const emitted = await emit(root);
  await addBrowserArtifact(root, emitted);
  const config = await readArtifactConfig(root);
  const snapshot = (await createBrowserArtifactSnapshot({ artifactRoot: emitted, descriptor: config.browserArtifact })).snapshot;
  await writeFile(join(emitted, "browser", "tavern", "v1", "index.html"), "mutated after snapshot");
  await assert.rejects(
    verifyArtifact({ artifactRoot: emitted, hostRoot: root, config, browserArtifactSnapshot: snapshot }),
    /production_browser_artifact_snapshot_mismatch/,
  );
  await assert.rejects(
    createInventory({ artifactRoot: emitted, hostRoot: root, origins: new Map(), entryRoots: config.entryRoots, externalRuntimeClosure: config.externalRuntimeClosure, browserArtifactDescriptor: config.browserArtifact, browserArtifactSnapshot: snapshot }),
    /production_browser_artifact_snapshot_mismatch/,
  );
}));

test("rejects test, fixture, and legacy resource declarations before source I/O", async () => withFixture(async (root) => {
  for (const source of ["resources/example.test.ps1", "src/test-fixtures/missing.ps1", "resources/legacy-writer-fixture.ps1"]) {
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source, destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] } })));
    await assert.rejects(readArtifactConfig(root), /production_resource_source_forbidden/);
  }
}));
