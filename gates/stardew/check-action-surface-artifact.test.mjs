#!/usr/bin/env node
/**
 * Falsifier for `check-action-surface-artifact.mjs`.
 *
 * The gate delegates to the package's own reader, so the fault it can be shown to catch is the artifact the package
 * would export. The injection happens in a COPY of the package under the OS temp directory - the two modules the reader
 * imports, the reader itself, and the artifact - which is also why the gate has a `--package` flag: the reading is the
 * same one it performs on the shipped artifact, pointed at a package whose artifact carries the defect.
 *
 * red-proof: inject  `use_mine_ladder.expectedTargetId.description` padded to 595 characters -> exit 1,
 *   `stardew_action_surface_artifact_refused: stardew_action_surface_bounds`; the unmodified copy reports
 *   `actions examined 106` and exits 0 (gates/stardew/check-action-surface-artifact.test.mjs)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, "check-action-surface-artifact.mjs");
const PACKAGE = path.resolve(HERE, "..", "..", "integrations", "stardew", "action-development");
const ARTIFACT = path.join("contracts", "generated", "action-surface.v1.json");
const READER_MODULES = Object.freeze([
  "action-surface-check.mjs",
  "action-projection-check.mjs",
  "action-surface.mjs",
  "package-safe-reader.mjs",
]);

/** A throwaway package carrying the reader and the artifact, so a fault can be injected into the bytes it reads. */
function stagingPackage() {
  const root = mkdtempSync(path.join(tmpdir(), "action-surface-artifact-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.dirname(path.join(root, ARTIFACT)), { recursive: true });
  for (const module of READER_MODULES) cpSync(path.join(PACKAGE, "src", module), path.join(root, "src", module));
  cpSync(path.join(PACKAGE, ARTIFACT), path.join(root, ARTIFACT));
  return root;
}

function runGate(root) {
  const result = spawnSync(process.execPath, [GATE, "--package", root], { encoding: "utf8" });
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

test("the shipped artifact is read by its own reader, and the gate prints how many actions it examined", () => {
  const root = stagingPackage();
  try {
    const run = runGate(root);
    assert.equal(run.status, 0, `the shipped artifact must be valid; stderr: ${run.stderr}`);
    const report = JSON.parse(run.stdout.trim().split("\n").at(-1));
    assert.equal(report.status, "valid");
    assert.ok(report.actions > 0, "the shipped artifact carries actions");
    assert.match(run.stdout, new RegExp(`actions examined ${report.actions}\\b`, "u"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one argument description over the 512-character bound refuses the artifact and the gate exits 1", () => {
  const root = stagingPackage();
  try {
    const artifactPath = path.join(root, ARTIFACT);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    const action = artifact.actions.find((entry) => entry.actionId === "use_mine_ladder");
    assert.ok(action, "the shipped artifact still declares use_mine_ladder");
    action.argumentSchema.expectedTargetId.description = "x".repeat(595);
    writeFileSync(artifactPath, JSON.stringify(artifact), "utf8");

    const run = runGate(root);
    assert.equal(run.status, 1, `a 595-character description must refuse; stdout: ${run.stdout}`);
    assert.match(run.stderr, /^stardew_action_surface_artifact_refused: stardew_action_surface_bounds$/mu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
