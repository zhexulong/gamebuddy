import test from "node:test";
import assert from "node:assert/strict";
import { deriveStardewSemanticKernelAtlas } from "./lib/stardew-source-semantic-kernel-atlas.mjs";

function inspectionFixture(overrides = {}) {
  const inspection = {
    state: "inspected",
    target: { game: "Stardew Valley", version: "1.6.15", build: 24356 },
    assembly: {
      relativePath: "Stardew Valley.dll",
      fileVersion: "1.6.15.24356",
      lengthBytes: 42,
      sha256: "a".repeat(64),
    },
    decompilation: { tool: "ilspycmd", toolVersion: "x" },
    sourceSnapshot: { fileCount: 8, gameplaySourceFileCount: 4, contentManifestSha256: "b".repeat(64) },
    playerCommandGraph: {
      ingressRoots: [
        {
          ingressId: "world_action_interaction",
          targetMethod: "StardewValley.Game1.pressActionButton",
          classification: "command_path_candidate",
          sourceFile: "StardewValley/Game1.cs",
          sourceMethod: "UpdateControlInput",
        },
        {
          ingressId: "world_tool_use",
          targetMethod: "StardewValley.Game1.pressUseToolButton",
          classification: "command_path_candidate",
          sourceFile: "StardewValley/Game1.cs",
          sourceMethod: "UpdateControlInput",
        },
      ],
      commandPathCandidates: [
        {
          candidateId: "machine.drop_in",
          ingressId: "world_action_interaction",
          semanticFamily: "machine_or_container_load",
          nativeRuleBoundaryCandidate: "Object.performObjectDropInAction",
          sourceEvidence: { sourceFile: "StardewValley/Object.cs", sourceMethod: "performObjectDropInAction" },
          status: "boundary_candidate",
          route: null,
        },
        {
          candidateId: "machine.check",
          ingressId: "world_action_interaction",
          semanticFamily: "machine_or_container_load",
          nativeRuleBoundaryCandidate: "Object.checkForAction",
          sourceEvidence: { sourceFile: "StardewValley/Object.cs", sourceMethod: "checkForAction" },
          status: "boundary_candidate",
          route: null,
        },
        {
          candidateId: "tool.hoe",
          ingressId: "world_tool_use",
          semanticFamily: "soil_preparation",
          nativeRuleBoundaryCandidate: "Hoe.DoFunction",
          sourceEvidence: { sourceFile: "StardewValley/Tools/Hoe.cs", sourceMethod: "DoFunction" },
          status: "boundary_candidate",
          route: null,
        },
      ],
    },
    staticGameplayNodes: [
      { mappingStatus: "mapped", semanticKind: "tool_use" },
      { mappingStatus: "needs_expansion", semanticKind: "native_operation_selector" },
      { mappingStatus: "needs_expansion", semanticKind: "native_operation_selector" },
    ],
    content: {
      relevantAssetCount: 10,
      unmappedRelevantAssetCount: 2,
      contentOperationFamilies: [
        { operationFamily: "shops", mappingStatus: "needs_expansion" },
        { operationFamily: "crops", mappingStatus: "mapped" },
      ],
    },
    dataLoaderProbe: {
      gameplayTableCount: 3,
      pendingGameplayTableCount: 2,
      tables: [
        { method: "Crops", mappingStatus: "needs_expansion" },
        { method: "Objects", mappingStatus: "mapped" },
      ],
    },
  };
  return Object.assign(inspection, overrides);
}

test("derives an exhaustive discovery ledger without inferring public API equivalence", () => {
  const atlas = deriveStardewSemanticKernelAtlas(inspectionFixture());
  assert.equal(atlas.state, "source_discovery_partial");
  assert.equal(atlas.commandBoundaryEntries.length, 3);
  assert.equal(atlas.summaries.unresolvedCommandBoundaryCount, 3);
  assert.deepEqual(atlas.summaries.bySemanticFamily, [
    { key: "machine_or_container_load", count: 2 },
    { key: "soil_preparation", count: 1 },
  ]);
  assert.equal(atlas.reuseHypotheses.length, 0, "different source loci must not be silently merged");
  assert.match(atlas.coverageClaim.doesNotClaim.join(" "), /public-action equivalence/);
  assert.equal(atlas.commandBoundaryEntries[0].publicActionState, "not_inferred");
});

test("records source-locus reuse only as an unproven hypothesis", () => {
  const fixture = inspectionFixture();
  fixture.playerCommandGraph.commandPathCandidates[1].sourceEvidence.sourceMethod = "performObjectDropInAction";
  const atlas = deriveStardewSemanticKernelAtlas(fixture);
  assert.equal(atlas.reuseHypotheses.length, 1);
  assert.equal(atlas.reuseHypotheses[0].conclusion, "implementation_reuse_observed_semantic_kernel_unproven");
  assert.equal(atlas.reuseHypotheses[0].entryIds.length, 2);
});

test("fails closed for wrong target, missing attestation, malformed candidates, and duplicate IDs", () => {
  const wrongTarget = inspectionFixture({ target: { game: "Stardew Valley", version: "1.6.16", build: 24356 } });
  assert.throws(() => deriveStardewSemanticKernelAtlas(wrongTarget), {
    code: "source_semantic_kernel_atlas_evidence_invalid",
  });

  const missingHash = inspectionFixture();
  missingHash.assembly.sha256 = "not-a-hash";
  assert.throws(() => deriveStardewSemanticKernelAtlas(missingHash), {
    code: "source_semantic_kernel_atlas_evidence_invalid",
  });

  const malformed = inspectionFixture();
  delete malformed.playerCommandGraph.commandPathCandidates[0].sourceEvidence;
  assert.throws(() => deriveStardewSemanticKernelAtlas(malformed), {
    code: "source_semantic_kernel_atlas_evidence_invalid",
  });

  const missingSourceLocus = inspectionFixture();
  delete missingSourceLocus.playerCommandGraph.commandPathCandidates[0].sourceEvidence.sourceMethod;
  assert.throws(() => deriveStardewSemanticKernelAtlas(missingSourceLocus), {
    code: "source_semantic_kernel_atlas_evidence_invalid",
  });

  const unknownIngress = inspectionFixture();
  unknownIngress.playerCommandGraph.commandPathCandidates[0].ingressId = "not_a_root";
  assert.throws(() => deriveStardewSemanticKernelAtlas(unknownIngress), {
    code: "source_semantic_kernel_atlas_evidence_invalid",
  });

  const duplicate = inspectionFixture();
  duplicate.playerCommandGraph.commandPathCandidates[2].candidateId = "machine.drop_in";
  assert.throws(() => deriveStardewSemanticKernelAtlas(duplicate), {
    code: "source_semantic_kernel_atlas_evidence_invalid",
  });
});
