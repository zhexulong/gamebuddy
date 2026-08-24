import { createHash } from "node:crypto";

const CANARY_ID = "stardew_1_6_15_soil_interaction_transition_model_v1";
const _SHA256 = /^[a-f0-9]{64}$/;
const FORBIDDEN_KEYS = new Set([
  "actionid",
  "primitiveid",
  "operationid",
  "publicactionid",
  "coveragekind",
  "basisprimitiveids",
  "implementationactionids",
]);
const TERMINALS = new Set(["succeeded", "rejected", "cancelled", "timed_out", "uncertain", "protocol_pending"]);
const REQUIRED_VARIANTS = new Set(["till", "plant_seed", "fertilize_tile", "water", "harvest_grab"]);

function fail(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${name} must be an object.`, "soil_itm_invalid_shape", { name });
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0)
    fail(`${name} must be a non-empty string.`, "soil_itm_invalid_shape", { name });
  return value;
}

function requireArray(value, name) {
  if (!Array.isArray(value) || value.length === 0)
    fail(`${name} must be a non-empty array.`, "soil_itm_invalid_shape", { name });
  return value;
}

function validateNoForbiddenVocabulary(value, path = "") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateNoForbiddenVocabulary(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      fail(`ITM input must not use legacy/product-layer field ${key}.`, "soil_itm_forbidden_vocabulary", { path, key });
    }
    validateNoForbiddenVocabulary(entry, path ? `${path}.${key}` : key);
  }
}

function sourceAnchor(sourceFiles, anchor, name) {
  const record = requireObject(anchor, name);
  const relativePath = requireString(record.relativePath, `${name}.relativePath`);
  let start = record.startByte;
  let end = record.endByte;
  const source = sourceFiles[relativePath];
  if (typeof source !== "string")
    fail(`${name} references unavailable source ${relativePath}.`, "soil_itm_source_missing", { name, relativePath });
  const bytes = Buffer.from(source, "utf8");
  // Definitions identify a source witness by text, and this derivation emits
  // its exact byte locator. A persisted report must revalidate that locator.
  // The full source manifest protects this convenience lookup against source
  // drift; a later production artifact will store only concrete byte spans.
  if (start === undefined && end === undefined && typeof record.needle === "string" && record.needle.length > 0) {
    const first = source.indexOf(record.needle);
    if (first < 0)
      fail(`${name} does not occur in its declared source file.`, "soil_itm_anchor_mismatch", {
        name,
        relativePath,
        needle: record.needle,
      });
    start = Buffer.byteLength(source.slice(0, first));
    end = start + Buffer.byteLength(record.needle);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
    fail(`${name} must declare a valid byte span or source needle.`, "soil_itm_invalid_anchor", { name });
  }
  if (end > bytes.length)
    fail(`${name} extends beyond ${relativePath}.`, "soil_itm_invalid_anchor", {
      name,
      relativePath,
      end,
      length: bytes.length,
    });
  const slice = bytes.subarray(start, end).toString("utf8");
  if (typeof record.needle === "string" && !slice.includes(record.needle)) {
    fail(`${name} does not contain its required source needle.`, "soil_itm_anchor_mismatch", {
      name,
      relativePath,
      needle: record.needle,
    });
  }
  if (record.fileSha256 !== undefined && record.fileSha256 !== sha256(source)) {
    fail(`${name} file hash is stale.`, "soil_itm_anchor_mismatch", { name, relativePath });
  }
  if (record.sliceSha256 !== undefined && record.sliceSha256 !== sha256(slice)) {
    fail(`${name} slice hash is stale.`, "soil_itm_anchor_mismatch", { name, relativePath });
  }
  return Object.freeze({
    relativePath,
    startByte: start,
    endByte: end,
    fileSha256: sha256(source),
    sliceSha256: sha256(slice),
    needle: record.needle ?? null,
  });
}

function sourceManifest(sourceFiles) {
  const rows = Object.entries(sourceFiles)
    .map(([relativePath, source]) => {
      if (typeof source !== "string")
        fail("sourceFiles values must be source strings.", "soil_itm_invalid_shape", { relativePath });
      return { relativePath, byteLength: Buffer.byteLength(source), sha256: sha256(source) };
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return Object.freeze({ rows: Object.freeze(rows), sha256: sha256(stableJson(rows)) });
}

function unique(values, name) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) fail(`${name} contains duplicate ${value}.`, "soil_itm_duplicate", { name, value });
    seen.add(value);
  }
}

function canonicalClass(sourceFiles, entry) {
  const item = requireObject(entry, "interaction class");
  const interactionClassId = requireString(item.interactionClassId, "interactionClassId");
  const requiredVariant = requireString(item.requiredVariant, `${interactionClassId}.requiredVariant`);
  if (!REQUIRED_VARIANTS.has(requiredVariant))
    fail(`${interactionClassId} has unknown requiredVariant.`, "soil_itm_unknown_variant", { requiredVariant });
  const actorTopology = requireString(item.actorTopology, `${interactionClassId}.actorTopology`);
  const targetSort = requireString(item.targetSort, `${interactionClassId}.targetSort`);
  const parameters = requireArray(item.parameters, `${interactionClassId}.parameters`).map((parameter) =>
    requireString(parameter, `${interactionClassId}.parameter`),
  );
  const initiation = requireArray(item.initiation, `${interactionClassId}.initiation`).map((predicate) =>
    requireString(predicate, `${interactionClassId}.initiation predicate`),
  );
  const observablePreState = requireArray(item.observablePreState, `${interactionClassId}.observablePreState`).map(
    (fact) => requireString(fact, `${interactionClassId}.observablePreState fact`),
  );
  const observableCommit = requireArray(item.observableCommit, `${interactionClassId}.observableCommit`).map((fact) =>
    requireString(fact, `${interactionClassId}.observableCommit fact`),
  );
  const terminals = requireArray(item.terminals, `${interactionClassId}.terminals`).map((terminal) =>
    requireString(terminal, `${interactionClassId}.terminal`),
  );
  if (!terminals.includes("succeeded") || terminals.some((terminal) => !TERMINALS.has(terminal))) {
    fail(`${interactionClassId} has an invalid terminal algebra.`, "soil_itm_terminal_invalid", { terminals });
  }
  unique(terminals, `${interactionClassId}.terminals`);
  const pendingContinuation = requireString(item.pendingContinuation, `${interactionClassId}.pendingContinuation`);
  const failureBoundary = requireArray(item.failureBoundary, `${interactionClassId}.failureBoundary`).map((fact) =>
    requireString(fact, `${interactionClassId}.failureBoundary fact`),
  );
  const evidence = requireArray(item.evidence, `${interactionClassId}.evidence`).map((fact) =>
    requireString(fact, `${interactionClassId}.evidence fact`),
  );
  const requiredTraceIds = requireArray(item.requiredTraceIds, `${interactionClassId}.requiredTraceIds`).map((id) =>
    requireString(id, `${interactionClassId}.requiredTraceId`),
  );
  const nativeWitnesses = requireArray(item.nativeWitnesses, `${interactionClassId}.nativeWitnesses`).map(
    (witness, index) => sourceAnchor(sourceFiles, witness, `${interactionClassId}.nativeWitnesses[${index}]`),
  );
  return Object.freeze({
    interactionClassId,
    requiredVariant,
    actorTopology,
    targetSort,
    parameters: Object.freeze(parameters),
    initiation: Object.freeze(initiation),
    observablePreState: Object.freeze(observablePreState),
    observableCommit: Object.freeze(observableCommit),
    terminals: Object.freeze(terminals),
    pendingContinuation,
    failureBoundary: Object.freeze(failureBoundary),
    evidence: Object.freeze(evidence),
    requiredTraceIds: Object.freeze(requiredTraceIds),
    nativeWitnesses: Object.freeze(nativeWitnesses),
  });
}

function canonicalTrace(trace) {
  const item = requireObject(trace, "required trace");
  return Object.freeze({
    traceId: requireString(item.traceId, "traceId"),
    requiredVariant: requireString(item.requiredVariant, "requiredVariant"),
    description: requireString(item.description, "description"),
    classIds: Object.freeze(requireArray(item.classIds, "classIds").map((id) => requireString(id, "classId"))),
  });
}

function canonicalProtocol(sourceFiles, protocol) {
  const item = requireObject(protocol, "protocol");
  const protocolId = requireString(item.protocolId, "protocolId");
  const witnesses = requireArray(item.nativeWitnesses, `${protocolId}.nativeWitnesses`).map((witness, index) =>
    sourceAnchor(sourceFiles, witness, `${protocolId}.nativeWitnesses[${index}]`),
  );
  return Object.freeze({
    protocolId,
    initiation: requireString(item.initiation, `${protocolId}.initiation`),
    terminalObservation: requireString(item.terminalObservation, `${protocolId}.terminalObservation`),
    freshObservationRequirement: requireString(
      item.freshObservationRequirement,
      `${protocolId}.freshObservationRequirement`,
    ),
    nativeWitnesses: Object.freeze(witnesses),
  });
}

function normalize(value) {
  return [...value].sort();
}

function sameSet(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Build a bounded Interaction Transition Model canary. The model is driven by
 * required interaction traces and validates source only as realization evidence.
 * It does not read an action registry or legacy capability catalog.
 */
export function deriveSoilInteractionTransitionModel({ sourceFiles, model }) {
  requireObject(sourceFiles, "sourceFiles");
  requireObject(model, "model");
  validateNoForbiddenVocabulary(model);
  const manifest = sourceManifest(sourceFiles);
  const sourceManifestSha256 = requireString(model.sourceManifestSha256, "model.sourceManifestSha256");
  if (sourceManifestSha256 !== manifest.sha256)
    fail("ITM model source manifest does not match supplied exact sources.", "soil_itm_source_manifest_mismatch");
  if (model.schemaVersion !== 1 || model.modelKind !== "soil_interaction_transition_model") {
    fail("Unsupported soil ITM model schema.", "soil_itm_schema_invalid");
  }

  const traces = requireArray(model.requiredTraces, "model.requiredTraces").map(canonicalTrace);
  const classes = requireArray(model.interactionClasses, "model.interactionClasses").map((entry) =>
    canonicalClass(sourceFiles, entry),
  );
  const protocols = requireArray(model.protocols, "model.protocols").map((entry) =>
    canonicalProtocol(sourceFiles, entry),
  );
  unique(
    traces.map((trace) => trace.traceId),
    "required trace IDs",
  );
  unique(
    classes.map((entry) => entry.interactionClassId),
    "interaction class IDs",
  );
  unique(
    protocols.map((entry) => entry.protocolId),
    "protocol IDs",
  );
  unique(
    classes.map((entry) => entry.requiredVariant),
    "required variants",
  );
  if (
    !sameSet(
      classes.map((entry) => entry.requiredVariant),
      REQUIRED_VARIANTS,
    )
  ) {
    fail(
      "Soil canary must represent each required interaction variant exactly once.",
      "soil_itm_variant_closure_missing",
    );
  }

  const classById = new Map(classes.map((entry) => [entry.interactionClassId, entry]));
  const traceById = new Map(traces.map((entry) => [entry.traceId, entry]));
  for (const trace of traces) {
    for (const classId of trace.classIds) {
      if (!classById.has(classId))
        fail(`${trace.traceId} references unknown interaction class ${classId}.`, "soil_itm_trace_reference_missing");
    }
  }
  for (const entry of classes) {
    for (const traceId of entry.requiredTraceIds) {
      const trace = traceById.get(traceId);
      if (!trace || !trace.classIds.includes(entry.interactionClassId)) {
        fail(`${entry.interactionClassId} trace binding is not bidirectional.`, "soil_itm_trace_binding_invalid", {
          traceId,
        });
      }
    }
  }

  const dayProtocol = protocols.find((entry) => entry.protocolId === "native_day_progression_with_fresh_observation");
  if (!dayProtocol)
    fail(
      "Soil canary must retain native day progression as an explicit protocol boundary.",
      "soil_itm_protocol_missing",
    );
  const growTrace = traces.find((entry) => entry.traceId === "grow_seed_to_harvestable_crop");
  if (!growTrace || !growTrace.classIds.includes("soil.harvest_grab")) {
    fail("Soil canary must bind harvesting to its required grow trace.", "soil_itm_trace_binding_invalid");
  }

  const separation = requireArray(model.separationObligations, "model.separationObligations").map((entry) =>
    requireObject(entry, "separation obligation"),
  );
  const requiredPairs = [
    ["soil.plant_seed", "soil.fertilize_tile"],
    ["soil.till", "soil.plant_seed"],
    ["soil.water", "soil.harvest_grab"],
  ];
  for (const [leftClassId, rightClassId] of requiredPairs) {
    const proof = separation.find((entry) => entry.leftClassId === leftClassId && entry.rightClassId === rightClassId);
    if (
      !proof ||
      proof.decision !== "separate" ||
      !Array.isArray(proof.distinguishingDimensions) ||
      proof.distinguishingDimensions.length === 0
    ) {
      fail(
        `Missing a distinguishing separation obligation for ${leftClassId} and ${rightClassId}.`,
        "soil_itm_separation_missing",
        { leftClassId, rightClassId },
      );
    }
  }

  const irredundancy = requireArray(model.irredundancyObligations, "model.irredundancyObligations").map((entry) =>
    requireObject(entry, "irredundancy obligation"),
  );
  for (const interactionClass of classes) {
    const proof = irredundancy.find((entry) => entry.interactionClassId === interactionClass.interactionClassId);
    if (
      !proof ||
      proof.decision !== "retain" ||
      typeof proof.lostTrace !== "string" ||
      typeof proof.reason !== "string"
    ) {
      fail(
        `Missing deletion counterfactual for ${interactionClass.interactionClassId}.`,
        "soil_itm_irredundancy_missing",
        { interactionClassId: interactionClass.interactionClassId },
      );
    }
    if (!traceById.has(proof.lostTrace))
      fail(`${interactionClass.interactionClassId} refers to unknown lost trace.`, "soil_itm_irredundancy_invalid");
  }

  return Object.freeze({
    schemaVersion: 1,
    modelKind: "derived_soil_interaction_transition_model",
    canaryId: CANARY_ID,
    sourceManifestSha256: manifest.sha256,
    requiredTraces: Object.freeze(traces),
    interactionClasses: Object.freeze(classes),
    protocols: Object.freeze(protocols),
    separationObligations: Object.freeze(
      separation.map((entry) =>
        Object.freeze({
          leftClassId: entry.leftClassId,
          rightClassId: entry.rightClassId,
          decision: entry.decision,
          distinguishingDimensions: Object.freeze([...entry.distinguishingDimensions]),
        }),
      ),
    ),
    irredundancyObligations: Object.freeze(
      irredundancy.map((entry) =>
        Object.freeze({
          interactionClassId: entry.interactionClassId,
          decision: entry.decision,
          lostTrace: entry.lostTrace,
          reason: entry.reason,
        }),
      ),
    ),
    coverage: Object.freeze({
      requiredTraceCount: traces.length,
      interactionClassCount: classes.length,
      protocolCount: protocols.length,
      traceClosureState: "scope_bounded_complete",
      minimalityState: "relative_to_declared_observation_and_trace_model",
    }),
    analysisBoundary: Object.freeze({
      legacyCatalog: "not_read",
      actionRegistry: "not_read",
      sourceRole: "native_realization_and_drift_witness",
      publicActionProjection: "not_performed",
      bridgeContract: "not_performed",
      liveConformance: "not_performed",
      globalGameplayCompleteness: "not_claimed",
    }),
  });
}

export function sourceManifestForSoilItm(sourceFiles) {
  return sourceManifest(sourceFiles);
}
