import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { enumerateNativeInteractionMechanisms } from "./lib/stardew-native-interaction-mechanisms.mjs";
import { validateNativeTransitionLedger } from "./lib/stardew-native-transition-ledger.mjs";

const fixture = `
namespace Fixture;
class Base { public virtual bool performAction(string[] parts) { return false; } }
interface IRunner { void Run(); }
class Derived : Base {
  public event System.Action Updated;
  public override bool performAction(string[] parts) {
    DataLoader.Example(content);
    delayedActions.Add(new DelayedAction());
    return base.performAction(parts);
  }
}
`;

test("enumerates neutral host, content, and continuation syntax without inferring transitions", async () => {
  const report = await enumerateNativeInteractionMechanisms([{ relativePath: "Fixture/Derived.cs", text: fixture }]);
  assert.equal(report.sourceFileCount, 1);
  assert.equal(report.parseGaps.length, 0);
  assert.ok(
    report.mechanisms.some((row) => row.family === "host:performAction" && row.lexicalOwnerSyntax === "Derived"),
  );
  assert.ok(report.mechanisms.some((row) => row.family === "content:dataloader"));
  assert.ok(
    report.mechanisms.some((row) => row.family === "content:dataloader" && row.lexicalMemberSyntax === "performAction"),
  );
  assert.ok(report.mechanisms.some((row) => row.family === "continuation:delayed"));
  assert.ok(report.mechanisms.some((row) => row.family === "structural:event_field_declaration"));
  assert.equal(JSON.stringify(report).includes("primitiveId"), false);
});
test("allows a source transition ledger anchor to bind to an exact enumerated source hash", async () => {
  await enumerateNativeInteractionMechanisms([{ relativePath: "Fixture/Derived.cs", text: fixture }]);
  const fileSha256 = createHash("sha256").update(fixture).digest("hex");
  const startByte = fixture.indexOf("performAction");
  const endByte = startByte + "performAction".length;
  const slice = Buffer.from(fixture).subarray(startByte, endByte);
  const anchor = {
    sourcePath: "Fixture/Derived.cs",
    member: "Derived.performAction",
    startByte,
    endByte,
    sourceSliceSha256: createHash("sha256").update(slice).digest("hex"),
    sourceFileSha256: fileSha256,
  };
  const node = {
    transitionId: "transition:fixture",
    kind: "source_owned_transition",
    incomingMechanismIds: ["mechanism:fixture"],
    handoffs: [
      {
        toTransitionId: "transition:boundary",
        kind: "external",
        sequence: 0,
        handoffAnchor: anchor,
        condition: "always",
        phase: "after_commit",
      },
    ],
    exitCoverage: "exhaustive",
    ownerAnchor: anchor,
    commitAnchor: anchor,
    postStateObservations: [{ ownerSyntax: "Derived", stateSyntax: "fixtureState", anchor }],
    pendingNativeContinuationState: [],
    possiblyGameplayBearing: true,
  };
  const boundary = {
    transitionId: "transition:boundary",
    kind: "scope_exclusion_boundary",
    incomingMechanismIds: [],
    handoffs: [],
    exitCoverage: "exhaustive",
    boundaryAnchor: anchor,
    boundaryKind: "fixture",
    scopeDisposition: "out_of_scope",
    scopeReason: "fixture",
    scopeManifestBoundaryId: "scope:fixture",
    possiblyGameplayBearing: false,
    nonGameplayReason: "fixture",
    nonGameplayReasonAnchor: anchor,
  };
  node.exitInventory = [{ exitId: "exit:0", kind: "handoff", handoffSequence: 0, anchor }];
  const attestation = { targetAssemblySha256: "a".repeat(64), sourceManifestSha256: "b".repeat(64) };
  const scopeManifest = {
    schemaVersion: 1,
    artifactKind: "native_transition_scope_manifest",
    attestation,
    scope: "normal_player_vanilla",
    exclusionBoundaries: [
      { boundaryId: "scope:fixture", boundaryKind: "fixture", scopeReason: "fixture", sourceAnchor: anchor },
    ],
  };
  assert.equal(
    validateNativeTransitionLedger(
      {
        schemaVersion: 2,
        artifactKind: "native_transition_continuation_ledger",
        attestation,
        closureState: "partial",
        scopedMechanismIds: ["mechanism:fixture"],
        transitions: [node, boundary],
        rootBindings: [{ mechanismId: "mechanism:fixture", transitionId: "transition:fixture" }],
      },
      {
        expectedMechanismIds: ["mechanism:fixture"],
        sourceFiles: { "Fixture/Derived.cs": { sha256: fileSha256, text: fixture } },
        scopeManifest,
      },
    ).transitionCount,
    2,
  );
});
test("retains parse failures as explicit gaps instead of silently skipping a source file", async () => {
  const report = await enumerateNativeInteractionMechanisms([
    { relativePath: "Fixture/Broken.cs", text: "class Broken { void M( {" },
  ]);
  assert.equal(report.parseGaps.length, 1);
  assert.equal(report.mechanisms.filter((row) => row.category === "host-declaration-syntax").length, 0);
});
test("retains non-overlapping host syntax from parse gaps and non-polymorphic declarations", async () => {
  const partial = await enumerateNativeInteractionMechanisms([
    { relativePath: "Fixture/Partial.cs", text: "class Partial { public void Save() {} void Broken( { }" },
  ]);
  assert.deepEqual(
    partial.mechanisms.filter((row) => row.family === "host:Save").map((row) => row.fileSyntaxState),
    ["partial_syntax_only"],
  );
  const plain = await enumerateNativeInteractionMechanisms([
    { relativePath: "Fixture/Save.cs", text: "class Save { public void Save() {} public void UpdateEarly() {} }" },
  ]);
  assert.deepEqual(
    plain.mechanisms
      .filter((row) => row.category === "host-declaration-syntax")
      .map((row) => [row.family, row.declarationShape]),
    [
      ["host:Save", "non-polymorphic-syntax"],
      ["host:UpdateEarly", "non-polymorphic-syntax"],
    ],
  );
});
test("rejects duplicate source records", async () => {
  await assert.rejects(
    () =>
      enumerateNativeInteractionMechanisms([
        { relativePath: "Fixture/A.cs", text: fixture },
        { relativePath: "Fixture/A.cs", text: fixture },
      ]),
    { code: "mechanism_source_duplicate" },
  );
});
