import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const REGISTRY = "design/references/tavern/st-semantic-references-v1.json";

// The registry lives in the separately mounted private `design/` repository, so a checkout need not have it. Both
// readings are asserted here: with the mount the attestation must hold, and without it the gate must name the path it
// could not read and exit non-zero rather than reporting a pass over nothing.
const mounted = existsSync(new URL(`../${REGISTRY}`, import.meta.url));

test("Tavern semantic references attest the locked source, or name the mount they could not read", async () => {
  if (mounted) {
    const { stdout } = await run(process.execPath, ["tools/verify-tavern-semantic-references.mjs"]);
    assert.match(stdout, /verified 9 Tavern semantic references and 2 fixtures/);
    return;
  }
  const failure = await run(process.execPath, ["tools/verify-tavern-semantic-references.mjs"]).catch((error) => error);
  const lines = String(failure.stdout ?? "")
    .trim()
    .split("\n");
  assert.equal(failure.code, 2, `expected the not-measured exit, got ${failure.code}: ${lines.join(" ")}`);
  assert.ok(lines[0].startsWith(`blocked: ${REGISTRY} absent`), `expected the absent registry named, got: ${lines[0]}`);
  // The report is what `tools/check-harness-conformance.mjs` reads and what `tools/lib/assert-non-vacuous.mjs` judges:
  // without it the run is `falsifier_signature_missing`, and with a zero and no reason it is `gate_measured_nothing`.
  const report = JSON.parse(lines[1]);
  assert.equal(report.status, "blocked");
  assert.equal(report.examined, 0);
  assert.equal(report.input, REGISTRY);
  assert.ok(report.allowEmpty.includes(REGISTRY), "the empty population states which input is missing");
  assert.deepEqual(report.checks, [{ id: "reference_registry_readable", status: "blocked" }]);
});
