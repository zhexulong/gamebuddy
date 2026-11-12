/**
 * The fixed Windows helper pairs, and the provenance that makes them an authority.
 *
 * A helper is admitted only by the fixed binary plus its canonical manifest; handwritten
 * all-passed probe evidence is not evidence, so the first four journeys accept the pair and
 * refuse a rewritten one. The second four recheck a published generation and rebuild each
 * helper's origin from the same fixed facts, which is where a tampered helper has to fail.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  productionConfig,
  withFixture,
  publishTestArtifactForFixture,
  emit,
  windowsReparseInspectorDescriptor,
  addCanonicalWindowsReparseInspector,
  windowsStaleLockReclaimerDescriptor,
  addCanonicalWindowsStaleLockReclaimer,
  windowsStardewFolderPickerDescriptor,
  addCanonicalWindowsStardewFolderPicker,
  windowsBootstrapGuardianDescriptor,
  addCanonicalWindowsBootstrapGuardian,
} from "./production-artifact-fixtures.test-support.mjs";
import { recheckTestArtifactEntry, resolveTestArtifactEntry } from "./production-artifact-test-support.mjs";
import {
  verifyWindowsReparseInspectorPair,
  verifyWindowsStaleLockReclaimerPair,
  verifyWindowsBootstrapGuardianPair,
  verifyWindowsStardewFolderPickerPair,
} from "./production-artifact.mjs";

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


test("Windows bootstrap Guardian provenance accepts only the fixed binary and canonical manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-bootstrap-guardian-provenance-"));
  const descriptor = { kind: "verified_windows_bootstrap_guardian", destination: "native/windows-bootstrap-guardian/win-x64", helper: "GameBuddy.WindowsBootstrapGuardian.exe", manifest: "windows-bootstrap-guardian.manifest.json" };
  try {
    const pair = join(root, descriptor.destination); await mkdir(pair, { recursive: true });
    const binary = Buffer.from("fixed bootstrap guardian"); const hash = createHash("sha256").update(binary).digest("hex");
    await writeFile(join(pair, descriptor.helper), binary);
    await writeFile(join(pair, descriptor.manifest), `{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"${descriptor.helper}","sha256":"${hash}"}\n`);
    assert.equal((await verifyWindowsBootstrapGuardianPair({ root, descriptor })).helperSha256, hash);
    await writeFile(join(pair, descriptor.manifest), "tampered\n");
    await assert.rejects(verifyWindowsBootstrapGuardianPair({ root, descriptor }), /windows_bootstrap_guardian_pair_invalid/);
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
    await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot });
    const selected = await resolveTestArtifactEntry({ hostRoot: root, outputRoot, entry: "main.js" });
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
    await assert.doesNotReject(recheckTestArtifactEntry({ hostRoot: root, selected }));
    await writeFile(join(selected.artifactRoot, "native", "windows-reparse-inspector", "win-x64", windowsReparseInspectorDescriptor.helper), "tampered helper");
    await assert.rejects(recheckTestArtifactEntry({ hostRoot: root, selected }), /windows_reparse_inspector_pair_invalid/);
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
    await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot });
    const selected = await resolveTestArtifactEntry({ hostRoot: root, outputRoot, entry: "main.js" });
    const helperPath = `${windowsStaleLockReclaimerDescriptor.destination}/${windowsStaleLockReclaimerDescriptor.helper}`;
    assert.deepEqual(selected.entries.find((entry) => entry.path === helperPath)?.origin, {
      kind: windowsStaleLockReclaimerDescriptor.kind,
      destination: windowsStaleLockReclaimerDescriptor.destination,
      helper: windowsStaleLockReclaimerDescriptor.helper,
      manifest: windowsStaleLockReclaimerDescriptor.manifest,
      helperSha256: createHash("sha256").update(Buffer.from("canonical Windows stale-lock reclaimer")).digest("hex"),
    });
    await assert.doesNotReject(recheckTestArtifactEntry({ hostRoot: root, selected }));
    await writeFile(join(selected.artifactRoot, "native", "windows-stale-lock-reclaimer", "win-x64", windowsStaleLockReclaimerDescriptor.helper), "tampered helper");
    await assert.rejects(recheckTestArtifactEntry({ hostRoot: root, selected }), /windows_stale_lock_reclaimer_pair_invalid/);
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
    await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root), outputRoot });
    const selected = await resolveTestArtifactEntry({ hostRoot: root, outputRoot, entry: "main.js" });
    const helperPath = `${windowsStardewFolderPickerDescriptor.destination}/${windowsStardewFolderPickerDescriptor.helper}`;
    assert.deepEqual(selected.entries.find((entry) => entry.path === helperPath)?.origin, {
      kind: windowsStardewFolderPickerDescriptor.kind,
      destination: windowsStardewFolderPickerDescriptor.destination,
      helper: windowsStardewFolderPickerDescriptor.helper,
      manifest: windowsStardewFolderPickerDescriptor.manifest,
      helperSha256: createHash("sha256").update(Buffer.from("canonical Windows Stardew folder picker")).digest("hex"),
    });
    await assert.doesNotReject(recheckTestArtifactEntry({ hostRoot: root, selected }));
    await writeFile(join(selected.artifactRoot, windowsStardewFolderPickerDescriptor.destination, windowsStardewFolderPickerDescriptor.helper), "tampered helper");
    await assert.rejects(recheckTestArtifactEntry({ hostRoot: root, selected }), /windows_stardew_folder_picker_pair_invalid/);
  });
});


test("recheck reconstructs fixed Windows bootstrap Guardian origins and rejects helper tampering", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-specific production helper provenance");
    return;
  }
  await withFixture(async (root) => {
    await addCanonicalWindowsBootstrapGuardian(root);
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({
      entryRoots: ["main.js"],
      resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }],
      windowsBootstrapGuardian: windowsBootstrapGuardianDescriptor,
      externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] },
    })));
    const outputRoot = join(root, "dist");
    await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root), outputRoot });
    const selected = await resolveTestArtifactEntry({ hostRoot: root, outputRoot, entry: "main.js" });
    const helperPath = `${windowsBootstrapGuardianDescriptor.destination}/${windowsBootstrapGuardianDescriptor.helper}`;
    assert.deepEqual(selected.entries.find((entry) => entry.path === helperPath)?.origin, {
      kind: windowsBootstrapGuardianDescriptor.kind,
      destination: windowsBootstrapGuardianDescriptor.destination,
      helper: windowsBootstrapGuardianDescriptor.helper,
      manifest: windowsBootstrapGuardianDescriptor.manifest,
      helperSha256: createHash("sha256").update(Buffer.from("canonical Windows bootstrap Guardian")).digest("hex"),
    });
    await assert.doesNotReject(recheckTestArtifactEntry({ hostRoot: root, selected }));
    await writeFile(join(selected.artifactRoot, windowsBootstrapGuardianDescriptor.destination, windowsBootstrapGuardianDescriptor.helper), "tampered helper");
    await assert.rejects(recheckTestArtifactEntry({ hostRoot: root, selected }), /windows_bootstrap_guardian_pair_invalid/);
  });
});

