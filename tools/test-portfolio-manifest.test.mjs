import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MANIFEST_SCHEMA,
  readAndValidateTestPortfolioManifest,
  validateTestPortfolioManifest,
} from "./test-portfolio-manifest.mjs";

const sourceManifest = JSON.parse(
  await readFile(new URL("../.ci/test-portfolio-manifest.v1.json", import.meta.url), "utf8"),
);
const clone = () => structuredClone(sourceManifest);
const entryIndex = (id) => sourceManifest.entries.findIndex((entry) => entry.id === id);
const STATIC_ENTRY_INDEX = entryIndex("p1.8-portfolio-isolation-static");
const MANUAL_ENTRY_INDEX = entryIndex("p1.8-live-environment-diagnostic");

function assertInvalid(manifest, expected) {
  const result = validateTestPortfolioManifest(manifest);
  assert.equal(result.valid, false, `expected invalid manifest: ${expected}`);
  assert.ok(
    result.errors.some((error) => error.includes(expected)),
    `${expected} not found in ${result.errors.join(", ")}`,
  );
}

test("versioned seed manifest is strict and truthful", async () => {
  assert.equal(sourceManifest.schema, MANIFEST_SCHEMA);
  assert.equal(sourceManifest.entries.length, 3);
  const result = await readAndValidateTestPortfolioManifest();
  assert.deepEqual(result, { valid: true, errors: [] });
  for (const entry of sourceManifest.entries) {
    if (entry.evidenceKind !== "automated" && entry.evidenceKind !== "live") {
      assert.deepEqual(entry.requiredOn, ["manual"]);
      assert.equal(entry.command, null);
      assert.equal(entry.timeoutSeconds, null);
      assert.equal(entry.retryPolicy, null);
    }
  }
});

test("rejects unknown keys at root and entry levels", () => {
  const root = clone();
  root.unexpected = true;
  assertInvalid(root, "manifest_unknown_key:unexpected");
  const entry = clone();
  entry.entries[0].unexpected = true;
  assertInvalid(entry, "entry[0]_unknown_key:unexpected");
  const retry = clone();
  retry.entries[0].retryPolicy.unexpected = true;
  assertInvalid(retry, "retryPolicy_unknown_key:unexpected");
});

test("rejects duplicate ids, unknown dependencies, and cycles", () => {
  const duplicate = clone();
  duplicate.entries[1].id = duplicate.entries[0].id;
  assertInvalid(duplicate, "duplicate_id:");
  const unknown = clone();
  unknown.entries[0].requires = ["not-declared"];
  assertInvalid(unknown, "requires_unknown:not-declared");
  const cycle = clone();
  cycle.entries[0].requires = [cycle.entries[1].id];
  cycle.entries[1].requires = [cycle.entries[0].id];
  assertInvalid(cycle, "requires_cycle:");
});

test("rejects duplicate trigger paths", () => {
  const manifest = clone();
  manifest.entries[2].triggerPaths = [manifest.entries[0].triggerPaths[0]];
  assertInvalid(manifest, "duplicate_trigger_path:");
});

test("rejects unsafe commands and path traversal", () => {
  const command = clone();
  command.entries[0].command = "node -e process.exit(1)";
  assertInvalid(command, "command_unsafe_command");
  const executable = clone();
  executable.entries[0].command = "bash tools/test-portfolio-manifest.test.mjs";
  assertInvalid(executable, "command_executable_not_allowlisted");
  for (const option of [
    "-e",
    "--eval",
    "-p",
    "--print",
    "-r",
    "--require",
    "--import",
    "--loader",
    "--inspect",
    "--inspect-brk",
    "--inspect-port",
  ]) {
    const unsafe = clone();
    unsafe.entries[0].command = `node ${option}=payload tools/test-portfolio-manifest.test.mjs`;
    assertInvalid(unsafe, "command_module_loader_eval_inspect_forbidden");
  }
  const shortAttached = clone();
  shortAttached.entries[0].command = "node -rfoo tools/test-portfolio-manifest.test.mjs";
  assertInvalid(shortAttached, "command_module_loader_eval_inspect_forbidden");
  const path = clone();
  path.entries[0].triggerPaths = ["../outside.mjs"];
  assertInvalid(path, "triggerPaths[0]_unsafe_path");
});

test("rejects invalid evidence combinations and manual diagnostics pretending to automate", () => {
  const staticLive = clone();
  staticLive.entries[STATIC_ENTRY_INDEX].liveGate = "required";
  assertInvalid(staticLive, "static_or_fixture_cannot_be_live");
  const fixtureLive = clone();
  fixtureLive.entries[STATIC_ENTRY_INDEX].evidenceKind = "fixture";
  fixtureLive.entries[STATIC_ENTRY_INDEX].liveGate = "required";
  assertInvalid(fixtureLive, "static_or_fixture_cannot_be_live");
  const liveNotGated = clone();
  liveNotGated.entries[0].evidenceKind = "live";
  assertInvalid(liveNotGated, "live_evidence_requires_live_gate");
  const manualRequired = clone();
  manualRequired.entries[MANUAL_ENTRY_INDEX].requiredOn = ["main"];
  assertInvalid(manualRequired, "manual_diagnostic_requires_manual_trigger");
});

test("rejects zero, fractional, and unbounded required automated timeouts and retries", () => {
  for (const timeoutSeconds of [0, -1, Number.POSITIVE_INFINITY, 3601, 1.5]) {
    const manifest = clone();
    manifest.entries[0].timeoutSeconds = timeoutSeconds;
    assertInvalid(manifest, "timeoutSeconds_must_be_bounded_positive_seconds");
  }
  const retry = clone();
  retry.entries[0].retryPolicy.maxAttempts = 99;
  assertInvalid(retry, "retryPolicy_maxAttempts_must_be_bounded");
  const backoff = clone();
  backoff.entries[0].retryPolicy.backoffSeconds = -1;
  assertInvalid(backoff, "retryPolicy_backoffSeconds_invalid");
});

test("rejects non-automated entries that claim automated or PR/main gating", () => {
  for (const [candidateEntryIndex, evidenceKind] of [
    [STATIC_ENTRY_INDEX, "static"],
    [STATIC_ENTRY_INDEX, "fixture"],
    [MANUAL_ENTRY_INDEX, "manual-diagnostic"],
  ]) {
    for (const requiredOn of [["pull_request"], ["main"], ["pull_request", "manual"], ["main", "manual"]]) {
      const manifest = clone();
      manifest.entries[candidateEntryIndex].evidenceKind = evidenceKind;
      manifest.entries[candidateEntryIndex].requiredOn = requiredOn;
      assertInvalid(manifest, "non_automated_requires_manual_only");
    }
  }
  const automated = clone();
  automated.entries[0].requiredOn = ["manual"];
  automated.entries[0].command = null;
  assertInvalid(automated, "command_must_be_non_empty");
  const live = clone();
  live.entries[0].evidenceKind = "live";
  live.entries[0].liveGate = "required";
  live.entries[0].timeoutSeconds = null;
  assertInvalid(live, "timeoutSeconds_must_be_bounded_positive_seconds");
});

test("rejects missing or non-regular trigger files during repository validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-portfolio-manifest-"));
  try {
    const manifestPath = join(root, "manifest.json");
    const manifest = clone();
    manifest.entries[0].triggerPaths = ["missing-trigger.mjs"];
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const result = await readAndValidateTestPortfolioManifest(manifestPath, root);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes("must_exist_as_regular_file")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects trigger files escaping through a parent symlink or junction", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-portfolio-manifest-link-"));
  const outside = await mkdtemp(join(tmpdir(), "gamebuddy-portfolio-manifest-outside-"));
  try {
    await writeFile(join(outside, "trigger.mjs"), "export {};\n");
    const linked = join(root, "linked");
    try {
      await symlink(outside, linked, "junction");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") return;
      throw error;
    }
    const manifest = clone();
    manifest.entries[0].triggerPaths = ["linked/trigger.mjs"];
    const manifestPath = join(root, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const result = await readAndValidateTestPortfolioManifest(manifestPath, root);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes("must_be_canonical_file")));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects command, timeout, and retry metadata on diagnostics/static evidence", () => {
  for (const field of ["command", "timeoutSeconds", "retryPolicy"]) {
    const manifest = clone();
    manifest.entries[2][field] = field === "command" ? "node test.mjs" : field === "timeoutSeconds" ? 1 : {};
    assertInvalid(
      manifest,
      `${field === "timeoutSeconds" ? "timeout_must_be_null" : `${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_must_be_null`}_for_non_automated`,
    );
  }
});
