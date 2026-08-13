const SHA256 = /^[a-f0-9]{64}$/;

function fail(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function requireRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${name} must be an object.`, "soil_itm_conformance_invalid_shape", { name });
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0)
    fail(`${name} must be a non-empty string.`, "soil_itm_conformance_invalid_shape", { name });
  return value;
}

function parseDetail(detail) {
  if (typeof detail !== "string") return Object.freeze({});
  const values = {};
  for (const piece of detail.split(";")) {
    const split = piece.indexOf("=");
    if (split < 1) continue;
    const key = piece.slice(0, split);
    const value = piece.slice(split + 1);
    if (key.length > 0 && !(key in values)) values[key] = value;
  }
  return Object.freeze(values);
}

function requiredLiveCase(model, interactionClassId) {
  const entry = model.interactionClasses.find((item) => item.interactionClassId === interactionClassId);
  if (!entry) fail(`Unknown ITM class ${interactionClassId}.`, "soil_itm_conformance_class_missing");
  return entry;
}

function mustMapExactly(projections, classIds) {
  const known = new Set(classIds);
  const seen = new Set();
  for (const projection of projections) {
    requireRecord(projection, "projection");
    const interactionClassId = requireString(projection.interactionClassId, "projection.interactionClassId");
    if (!known.has(interactionClassId) || seen.has(interactionClassId)) {
      fail("Projection must map each ITM class exactly once.", "soil_itm_conformance_projection_invalid", {
        interactionClassId,
      });
    }
    seen.add(interactionClassId);
    requireString(projection.bridgeAction, "projection.bridgeAction");
  }
  if (seen.size !== known.size)
    fail("Projection omits an ITM interaction class.", "soil_itm_conformance_projection_missing");
}

function validateAvailableProjection(projections, classIds) {
  const known = new Set(classIds);
  const seen = new Set();
  for (const projection of projections) {
    requireRecord(projection, "projection");
    const interactionClassId = requireString(projection.interactionClassId, "projection.interactionClassId");
    if (!known.has(interactionClassId) || seen.has(interactionClassId)) {
      fail("Available projection has an unknown or duplicate ITM class.", "soil_itm_conformance_projection_invalid", {
        interactionClassId,
      });
    }
    seen.add(interactionClassId);
    requireString(projection.bridgeAction, "projection.bridgeAction");
  }
  return seen;
}

/**
 * Validates that independently recorded live evidence conforms to the bounded
 * soil ITM's declared observable commits. It never runs the bridge: the
 * runner/fixture must supply real target-game evidence separately.
 */
export function validateSoilItmConformance({ model, projections, liveCases, sourceReport }) {
  requireRecord(model, "model");
  requireRecord(sourceReport, "sourceReport");
  if (sourceReport.modelKind !== "derived_soil_interaction_transition_model")
    fail("sourceReport is not a derived soil ITM report.", "soil_itm_conformance_source_invalid");
  if (typeof sourceReport.sourceManifestSha256 !== "string" || !SHA256.test(sourceReport.sourceManifestSha256))
    fail("sourceReport is missing source provenance.", "soil_itm_conformance_source_invalid");
  const classes = Array.isArray(model.interactionClasses) ? model.interactionClasses : [];
  mustMapExactly(
    projections,
    classes.map((entry) => entry.interactionClassId),
  );
  if (!Array.isArray(liveCases)) fail("liveCases must be an array.", "soil_itm_conformance_invalid_shape");
  const byClass = readLiveCases(model, liveCases);
  for (const entry of classes) {
    if (!byClass.has(entry.interactionClassId))
      fail(`Missing live conformance case for ${entry.interactionClassId}.`, "soil_itm_conformance_live_missing");
  }

  validateObservableCommits(byClass);
  return Object.freeze({
    schemaVersion: 1,
    artifactKind: "soil_itm_live_conformance",
    sourceManifestSha256: sourceReport.sourceManifestSha256,
    classCount: classes.length,
    state: "all_declared_soil_classes_have_live_conformance_evidence",
    nonClaim:
      "This validates only the bounded soil ITM model; it does not claim global action-set completeness or publish a new Action surface.",
  });
}

function readLiveCases(model, liveCases) {
  const byClass = new Map();
  for (const liveCase of liveCases) {
    requireRecord(liveCase, "liveCase");
    const interactionClassId = requireString(liveCase.interactionClassId, "liveCase.interactionClassId");
    if (byClass.has(interactionClassId))
      fail(`Duplicate live evidence for ${interactionClassId}.`, "soil_itm_conformance_duplicate_live_case");
    requiredLiveCase(model, interactionClassId);
    const receipt = requireRecord(liveCase.receipt, `${interactionClassId}.receipt`);
    if (receipt.state !== "succeeded" || typeof receipt.reasonCode !== "string") {
      fail(`${interactionClassId} lacks a successful authoritative receipt.`, "soil_itm_conformance_live_missing", {
        interactionClassId,
      });
    }
    if (!liveCase.freshPostcondition || typeof liveCase.freshPostcondition !== "object") {
      fail(`${interactionClassId} lacks fresh postcondition evidence.`, "soil_itm_conformance_live_missing", {
        interactionClassId,
      });
    }
    if (
      typeof liveCase.runnerEvidence !== "object" ||
      liveCase.runnerEvidence === null ||
      liveCase.runnerEvidence.targetVersion !== "1.6.15.24356"
    ) {
      fail(`${interactionClassId} is not bound to exact target live evidence.`, "soil_itm_conformance_live_missing", {
        interactionClassId,
      });
    }
    byClass.set(interactionClassId, liveCase);
  }
  return byClass;
}

function validateObservableCommits(byClass) {
  const checks = {
    "soil.till": (entry, detail) =>
      entry.receipt.reasonCode === "soil_tilled" &&
      detail.before === "none" &&
      detail.after === "HoeDirt" &&
      entry.freshPostcondition.targetNoLongerEligible === true,
    "soil.plant_seed": (entry, detail) =>
      entry.receipt.reasonCode === "seed_planted" &&
      typeof detail.crop === "string" &&
      detail.crop !== "none" &&
      detail.item === entry.expected.qualifiedItemId &&
      detail.inventory_after === String(Number(detail.inventory_before) - 1) &&
      entry.freshPostcondition.targetNoLongerEligible === true,
    "soil.fertilize_tile": (entry, detail) =>
      entry.receipt.reasonCode === "fertilizer_applied" &&
      detail.fertilizer_before === "none" &&
      detail.fertilizer_after === entry.expected.qualifiedItemId &&
      detail.inventory_after === String(Number(detail.inventory_before) - 1) &&
      entry.freshPostcondition.targetNoLongerEligible === true,
    "soil.water": (entry) =>
      entry.receipt.reasonCode === "crop_watered" &&
      entry.freshPostcondition.targetNoLongerEligible === true &&
      entry.freshPostcondition.watered === true,
    "soil.harvest_grab": (entry, detail) =>
      entry.receipt.reasonCode === "crop_harvested" &&
      detail.native_accepted === "true" &&
      detail.inventory_gained === "true" &&
      entry.freshPostcondition.targetNoLongerEligible === true &&
      (entry.freshPostcondition.cropPresentAfter === true || entry.freshPostcondition.cropPresentAfter === false),
  };
  for (const [interactionClassId, liveCase] of byClass) {
    const checker = checks[interactionClassId];
    if (!checker || !checker(liveCase, parseDetail(liveCase.receipt.evidence?.detail))) {
      fail(
        `${interactionClassId} receipt/evidence does not conform to its ITM observable commit.`,
        "soil_itm_conformance_observable_mismatch",
        { interactionClassId },
      );
    }
  }
}

/** Classifies the current state without manufacturing live evidence. */
export function assessSoilItmConformance({ model, projections, liveCases = [], sourceReport, environment }) {
  requireRecord(model, "model");
  requireRecord(sourceReport, "sourceReport");
  const classes = Array.isArray(model.interactionClasses) ? model.interactionClasses : [];
  const projected = validateAvailableProjection(
    projections,
    classes.map((entry) => entry.interactionClassId),
  );
  const evidence = readLiveCases(model, liveCases);
  validateObservableCommits(evidence);
  const protocolIds = new Set((Array.isArray(model.protocols) ? model.protocols : []).map((entry) => entry.protocolId));
  const supportedProtocolEvidence = new Set();
  if (Array.isArray(environment?.protocolEvidence)) {
    for (const entry of environment.protocolEvidence) {
      requireRecord(entry, "protocolEvidence");
      const protocolId = requireString(entry.protocolId, "protocolEvidence.protocolId");
      if (
        !protocolIds.has(protocolId) ||
        entry.state !== "passed" ||
        entry.freshObservation !== true ||
        entry.runnerEvidence?.targetVersion !== "1.6.15.24356"
      ) {
        fail(`Invalid protocol conformance evidence for ${protocolId}.`, "soil_itm_conformance_protocol_invalid", {
          protocolId,
        });
      }
      supportedProtocolEvidence.add(protocolId);
    }
  }
  const environmentReady = environment?.state === "ready";
  const missingProjection = classes
    .filter((entry) => !projected.has(entry.interactionClassId))
    .map((entry) => entry.interactionClassId);
  const missingLiveEvidence = classes
    .filter((entry) => !evidence.has(entry.interactionClassId))
    .map((entry) => entry.interactionClassId);
  const missingProtocolEvidence = [...protocolIds].filter((protocolId) => !supportedProtocolEvidence.has(protocolId));
  return Object.freeze({
    schemaVersion: 1,
    artifactKind: "soil_itm_conformance_assessment",
    sourceManifestSha256: sourceReport.sourceManifestSha256,
    projectedClassIds: Object.freeze([...projected].sort()),
    missingProjection: Object.freeze(missingProjection),
    liveEvidenceClassIds: Object.freeze([...evidence.keys()].sort()),
    missingLiveEvidence: Object.freeze(missingLiveEvidence),
    missingProtocolEvidence: Object.freeze(missingProtocolEvidence),
    environmentState: environmentReady ? "ready" : "blocked_or_unavailable",
    state:
      missingProjection.length > 0 ||
      missingLiveEvidence.length > 0 ||
      missingProtocolEvidence.length > 0 ||
      !environmentReady
        ? "incomplete_pending_independent_live_conformance"
        : "all_declared_soil_classes_and_protocols_have_live_conformance_evidence",
  });
}
