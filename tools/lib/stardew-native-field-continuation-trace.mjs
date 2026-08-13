import { createHash } from "node:crypto";
const SHA256 = /^[a-f0-9]{64}$/;
function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}
function exact(locator, sourceFiles, label, details) {
  if (
    !locator ||
    typeof locator.relativePath !== "string" ||
    !Number.isInteger(locator.startByte) ||
    !Number.isInteger(locator.endByte) ||
    locator.endByte <= locator.startByte ||
    !SHA256.test(locator.sliceSha256 ?? "") ||
    !SHA256.test(locator.sourceFileSha256 ?? "")
  )
    fail("field_continuation_locator_invalid", `Expected exact ${label} locator.`, details);
  const source = sourceFiles?.[locator.relativePath];
  if (!source || source.sha256 !== locator.sourceFileSha256 || typeof source.text !== "string")
    fail("field_continuation_source_missing", `Source absent/stale for ${label}.`, details);
  const bytes = Buffer.from(source.text, "utf8");
  if (
    locator.endByte > bytes.length ||
    createHash("sha256").update(bytes.subarray(locator.startByte, locator.endByte)).digest("hex") !==
      locator.sliceSha256
  )
    fail("field_continuation_locator_stale", `Locator stale for ${label}.`, details);
  return bytes.subarray(locator.startByte, locator.endByte).toString("utf8");
}
function noProductTerms(value, at = "$") {
  const forbidden = new Set([
    "action",
    "actionId",
    "primitive",
    "primitiveId",
    "operation",
    "operationId",
    "semanticFamily",
    "intent",
    "contract",
    "receipt",
    "evidence",
    "policy",
    "capability",
    "publicActionId",
    "projection",
    "reuse",
  ]);
  if (Array.isArray(value)) return value.forEach((x, i) => noProductTerms(x, `${at}[${i}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, x] of Object.entries(value)) {
    if (forbidden.has(key))
      fail("field_continuation_forbidden_field", `Field continuation trace must not infer ${key}.`, {
        at: `${at}.${key}`,
      });
    noProductTerms(x, `${at}.${key}`);
  }
}
/** Traces only source-owned field writes/reads across named exact methods. */
export function validateNativeFieldContinuationTrace(trace, { sourceFiles } = {}) {
  noProductTerms(trace);
  if (
    !trace ||
    trace.schemaVersion !== 1 ||
    trace.artifactKind !== "native_field_continuation_trace" ||
    typeof trace.fieldName !== "string" ||
    !trace.fieldName.trim()
  )
    fail("field_continuation_schema_invalid", "Expected native field continuation trace schema version 1.");
  const declaration = exact(trace.fieldDeclaration, sourceFiles, "fieldDeclaration", {});
  if (!declaration.includes(trace.fieldName))
    fail("field_continuation_field_missing", "Field declaration must name field.");
  for (const key of ["writerCallsites", "consumerCallsites", "clearerCallsites"]) {
    if (!Array.isArray(trace[key]) || !trace[key].length)
      fail("field_continuation_callsites_missing", `${key} must be nonempty.`);
    for (const call of trace[key]) {
      const text = exact(call, sourceFiles, key, {});
      if (!text.includes(trace.fieldName))
        fail("field_continuation_callsite_invalid", `${key} must reference field.`, { key });
    }
  }
  return Object.freeze({
    writerCount: trace.writerCallsites.length,
    consumerCount: trace.consumerCallsites.length,
    clearerCount: trace.clearerCallsites.length,
    continuationState: "source_field_handoff_attested",
    analysisBoundary: Object.freeze({
      movementMeaning: "not_inferred",
      positionTransition: "not_inferred",
      transitionDerivation: "not_performed",
      primitiveDerivation: "not_performed",
      publicActionProjection: "not_performed",
    }),
  });
}
