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

test("target publication freezes both compiled contracts and runtimeconfig siblings", () => {
  assert.deepEqual(PUBLICATION_ARTIFACTS.slice(-2).map(({ id, relativePath, assemblyIdentity }) => ({ id, relativePath, assemblyIdentity })), [
    { id: "portfolio-mine-elevator-projection-contract", relativePath: "PortfolioMineElevatorProjection.Contract.dll", assemblyIdentity: "PortfolioMineElevatorProjection.Contract" },
    { id: "portfolio-mine-elevator-projection-contract-runtime", relativePath: "PortfolioMineElevatorProjection.Contract.runtimeconfig.json", assemblyIdentity: "Microsoft.NETCore.App@6.0.0" },
  ]);
});

test("verifier executes both digest-bound contracts and records exact success receipts", async () => {
  const calls = [];
  const report = await verifyTargetPublication(manifest(), seams({ spawnCommand: spawnReceipt([
    "Farmhand capability publication identity/path/digest contract passed.",
    "Portfolio mine projection and direct ladder structural contract passed.",
  ], calls) }));
  assert.equal(report.state, "passed");
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.options.shell === false), true);
  assert.deepEqual(report.contract.executions.map((entry) => entry.successReceipt), [
    "Farmhand capability publication identity/path/digest contract passed.",
    "Portfolio mine projection and direct ladder structural contract passed.",
  ]);
  assert.deepEqual(calls[1].args.slice(1, 3), ["--expected-sha256", sha("gamebuddy-stardew-mod")]);
});

test("second contract output, digest, and identity failures fail closed", async () => {
  const wrongOutput = await verifyTargetPublication(manifest(), seams({ spawnCommand: spawnReceipt(["Farmhand capability publication identity/path/digest contract passed.", "wrong"], []) }));
  assert.equal(wrongOutput.reasonCode, "failed_target_publication_contract_output");
  const digestMismatch = await verifyTargetPublication(manifest(), seams({ hashFile: () => "0".repeat(64) }));
  assert.equal(digestMismatch.reasonCode, "failed_target_publication_digest_mismatch");
  const drifted = structuredClone(manifest());
  drifted.artifacts[4].assemblyIdentity = "Other.Contract";
  const identityMismatch = await verifyTargetPublication(drifted, seams());
  assert.equal(identityMismatch.reasonCode, "failed_target_publication_identity_mismatch");
});
