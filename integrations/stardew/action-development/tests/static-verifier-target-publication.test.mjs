import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { PUBLICATION_ARTIFACTS, validateTargetPublicationManifest } from "../static-verifier/production-schema.mjs";
import { verifyTargetPublication } from "../static-verifier/production-verifier.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
function manifest() {
  return validateTargetPublicationManifest({
    schema: "gamebuddy-stardew-target-publication-manifest/v1",
    verifierId: "gamebuddy.stardew.action-development.static-verifier.production@v1",
    scope: "target-publication",
    publicationId: "farmhand-capability-test",
    artifactRoot: "static-verifier/production/closures/pass",
    provenance: { buildId: "build-one" },
    artifacts: PUBLICATION_ARTIFACTS.map((entry) => ({ id: entry.id, role: entry.role, relativePath: entry.relativePath, assemblyIdentity: entry.assemblyIdentity, buildId: "build-one", sha256: sha(entry.id) })),
  });
}
function spawnReceipt(receipts, calls) {
  return (_command, args, options) => {
    calls.push({ args, options });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => { child.stdout.end(receipts[calls.length - 1]); child.stderr.end(); child.emit("close", 0, null); });
    return child;
  };
}
const seams = (extra = {}) => ({ exists: () => true, stat: () => ({ isFile: () => true, size: 1 }), hashFile: (file) => { const artifact = PUBLICATION_ARTIFACTS.find((entry) => file.endsWith(entry.relativePath)); return sha(artifact.id); }, ...extra });

test("target publication freezes the compiled contract and runtimeconfig sibling", () => {
  assert.deepEqual(PUBLICATION_ARTIFACTS.slice(-2).map(({ id, relativePath, assemblyIdentity }) => ({ id, relativePath, assemblyIdentity })), [
    { id: "capability-publication-contract", relativePath: "FarmhandCapabilityPublicationProjection.Contract.dll", assemblyIdentity: "FarmhandCapabilityPublicationProjection.Contract" },
    { id: "capability-publication-contract-runtime", relativePath: "FarmhandCapabilityPublicationProjection.Contract.runtimeconfig.json", assemblyIdentity: "Microsoft.NETCore.App@6.0.0" },
  ]);
});

test("verifier executes the digest-bound contract and records the exact success receipt", async () => {
  const calls = [];
  const report = await verifyTargetPublication(manifest(), seams({ spawnCommand: spawnReceipt([
    "Farmhand capability publication identity/path/digest contract passed.",
  ], calls) }));
  assert.equal(report.state, "passed");
  assert.equal(calls.length, 1);
  assert.equal(calls.every((call) => call.options.shell === false), true);
  assert.deepEqual(report.contract.executions.map((entry) => entry.successReceipt), [
    "Farmhand capability publication identity/path/digest contract passed.",
  ]);
  assert.deepEqual(calls[0].args.slice(1, 3), ["--expected-mod-sha256", sha("gamebuddy-stardew-mod")]);
});

test("contract output, digest, and identity failures fail closed", async () => {
  const wrongOutput = await verifyTargetPublication(manifest(), seams({ spawnCommand: spawnReceipt(["wrong"], []) }));
  assert.equal(wrongOutput.reasonCode, "failed_target_publication_contract_output");
  const digestMismatch = await verifyTargetPublication(manifest(), seams({ hashFile: () => "0".repeat(64) }));
  assert.equal(digestMismatch.reasonCode, "failed_target_publication_digest_mismatch");
  const drifted = structuredClone(manifest());
  drifted.artifacts[2].assemblyIdentity = "Other.Contract";
  const identityMismatch = await verifyTargetPublication(drifted, seams());
  assert.equal(identityMismatch.reasonCode, "failed_target_publication_identity_mismatch");
});
