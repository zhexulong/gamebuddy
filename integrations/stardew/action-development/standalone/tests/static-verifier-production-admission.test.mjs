import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runProductionStaticAdmission } from "../static-verifier/verify-production-admission.mjs";
import { createBlockedManifestReport } from "../static-verifier/production-verifier.mjs";

const blockedReport = createBlockedManifestReport("current.json");
const obsoleteInlineFixture = {
  schema: "gamebuddy-stardew-static-verifier-production-report/v1",
  verifierId: "gamebuddy.stardew.action-development.static-verifier.production@v1",
  inputId: "current.json",
  publicationId: null,
  scope: "target-publication",
  artifactRoot: "unavailable",
  state: "blocked",
  reasonCode: "blocked_target_publication_manifest_missing",
  summary: { passed: 0, failed: 0, blocked: 1, passDenominator: 0 },
  artifacts: { required: [], present: [], missing: [], unusable: [] },
  digests: { required: [], verified: [], mismatched: [], unreadable: [] },
  identity: { required: [], verified: [], mismatched: [] },
  contract: { executed: false, executable: "dotnet", shell: false, exitCode: null, signal: null, timeout: false, args: [], stderr: "" },
  checks: [
    { id: "target-publication-manifest", kind: "target_publication_manifest_admission", state: "blocked", reasonCode: "blocked_target_publication_manifest_missing" },
    { id: "target-publication-artifact-closure", kind: "target_publication_artifact_closure", state: "not_run", reasonCode: null },
    { id: "target-publication-digest", kind: "target_publication_artifact_digest", state: "not_run", reasonCode: null },
    { id: "target-publication-identity", kind: "target_publication_identity_provenance", state: "not_run", reasonCode: null },
    { id: "target-publication-contract", kind: "target_publication_contract_execution", state: "not_run", reasonCode: null },
  ],
  integration: {
    status: "package-admission-integrated",
    required: [
      "the package portfolio consumes production admission while preserving passed, failed, and named blocked evidence",
      "supply the independently published target-publication manifest and artifact closure from the target-version build gate with preserved provenance",
      "the production report is static authority evidence only and never claims live or release evidence",
    ],
  },
};
void obsoleteInlineFixture;

function fakeSpawn({ code, stderr = "", report = blockedReport }) {
  return (_command, _args, options) => {
    assert.equal(options.shell, false);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.end(`${JSON.stringify(report)}\n`);
      child.stderr.end(stderr);
      child.emit("close", code, null);
    });
    return child;
  };
}

test("named missing target publication remains blocked evidence without failing deterministic admission", async () => {
  const report = await runProductionStaticAdmission({ spawnProcess: fakeSpawn({ code: 2 }) });
  assert.equal(report.state, "blocked");
  assert.equal(report.reasonCode, "blocked_missing_target_publication_manifest");
  assert.equal(report.summary.passDenominator, 0);
});

test("failed, malformed, or contradictory verifier outcomes fail deterministic admission", async () => {
  await assert.rejects(() => runProductionStaticAdmission({ spawnProcess: fakeSpawn({ code: 1 }) }), /process_failed/);
  await assert.rejects(() => runProductionStaticAdmission({ spawnProcess: fakeSpawn({ code: 0, report: blockedReport }) }), /state_mismatch/);
  await assert.rejects(() => runProductionStaticAdmission({ spawnProcess: fakeSpawn({ code: 2, stderr: "unexpected" }) }), /process_failed/);
});
