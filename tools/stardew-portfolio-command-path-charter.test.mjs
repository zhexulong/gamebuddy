import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assessPortfolioCommandPathCharter,
  validatePortfolioCommandPathCharter,
} from "./lib/stardew-portfolio-command-path-charter.mjs";

async function fixture() {
  return JSON.parse(await readFile(new URL("./stardew-portfolio-command-path-charter.json", import.meta.url), "utf8"));
}

test("accepts a Portfolio-first command-path charter while refusing to claim trace or capability closure", async () => {
  const model = await fixture();
  const result = validatePortfolioCommandPathCharter(model);

  assert.equal(result.modelId, "core_valley_milestone_portfolio_v1_command_path_charter");
  assert.equal(result.topology, "single_player_native_companion");
  assert.equal(result.scopeAtomCount, 10);
  assert.equal(result.traceFamilyCount, 10);
  assert.equal(result.state, "trace_derivation_in_progress");
  assert.equal(result.claims.scopeAccounted, false);
  assert.equal(result.claims.executionClosed, false);
  assert.equal(result.analysisBoundary.legacyCatalog, "forbidden_discovery_input");
  assert.equal(result.analysisBoundary.sourceRole, "per_trace_realization_and_impact_evidence_only");
});

test("rejects a charter that lets old action or catalog vocabulary select its taxonomy", async () => {
  const model = await fixture();
  model.scopeAtoms[0].actionId = "move_to_tile";

  assert.throws(() => validatePortfolioCommandPathCharter(model), {
    code: "portfolio_command_path_charter_forbidden_vocabulary",
  });
});

test("rejects a charter without a pinned Portfolio contract authority hash", async () => {
  const model = await fixture();
  model.scopeAuthority.sha256 = "not-a-hash";

  assert.throws(() => validatePortfolioCommandPathCharter(model), {
    code: "portfolio_command_path_charter_scope_invalid",
  });
});

test("rejects a charter whose declared discovery inputs include legacy taxonomy", async () => {
  const model = await fixture();
  model.taxonomyInputs.allowed = [...model.taxonomyInputs.allowed, "action_registry"];

  assert.throws(() => validatePortfolioCommandPathCharter(model), {
    code: "portfolio_command_path_taxonomy_inputs_invalid",
  });
});

test("rejects topology or candidate-evidence inheritance in a normative obligation", async () => {
  const model = await fixture();
  model.traceFamilies[0].candidateClosureRunId = "candidate_move_01";

  assert.throws(() => validatePortfolioCommandPathCharter(model), {
    code: "portfolio_command_path_charter_forbidden_vocabulary",
  });
});

test("rejects a concrete trace recording masquerading as a parameterized command-path schema", async () => {
  const model = await fixture();
  model.traceFamilies = [
    {
      traceFamilyId: "portfolio_m1_walk_recording",
      scopeAtomId: "portfolio_m1_leave_and_return",
      playerSemantic: "Walk a fixed route.",
      actorSort: "bound local Player",
      targetSort: "tile_10_10",
      parameterDomain: { kind: "concrete_recording", domainDescription: "fixed coordinate recording" },
      pathLanguage: {
        quantification: "for_each_valid_binding",
        variables: [{ name: "route", sort: "selected_native_route", cardinality: "exactly_one" }],
        bindingRules: ["route_is_bound_by_initial_fresh_scoped_observation"],
        segments: [
          { kind: "observation_boundary", phase: "initial", binds: ["route"] },
          { kind: "semantic_transition", semanticTransition: "traverse_selected_route", uses: ["route"] },
          { kind: "observation_boundary", phase: "fresh_after_traversal", binds: [] },
        ],
      },
      guardPartitions: ["ready"],
      outcomeAlgebra: ["succeeded"],
      requiredPostcondition: {
        kind: "persisted_predicate",
        sameBindingRequired: true,
        freshAfterExecutionRequired: true,
        nativeSaveReopenRereadRequired: true,
      },
      evidencePolicy: {
        topology: "single_player_native_companion",
        sameExecutionRequired: true,
        nonNullEvidenceRequired: true,
        freshPostconditionRequired: true,
        candidateClosureInheritance: "forbidden",
        crossTopologyInheritance: "forbidden",
      },
      sourceRealization: {
        status: "unknown",
        uncertaintyId: "m1_trace_pending",
        question: "not reviewed",
        disposition: "blocks_projection",
      },
      projectionState: "unprojected",
    },
  ];

  assert.throws(() => validatePortfolioCommandPathCharter(model), {
    code: "portfolio_command_path_trace_not_parameterized",
  });
});

test("rejects concrete-recording fields smuggled into a parameter domain", async () => {
  const model = await fixture();
  model.traceFamilies[0].parameterDomain.fixedTileRecording = "Farm:10,10 -> BusStop:4,7";

  assert.throws(() => validatePortfolioCommandPathCharter(model), {
    code: "portfolio_command_path_charter_unknown_field",
  });
});

test("rejects a trace grammar that replaces parameterized fresh discovery with a concrete recording", async () => {
  const model = await fixture();
  model.traceFamilies[0].pathLanguage.quantification = "one_recorded_run";

  assert.throws(() => validatePortfolioCommandPathCharter(model), {
    code: "portfolio_command_path_trace_not_parameterized",
  });
});

test("rejects projection and self-asserted realized source evidence in the pre-realization Charter", async () => {
  const unresolved = await fixture();
  unresolved.traceFamilies[0].projectionState = "primitive";
  assert.throws(() => validatePortfolioCommandPathCharter(unresolved), {
    code: "portfolio_command_path_projection_before_realization",
  });

  const assertedRealization = await fixture();
  assertedRealization.traceFamilies[0].sourceRealization = {
    status: "realized",
    targetSourceManifestSha256: "a".repeat(64),
    anchors: ["unverified:anywhere"],
    guardCommitContinuationSummary: "asserted only",
  };
  assertedRealization.traceFamilies[0].projectionState = "primitive";
  assert.throws(() => validatePortfolioCommandPathCharter(assertedRealization), {
    code: "portfolio_command_path_source_realization_invalid",
  });
});

test("rejects multiple trace families mapped to the same scope atom", async () => {
  const model = await fixture();
  model.traceFamilies[1].scopeAtomId = model.traceFamilies[0].scopeAtomId;
  assert.throws(() => validatePortfolioCommandPathCharter(model), { code: "portfolio_command_path_charter_duplicate" });
});

test("rejects an exclusion without exact omitted obligations and an admission condition", async () => {
  const model = await fixture();
  model.exclusions = [
    {
      exclusionId: "non_selected_content",
      classification: "intentionally_not_in_release_scope",
      omittedScopeAtomIds: [],
      omittedTraceFamilyIds: [],
      topology: "single_player_native_companion",
      rationale: "not selected",
      playerVisibleDisposition: "unavailable",
      nonSubstitutionRule: "No generic dispatcher or UI fallback.",
      admissionCondition: "Add a signed scope revision and trace family.",
    },
  ];

  assert.throws(() => validatePortfolioCommandPathCharter(model), { code: "portfolio_command_path_exclusion_invalid" });
});

test("rejects an approved source exclusion that omits neither its trace nor scope atom", async () => {
  const model = await fixture();
  model.exclusions = [
    {
      exclusionId: "m10_excluded",
      classification: "intentionally_not_in_release_scope",
      omittedScopeAtomIds: ["portfolio_m10_museum_collection"],
      omittedTraceFamilyIds: [],
      topology: "single_player_native_companion",
      rationale: "Separate signed scope is required for this omitted M10 extension.",
      playerVisibleDisposition: "unavailable",
      nonSubstitutionRule: "No generic dispatcher or UI fallback.",
      admissionCondition: "Add a signed scope revision and trace family.",
    },
  ];
  model.sourceImpacts = [
    {
      impactId: "m1_unrelated_impact",
      traceFamilyId: "portfolio_m1_leave_and_return_route",
      sourceAnchor: "StardewValley/Example.cs:1",
      disposition: "approved_exclusion",
      rationale: "incorrectly attempts to reuse M10 exclusion",
      exclusionId: "m10_excluded",
    },
  ];

  assert.throws(() => validatePortfolioCommandPathCharter(model), {
    code: "portfolio_command_path_source_impact_invalid",
  });
});

test("rejects duplicate omitted trace or scope identities in one exclusion", async () => {
  const model = await fixture();
  model.exclusions = [
    {
      exclusionId: "m1_duplicate_omission",
      classification: "intentionally_not_in_release_scope",
      omittedScopeAtomIds: ["portfolio_m1_leave_and_return", "portfolio_m1_leave_and_return"],
      omittedTraceFamilyIds: [],
      topology: "single_player_native_companion",
      rationale: "Deliberately invalid duplicate to exercise the checker.",
      playerVisibleDisposition: "unavailable",
      nonSubstitutionRule: "No generic dispatcher or UI fallback.",
      admissionCondition: "Add a signed scope revision and trace family.",
    },
  ];

  assert.throws(() => validatePortfolioCommandPathCharter(model), { code: "portfolio_command_path_charter_duplicate" });
});

test("rejects a source impact that is silently left unclassified", async () => {
  const model = await fixture();
  model.traceFamilies = [
    {
      traceFamilyId: "portfolio_m4_resource_delivery_trace",
      scopeAtomId: "portfolio_m4_resource_delivery",
      playerSemantic: "Transform source and deliver freshly discovered drops.",
      actorSort: "bound local Player",
      targetSort: "selected native resource source",
      parameterDomain: {
        kind: "parameterized",
        domainDescription: "selected source class after signed content selection",
      },
      pathLanguage: {
        quantification: "for_each_valid_binding",
        variables: [{ name: "source", sort: "selected_live_resource_source", cardinality: "exactly_one" }],
        bindingRules: ["source_is_bound_by_initial_fresh_scoped_observation"],
        segments: [
          { kind: "observation_boundary", phase: "initial", binds: ["source"] },
          { kind: "semantic_transition", semanticTransition: "transform_selected_source", uses: ["source"] },
          { kind: "observation_boundary", phase: "fresh_after_native_commit", binds: [] },
        ],
      },
      guardPartitions: ["eligible"],
      outcomeAlgebra: ["succeeded", "blocked"],
      requiredPostcondition: {
        kind: "persisted_predicate",
        sameBindingRequired: true,
        freshAfterExecutionRequired: true,
        nativeSaveReopenRereadRequired: true,
      },
      evidencePolicy: {
        topology: "single_player_native_companion",
        sameExecutionRequired: true,
        nonNullEvidenceRequired: true,
        freshPostconditionRequired: true,
        candidateClosureInheritance: "forbidden",
        crossTopologyInheritance: "forbidden",
      },
      sourceRealization: {
        status: "unknown",
        uncertaintyId: "m4_trace_pending",
        question: "not reviewed",
        disposition: "blocks_projection",
      },
      projectionState: "unprojected",
    },
  ];
  model.sourceImpacts = [
    {
      impactId: "impact_01",
      traceFamilyId: "portfolio_m4_resource_delivery_trace",
      sourceAnchor: "StardewValley/Example.cs:1",
      disposition: "unclassified",
      rationale: "unclassified source result",
      exclusionId: null,
    },
  ];

  assert.throws(() => validatePortfolioCommandPathCharter(model), {
    code: "portfolio_command_path_source_impact_invalid",
  });
});

test("an assessment preserves unknown source impacts as a hard fail-closed state", async () => {
  const model = await fixture();
  model.sourceImpacts = [
    {
      impactId: "unknown_source_impact",
      traceFamilyId: "portfolio_m1_leave_and_return_route",
      sourceAnchor: "StardewValley/Example.cs:1",
      disposition: "unknown_blocking",
      rationale: "Target-version branch needs focused semantic review.",
      exclusionId: null,
    },
  ];

  const result = assessPortfolioCommandPathCharter(model);
  assert.equal(result.state, "blocked_pending_source_impact_disposition");
  assert.deepEqual(result.unknownBlockingImpactIds, ["unknown_source_impact"]);
});

test("all M1–M10 scope atoms are accounted by parameterized trace families but remain source-blocked", async () => {
  const model = await fixture();
  const result = assessPortfolioCommandPathCharter(model);

  assert.equal(result.state, "pending_focused_source_realization");
  assert.deepEqual(result.pendingScopeAtomIds, []);
  assert.deepEqual(
    [...new Set(model.traceFamilies.map((entry) => entry.scopeAtomId))].sort(),
    model.scopeAtoms.map((entry) => entry.scopeAtomId).sort(),
  );
  assert.equal(result.pendingSourceRealizationTraceFamilyIds.length, 10);
  assert.equal(result.pendingProjectionTraceFamilyIds.length, 10);
  assert.equal(result.publishable, false);
});
