import assert from "node:assert/strict";
import test from "node:test";
import { validateDirectGameplaySurfaceReport } from "./check-stardew-gameplay-completeness.mjs";

const knownBasis = ["harvest_crop", "chop_tree_source", "pickup_item"];
const catalog = { records: knownBasis.map((basisPrimitiveId) => ({ basisPrimitiveIds: [basisPrimitiveId] })) };

function graph(overrides = {}) {
  return {
    schemaVersion: 1,
    state: "complete",
    ingressRoots: [{ ingressId: "world_action_interaction", classification: "command_path" }],
    reachableEdges: [
      {
        edgeId: "StardewValley.Game1.UpdateControlInput/world_action_interaction->Game1.pressActionButton",
        from: "StardewValley.Game1.UpdateControlInput:world_action_interaction",
        to: "Game1.pressActionButton",
        classification: "command_path",
      },
    ],
    commandPathCandidates: [],
    commandPaths: [
      {
        prcpId: "stardew-1.6.15/farmhand/world_action/hoedirt/ready_grab_crop/harvest@v1",
        ingressId: "world_action_interaction",
        nativeRuleBoundary: "HoeDirt.performUseAction -> Crop.harvest",
        route: {
          kind: "primitive",
          basisPrimitiveId: "harvest_crop",
          nativeEquivalenceEvidence: "same HoeDirt.performUseAction -> Crop.harvest native rule boundary",
        },
      },
    ],
    supportingPaths: [
      {
        parentCommandPathId: "stardew-1.6.15/farmhand/world_action/hoedirt/ready_grab_crop/harvest@v1",
        reason: "Crop harvest animation and inventory settlement are not independently player-selectable commands.",
      },
    ],
    nonGameplayPaths: [{ reason: "audio cue has no gameplay-rule transition." }],
    unknownReachableEdges: [],
    pendingCommandCandidates: [],
    ...overrides,
  };
}

function report(overrides = {}) {
  return {
    state: "inspected",
    target: { version: "1.6.15", build: 24356 },
    assembly: { fileVersion: "1.6.15.24356", sha256: "a".repeat(64), lengthBytes: 123 },
    attestation: { extractedAtUtc: "2026-01-01T00:00:00.000Z" },
    decompilation: { tool: "ilspycmd", toolVersion: "9.1", configurationDigest: "b".repeat(64) },
    sourceSnapshot: { contentManifestSha256: "c".repeat(64) },
    content: { contentHashesSha256: "d".repeat(64), relevantAssetManifestSha256: "e".repeat(64) },
    playerCommandGraph: graph(),
    ...overrides,
  };
}

test("player-command validation accepts an attested complete bounded audit with typed primitive equivalence", () => {
  const result = validateDirectGameplaySurfaceReport(report(), catalog);
  assert.deepEqual(result.errors, []);
  assert.equal(result.details.commandPaths, 1);
});

test("player-command validation rejects unresolved ingress-reachable edges and pending command candidates", () => {
  const result = validateDirectGameplaySurfaceReport(
    report({
      playerCommandGraph: graph({
        state: "partial",
        reachableEdges: [
          {
            edgeId: "StardewValley.Game1.UpdateControlInput/world_action_interaction->GameLocation.checkAction",
            from: "StardewValley.Game1.UpdateControlInput:world_action_interaction",
            to: "GameLocation.checkAction",
            classification: "candidate_dispatch_edge",
          },
        ],
        unknownReachableEdges: [{ ingressId: "world_action_interaction", reason: "unresolved_virtual_target" }],
        pendingCommandCandidates: [{ ingressId: "world_tool_use", reason: "native_boundary_not_reconstructed" }],
      }),
    }),
    catalog,
  );
  assert.match(result.errors.join("\n"), /graph state is partial/);
  assert.match(result.errors.join("\n"), /ingress-reachable graph edges are unresolved/);
  assert.match(result.errors.join("\n"), /ingress-reachable graph edges are unknown/);
  assert.match(result.errors.join("\n"), /command candidates have not reached a native rule boundary/);
});

test("source-derived command-boundary candidates require source-edge provenance", () => {
  const invalid = graph({
    commandPathCandidates: [
      {
        candidateId: "world.check_action",
        ingressId: "world_action_interaction",
        semanticFamily: "world_interaction",
        nativeRuleBoundaryCandidate: "GameLocation.checkAction",
        status: "boundary_candidate",
      },
    ],
  });
  const result = validateDirectGameplaySurfaceReport(report({ playerCommandGraph: invalid }), catalog);
  assert.match(
    result.errors.join("\n"),
    /command-boundary candidates have invalid identity or native boundary evidence/,
  );
});

test("source-derived branch candidates reject incomplete source-fragment evidence", () => {
  const invalid = graph({
    commandPathCandidates: [
      {
        candidateId: "forage.pickup_spawned_object",
        ingressId: "world_action_interaction",
        semanticFamily: "forage_pickup",
        nativeRuleBoundaryCandidate: "GameLocation.checkAction -> native forage inventory delivery/removal",
        sourceEdgeIds: ["StardewValley.Game1.tryToCheckAt->StardewValley.GameLocation.checkAction"],
        sourceEvidence: {
          sourceType: "StardewValley.GameLocation",
          sourceFile: "StardewValley/GameLocation.cs",
          sourceMethod: "checkAction",
          requiredFragments: [],
        },
        status: "boundary_candidate",
      },
    ],
  });
  const result = validateDirectGameplaySurfaceReport(report({ playerCommandGraph: invalid }), catalog);
  assert.match(
    result.errors.join("\n"),
    /command-boundary candidates have invalid identity or native boundary evidence/,
  );
});

test("source-derived command candidates reject missing source evidence and duplicate IDs", () => {
  const invalid = graph({
    commandPathCandidates: [
      {
        candidateId: "map.action_property.case.literal.Mine",
        ingressId: "world_action_interaction",
        semanticFamily: "map_operation",
        nativeRuleBoundaryCandidate: "GameLocation.performAction selector Mine",
        sourceEdgeIds: ["edge"],
        sourceEvidence: {
          sourceType: "StardewValley.GameLocation",
          sourceFile: "StardewValley/GameLocation.cs",
          sourceMethod: "performAction",
          requiredFragments: ["case:Mine"],
          anchorPositions: {},
        },
        status: "boundary_candidate",
      },
      {
        candidateId: "map.action_property.case.literal.Mine",
        ingressId: "world_action_interaction",
        semanticFamily: "map_operation",
        nativeRuleBoundaryCandidate: "GameLocation.performAction selector Mine",
        sourceEdgeIds: ["edge"],
        status: "boundary_candidate",
      },
    ],
  });
  const result = validateDirectGameplaySurfaceReport(report({ playerCommandGraph: invalid }), catalog);
  assert.match(
    result.errors.join("\n"),
    /command-boundary candidates have invalid identity or native boundary evidence/,
  );
  assert.match(result.errors.join("\n"), /Duplicate source-derived command-boundary candidate IDs/);
});

test("source-derived bridge equivalence gaps fail the completeness gate", () => {
  const result = validateDirectGameplaySurfaceReport(
    {
      ...report(),
      bridgeEquivalenceAudit: [
        {
          candidateId: "forage.pickup_spawned_object",
          state: "bridge_equivalence_gap",
          missingGuards: [{ id: "not_on_bridge" }],
        },
      ],
    },
    catalog,
  );
  assert.match(result.errors.join("\n"), /bridge equivalence audits have unresolved guard gaps/);
});

test("command paths fail closed without a canonical ID, native boundary, or known typed route", () => {
  const invalid = graph({
    commandPaths: [
      {
        prcpId: "",
        ingressId: "world_action_interaction",
        nativeRuleBoundary: "",
        route: { kind: "primitive", basisPrimitiveId: "invented_action", nativeEquivalenceEvidence: "" },
      },
    ],
  });
  const result = validateDirectGameplaySurfaceReport(report({ playerCommandGraph: invalid }), catalog);
  assert.match(
    result.errors.join("\n"),
    /command paths lack a canonical PRCP identity, native boundary, or typed bridge equivalence route/,
  );
});

test("command paths reject UI/input/raw-dispatch bridge routes", () => {
  const invalid = graph({
    commandPaths: [
      {
        ...graph().commandPaths[0],
        route: {
          kind: "primitive",
          basisPrimitiveId: "harvest_crop",
          nativeEquivalenceEvidence: "mouse click menu then arbitrary action string",
        },
      },
    ],
  });
  const result = validateDirectGameplaySurfaceReport(report({ playerCommandGraph: invalid }), catalog);
  assert.match(result.errors.join("\n"), /prohibited UI\/input\/raw-dispatch bridge terms/);
});

test("complete graphs must bind supporting paths to a command path, while partial discovery reports may keep the parent pending", () => {
  const invalid = graph({ supportingPaths: [{ reason: "helper" }] });
  const invalidResult = validateDirectGameplaySurfaceReport(report({ playerCommandGraph: invalid }), catalog);
  assert.match(invalidResult.errors.join("\n"), /supporting paths lack an auditable parent command path or reason/);

  const partial = graph({
    state: "partial",
    supportingPaths: [{ reason: "helper", parentCommandPathId: null }],
    pendingCommandCandidates: [{ ingressId: "world_action_interaction" }],
  });
  const partialResult = validateDirectGameplaySurfaceReport(report({ playerCommandGraph: partial }), catalog);
  assert.doesNotMatch(
    partialResult.errors.join("\n"),
    /supporting paths lack an auditable parent command path or reason/,
  );
  assert.match(partialResult.errors.join("\n"), /graph state is partial/);
});

test("missing source/assembly attestation or graph fails closed", () => {
  const invalid = report();
  delete invalid.assembly.sha256;
  delete invalid.sourceSnapshot;
  delete invalid.playerCommandGraph;
  const result = validateDirectGameplaySurfaceReport(invalid, catalog);
  assert.match(result.errors.join("\n"), /assembly length\/SHA-256 attestation/);
  assert.match(result.errors.join("\n"), /decompilation\/source attestation/);
  assert.match(result.errors.join("\n"), /missing the source-derived player-command reachability graph/);
});
