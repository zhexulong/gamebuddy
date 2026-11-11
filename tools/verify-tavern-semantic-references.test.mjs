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
  const line = String(failure.stdout ?? "").trim();
  assert.equal(failure.code, 2, `expected the not-measured exit, got ${failure.code}: ${line}${failure.stderr ?? ""}`);
  assert.ok(line.startsWith(`blocked: ${REGISTRY} absent`), `expected the absent registry named, got: ${line}`);
});
