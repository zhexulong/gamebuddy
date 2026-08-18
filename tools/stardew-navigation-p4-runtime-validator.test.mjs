import assert from "node:assert/strict";
import test from "node:test";
import { summarizeRuntimeAttestation, validateRuntimeAttestation } from "./stardew-navigation-p4-runtime-validator.mjs";
const terminal = (state, detail) => ({
  artifactKind: "stardew_navigation_p4_runtime_attestation",
  schemaVersion: 2,
  state,
  ...(detail ? { detail } : {}),
  mutationCount: 0,
  bridgeUsed: false,
  productionRefIssued: false,
  rawLabelsEmitted: false,
});
const general = {
  gameAssemblyVersion: "1.6.15.24356",
  inputDigest: "ef2f63a15e9f528cfa70dcf8602013d241503d308b8702b846578fbf76e4876a",
  ordinaryCurrentWorld: {
    playerPresent: true,
    currentLocationPresent: true,
    currentLocationIsMineShaft: false,
    canMove: true,
    multiplayer: false,
    masterGame: true,
  },
  nativeApi: {
    mapRegionGetAreasInvocations: 1,
    mapAreaGetTooltipsInvocations: 1,
    mapAreaGetWorldPositionsInvocations: 1,
    mapRegionLocationNameInvocations: 1,
    tokenParserInvocations: 1,
  },
  mineIdentity: true,
  mineWorldMapNameMatchesCanonical: true,
  mountainWorldMapBinding: true,
  mineWorldMapTooltipBinding: true,
  aggregates: { minesTooltipAreaCount: 1 },
  progressiveObservation: {
    sourceCorrelation: { targetAssemblyInputDigestMatchesP4A: true, sourceBinding: "p4a_target_digest_bound" },
    pageSize: 8,
    root: {
      nativeRegionCount: 2,
      pageCount: 1,
      pagesVisited: 1,
      sameGenerationReplay: "stable",
      traversalDigestSha256: "d".repeat(64),
      replayTraversalDigestSha256: "d".repeat(64),
    },
    areas: { configuredCount: 17, includedCount: 16, conditionExcludedCount: 1, emptyNodeCount: 0, pagesVisited: 3 },
    tooltips: {
      configuredInIncludedAreaCount: 56,
      visibleCount: 42,
      conditionExcludedCount: 14,
      knownVisibleCount: 42,
      unknownPresentationObservedCount: 0,
      emptyNodeCount: 0,
      pagesVisited: 6,
    },
    positions: {
      configuredInIncludedAreaCount: 67,
      visibleCount: 67,
      conditionExcludedCount: 0,
      sourceCorrelatedUniqueLeafCandidateCount: 57,
      unresolvedLeafCount: 4,
      nonUniqueLeafCount: 6,
      presentationOnlyLeafCount: 0,
      emptyNodeCount: 0,
      pagesVisited: 9,
    },
    pagination: { state: "exercised", boundedTraversalReplay: "stable" },
  },
  localeEvaluation: {
    currentLanguage: "en",
    mineDisplayTokenSha256: "b".repeat(64),
    mineDisplayTextSha256: "c".repeat(64),
    currentLocaleTokenParser: "resolved_redacted",
    fallbackLocale: "not_attempted_global_locale_immutable",
    visibleTooltipCount: 42,
    hiddenOrUnknownTooltipCount: 14,
    unknownTooltipPresentation: "unknown_or_condition_excluded_present",
  },
};
test("accepts a complete native WorldMap attestation from an ordinary current location", () => {
  const complete = terminal("world_map_completed", { general });
  const validation = validateRuntimeAttestation(complete);
  assert.equal(validation.valid, true);
  assert.equal(validation.errors.includes("redaction_violation"), false);
  assert.match(summarizeRuntimeAttestation(complete).artifactDigest, /^[a-f0-9]{64}$/);
});
test("requires exactly one native Mountain/Mines tooltip binding", () => {
  assert.equal(
    validateRuntimeAttestation(
      terminal("world_map_completed", {
        general: { ...general, mineWorldMapTooltipBinding: false, aggregates: { minesTooltipAreaCount: 0 } },
      }),
    ).valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation(
      terminal("world_map_completed", { general: { ...general, aggregates: { minesTooltipAreaCount: 2 } } }),
    ).valid,
    false,
  );
});
test("rejects forged or unstable probe-private progressive observation facts", () => {
  assert.equal(
    validateRuntimeAttestation(
      terminal("world_map_completed", {
        general: {
          ...general,
          progressiveObservation: {
            ...general.progressiveObservation,
            root: { ...general.progressiveObservation.root, sameGenerationReplay: "unstable" },
          },
        },
      }),
    ).valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation(
      terminal("world_map_completed", {
        general: {
          ...general,
          progressiveObservation: {
            ...general.progressiveObservation,
            root: {
              ...general.progressiveObservation.root,
              replayTraversalDigestSha256: "e".repeat(64),
            },
          },
        },
      }),
    ).valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation(
      terminal("world_map_completed", {
        general: {
          ...general,
          progressiveObservation: {
            ...general.progressiveObservation,
            root: { ...general.progressiveObservation.root, pageCount: 2, pagesVisited: 2 },
          },
        },
      }),
    ).valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation(
      terminal("world_map_completed", {
        general: {
          ...general,
          progressiveObservation: {
            ...general.progressiveObservation,
            positions: { ...general.progressiveObservation.positions, presentationOnlyLeafCount: -1 },
          },
        },
      }),
    ).valid,
    false,
  );
});
test("rejects incomplete WorldMap proof, nonordinary location, raw sensitive fields, and mutation drift", () => {
  assert.equal(
    validateRuntimeAttestation(
      terminal("world_map_completed", {
        general: {
          ...general,
          ordinaryCurrentWorld: { ...general.ordinaryCurrentWorld, currentLocationIsMineShaft: true },
        },
      }),
    ).valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation(terminal("world_map_completed", { general: { ...general, mineWorldMapNameMatchesCanonical: false } }))
      .valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation(terminal("world_map_completed", { general: { ...general, mineWorldMapName: "Mines" } }))
      .valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation(terminal("world_map_completed", { general: { ...general, mineIdentity: false } })).valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation(
      terminal("world_map_completed", { general: { ...general, mountainWorldMapBinding: false } }),
    ).valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation(
      terminal("world_map_completed", {
        general: { ...general, nativeApi: { mapRegionGetAreasInvocations: 0, mapAreaGetTooltipsInvocations: 1 } },
      }),
    ).valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation(
      terminal("world_map_completed", { general: { ...general, mineWorldMapTooltipBinding: false } }),
    ).valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation(
      terminal("world_map_completed", { general: { ...general, aggregates: { minesTooltipAreaCount: 2 } } }),
    ).valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation(
      terminal("world_map_completed", { general: { ...general, inputDigest: "not-a-sha256" } }),
    ).valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation(
      terminal("world_map_completed", {
        general: { ...general, localeEvaluation: { ...general.localeEvaluation, mineDisplayTextSha256: "plaintext" } },
      }),
    ).valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation(
      terminal("world_map_completed", {
        general: { ...general, localeEvaluation: { ...general.localeEvaluation, fallbackLocale: "silently_switched" } },
      }),
    ).valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation(
      terminal("world_map_completed", {
        general: {
          ...general,
          localeEvaluation: { ...general.localeEvaluation, unknownTooltipPresentation: "raw_label" },
        },
      }),
    ).valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation(
      terminal("world_map_completed", {
        general: { ...general, localeEvaluation: { ...general.localeEvaluation, hiddenOrUnknownTooltipCount: 0 } },
      }),
    ).valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation(
      terminal("world_map_completed", {
        general: {
          ...general,
          localeEvaluation: {
            ...general.localeEvaluation,
            hiddenOrUnknownTooltipCount: 0,
            unknownTooltipPresentation: "none_observed",
            observedValue: "leak",
          },
        },
      }),
    ).valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation(
      terminal("world_map_completed", { general: { ...general, nativeApi: { ...general.nativeApi, extra: true } } }),
    ).valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation({ ...terminal("world_map_completed", { general }), extraEnvelopeData: "leak" }).valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation({ ...terminal("world_map_completed", { general }), mutationCount: 1 }).valid,
    false,
  );
  assert.equal(
    validateRuntimeAttestation(terminal("world_map_completed", { general: { ...general, rawLabels: "leak" } })).valid,
    false,
  );
});
