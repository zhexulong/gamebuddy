import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
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
  assert.equal(report.pilotLegacyClosureCount, 13);
  assert.equal(Object.values(report.countsByClassification).reduce((sum, count) => sum + count, 0), report.fileCount);
});

test("rejects unknown keys, invalid categories, and invalid dispositions", () => {
  assertRejected((candidate) => { candidate.untrusted = true; }, "invalid_top_level_unknown_key");
  assertRejected((candidate) => { candidate.entries[0].classification = "published"; }, "classification_invalid");
  assertRejected((candidate) => { candidate.entries[0].disposition = "compatibility"; }, "disposition_invalid");
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
