import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolInventory } from "../src/tool-inventory.mjs";

const inventory = JSON.parse(readFileSync(new URL("../tool-inventory.json", import.meta.url), "utf8"));
const trackedPaths = inventory.entries.map((entry) => entry.path);

function clone() {
  return structuredClone(inventory);
}

function assertRejected(mutator, expected) {
  const candidate = clone();
  mutator(candidate);
  assert.throws(() => validateToolInventory(candidate, { trackedPaths }), new RegExp(expected));
}

test("validates the checked-in inventory against supplied governed paths", () => {
  const report = validateToolInventory(inventory, { trackedPaths });
  assert.equal(report.fileCount, 166);
  assert.equal(report.pilotLegacyClosureCount, 14);
  assert.equal(Object.values(report.countsByClassification).reduce((sum, count) => sum + count, 0), report.fileCount);
});

test("rejects unknown keys, invalid categories, and invalid dispositions", () => {
  assertRejected((candidate) => { candidate.untrusted = true; }, "invalid_top_level_unknown_key");
  assertRejected((candidate) => { candidate.entries[0].classification = "published"; }, "classification_invalid");
  assertRejected((candidate) => { candidate.entries[0].disposition = "compatibility"; }, "disposition_invalid");
  assertRejected((candidate) => { candidate.entries[0].disposition = "replace-and-delete"; delete candidate.entries[0].futureProjectPath; }, "future_project_path_required");
  const replaceAndDelete = clone();
  replaceAndDelete.entries[0].disposition = "replace-and-delete";
  assert.equal(validateToolInventory(replaceAndDelete, { trackedPaths }).countsByDisposition["replace-and-delete"], 1);
});

test("rejects missing, stale, duplicate, and unsafe governed paths", () => {
  assertRejected((candidate) => { candidate.entries.pop(); }, "coverage_mismatch");
  assertRejected((candidate) => { candidate.entries[0].path = "tools/run-stardew-not-tracked.mjs"; }, "coverage_mismatch");
  assertRejected((candidate) => { candidate.trackedPathBaseline.push("tools/run-stardew-new-root-tool.mjs"); }, "tracked_path_baseline_mismatch");
  assertRejected((candidate) => { candidate.trackedPathBaseline = candidate.trackedPathBaseline.slice(1); }, "tracked_path_baseline_mismatch");
  assertRejected((candidate) => { candidate.entries[1].path = candidate.entries[0].path; }, "entry_path_duplicate");
  assertRejected((candidate) => { candidate.entries[0].path = "tools/../run-stardew-unsafe.mjs"; }, "entry_path_not_governed");
});

test("rejects a newly tracked governed root tool even when inventory classifies it", () => {
  const candidate = clone();
  const newPath = "tools/run-stardew-new-root-tool.mjs";
  candidate.entries.push({
    path: newPath,
    classification: "diagnostic",
    disposition: "diagnostic-only",
    futureProjectPath: "diagnostics/run-stardew-new-root-tool.mjs",
  });
  assert.throws(
    () => validateToolInventory(candidate, { trackedPaths: [...trackedPaths, newPath] }),
    /tracked_path_baseline_mismatch/,
  );
});

test("rejects closure expansion or case-folded duplication", () => {
  assertRejected((candidate) => { candidate.pilotLegacyClosure.push("tools/new-root-dependency.mjs"); }, "pilot_closure_expanded_or_changed");
  assertRejected((candidate) => { candidate.pilotLegacyClosure[1] = candidate.pilotLegacyClosure[0].toUpperCase(); }, "pilot_closure_duplicate");
});

test("rejects a closure dependency outside the frozen tools closure and accepts an in-closure dependency", async () => {
  const root = await mkdtemp(join(tmpdir(), "stardew-tool-inventory-"));
  await mkdir(join(root, "tools", "lib"), { recursive: true });
  await mkdir(join(root, "host", "scripts"), { recursive: true });
  const files = new Map([
    ["tools/run-stardew-native-local-player-equip-tool-smoke.mjs", 'import "./lib/stardew-native-smoke-harness-v1.mjs";'],
    ["tools/lib/stardew-native-smoke-harness-v1.mjs", ""],
  ]);
  for (const entry of inventory.pilotLegacyClosure) await writeFile(join(root, entry), files.get(entry) ?? "", "utf8");
  await writeFile(join(root, "tools/outside.mjs"), "", "utf8");
  const candidate = clone();
  const readFile = (filePath) => {
    if (filePath.endsWith("run-stardew-native-local-player-equip-tool-smoke.mjs")) return 'import "./outside.mjs";';
    if (filePath.endsWith("tools/lib/stardew-native-smoke-harness-v1.mjs")) return "";
    return "";
  };
  assert.throws(
    () => validateToolInventory(candidate, { trackedPaths, repositoryRoot: root, readFile }),
    /pilot_closure_dependency_outside_frozen_closure/,
  );

  const acceptedReadFile = (filePath) => {
    if (filePath.endsWith("run-stardew-native-local-player-equip-tool-smoke.mjs")) return 'import "./lib/stardew-native-smoke-harness-v1.mjs";';
    return "";
  };
  assert.doesNotThrow(() => validateToolInventory(candidate, { trackedPaths, repositoryRoot: root, readFile: acceptedReadFile }));
});
