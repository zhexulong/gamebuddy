import { createHash } from "node:crypto";

const REVIEW_DISPOSITIONS = new Set([
  "in_scope_root",
  "in_scope_continuation",
  "in_scope_content_interpreter",
  "not_a_mechanism",
  "scope_exclusion_boundary",
  "unresolved_gap",
]);
const IN_SCOPE_DISPOSITIONS = new Set(["in_scope_root", "in_scope_continuation", "in_scope_content_interpreter"]);
const FORBIDDEN_KEYS = new Set([
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
  "publicAction",
  "publicActionId",
  "projection",
  "reuse",
]);
const SHA256 = /^[a-f0-9]{64}$/;
function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}
function text(value, field, details = {}) {
  if (typeof value !== "string" || !value.trim())
    fail("mechanism_review_register_invalid", `Expected non-empty ${field}.`, details);
  return value;
}
function noForbidden(value, location = "$") {
  if (Array.isArray(value)) return value.forEach((item, i) => noForbidden(item, `${location}[${i}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key))
      fail("mechanism_review_register_forbidden_field", `Review register must not infer ${key}.`, {
        location: `${location}.${key}`,
      });
    noForbidden(child, `${location}.${key}`);
  }
}
function sameLocator(left, right) {
  return (
    left &&
    right &&
    left.relativePath === right.relativePath &&
    left.startByte === right.startByte &&
    left.endByte === right.endByte &&
    left.sliceSha256 === right.sliceSha256
  );
}
function requiredLocator(locator, field, details) {
  if (
    !locator ||
    typeof locator !== "object" ||
    typeof locator.relativePath !== "string" ||
    !Number.isInteger(locator.startByte) ||
    !Number.isInteger(locator.endByte) ||
    locator.endByte <= locator.startByte ||
    !SHA256.test(locator.sliceSha256 ?? "")
  )
    fail("mechanism_review_register_locator_invalid", `Expected exact ${field} locator.`, details);
  return locator;
}
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
export function validateMechanismReport(report) {
  if (report?.schemaVersion !== 1 || report?.artifactKind !== "native_interaction_mechanism_enumeration")
    fail(
      "mechanism_review_register_report_invalid",
      "Expected native interaction mechanism enumeration schema version 1.",
    );
  const targetAssemblySha256 = report?.target?.sha256;
  const sourceManifestSha256 = report?.source?.sourceManifestSha256;
  if (!SHA256.test(targetAssemblySha256 ?? "") || !SHA256.test(sourceManifestSha256 ?? ""))
    fail("mechanism_review_register_report_invalid", "Exact mechanism report target/source attestation is malformed.");
  if (!Array.isArray(report?.source?.files) || !Array.isArray(report?.enumeration?.mechanisms))
    fail("mechanism_review_register_report_invalid", "Exact mechanism report lacks source manifest or mechanism rows.");
  const sourceFiles = new Map();
  for (const source of report.source.files) {
    if (
      typeof source?.relativePath !== "string" ||
      !SHA256.test(source?.sha256 ?? "") ||
      !Number.isInteger(source?.byteLength) ||
      source.byteLength < 0 ||
      sourceFiles.has(source.relativePath)
    )
      fail("mechanism_review_register_report_invalid", "Exact mechanism report source manifest is malformed.", {
        source,
      });
    sourceFiles.set(source.relativePath, source);
  }
  const mechanisms = new Map();
  for (const mechanism of report.enumeration.mechanisms) {
    text(mechanism?.mechanismId, "mechanism.mechanismId");
    requiredLocator(mechanism.sourceLocator, "mechanism.sourceLocator", { mechanismId: mechanism.mechanismId });
    if (!sourceFiles.has(mechanism.sourceLocator.relativePath) || mechanisms.has(mechanism.mechanismId))
      fail("mechanism_review_register_report_invalid", "Exact mechanism report mechanism rows are malformed.", {
        mechanism,
      });
    mechanisms.set(mechanism.mechanismId, mechanism);
  }
  return { targetAssemblySha256, sourceManifestSha256, sourceFiles, mechanisms };
}
export function verifyExactMechanismReportSources(report, sourceTexts) {
  const exact = validateMechanismReport(report);
  const sources = sourceTexts instanceof Map ? sourceTexts : new Map(Object.entries(sourceTexts ?? {}));
  if (sources.size !== exact.sourceFiles.size)
    fail(
      "mechanism_review_register_source_manifest_incomplete",
      "Source root must contain every exact mechanism report source record.",
    );
  for (const [relativePath, expected] of exact.sourceFiles) {
    const textValue = sources.get(relativePath);
    if (typeof textValue !== "string")
      fail("mechanism_review_register_source_missing", "Exact source root lacks a mechanism report file.", {
        relativePath,
      });
    if (Buffer.byteLength(textValue, "utf8") !== expected.byteLength || hash(textValue) !== expected.sha256)
      fail(
        "mechanism_review_register_source_stale",
        "Exact source root does not match mechanism report source manifest.",
        { relativePath },
      );
  }
  for (const mechanism of exact.mechanisms.values()) {
    const bytes = Buffer.from(sources.get(mechanism.sourceLocator.relativePath), "utf8");
    const locator = mechanism.sourceLocator;
    if (
      locator.endByte > bytes.length ||
      hash(bytes.subarray(locator.startByte, locator.endByte)) !== locator.sliceSha256
    )
      fail("mechanism_review_register_locator_stale", "Mechanism report locator does not match exact source bytes.", {
        mechanismId: mechanism.mechanismId,
      });
  }
  return exact;
}
export function validateNativeMechanismReviewRegister(register, { mechanismReport, sourceTexts = null } = {}) {
  if (!register || typeof register !== "object" || !mechanismReport)
    fail("mechanism_review_register_required", "A review register and exact mechanism report are required.");
  noForbidden(register);
  const exact =
    sourceTexts === null
      ? validateMechanismReport(mechanismReport)
      : verifyExactMechanismReportSources(mechanismReport, sourceTexts);
  if (register.schemaVersion !== 1 || register.artifactKind !== "native_interaction_mechanism_review_register")
    fail("mechanism_review_register_schema_invalid", "Expected native mechanism review register schema version 1.");
  if (
    register.attestation?.targetAssemblySha256 !== exact.targetAssemblySha256 ||
    register.attestation?.sourceManifestSha256 !== exact.sourceManifestSha256
  )
    fail(
      "mechanism_review_register_attestation_mismatch",
      "Review register does not match the exact mechanism report.",
    );
  if (!Array.isArray(register.records)) fail("mechanism_review_register_invalid", "Expected records array.");
  const reviewed = new Set();
  for (const record of register.records) {
    const details = { mechanismId: record?.mechanismId };
    const id = text(record?.mechanismId, "records[].mechanismId", details);
    const source = exact.mechanisms.get(id);
    if (!source)
      fail(
        "mechanism_review_register_unknown_mechanism",
        "Review record references a mechanism absent from the exact report.",
        details,
      );
    if (reviewed.has(id))
      fail("mechanism_review_register_duplicate", "A mechanism may be reviewed exactly once.", details);
    reviewed.add(id);
    if (!REVIEW_DISPOSITIONS.has(record.disposition))
      fail("mechanism_review_register_invalid", "Unknown review disposition.", {
        ...details,
        disposition: record.disposition,
      });
    text(record.reason, "records[].reason", details);
    if (record.disposition === "not_a_mechanism" || record.disposition === "scope_exclusion_boundary") {
      if (!sameLocator(record.sourceReasonLocator, source.sourceLocator))
        fail(
          "mechanism_review_register_reason_anchor_mismatch",
          "A non-mechanism/exclusion disposition must be anchored to its exact discovered source locator.",
          details,
        );
    }
    if (record.disposition === "unresolved_gap" && record.possiblyGameplayBearing !== true)
      fail("mechanism_review_register_gap_must_block", "Unresolved mechanism gaps always remain blocking.", details);
    if (IN_SCOPE_DISPOSITIONS.has(record.disposition) && record.possiblyGameplayBearing !== true)
      fail(
        "mechanism_review_register_in_scope_must_be_gameplay_bearing",
        "In-scope mechanism rows must remain possibly gameplay-bearing until Stage 2 resolves them.",
        details,
      );
  }
  const missingMechanismIds = [...exact.mechanisms.keys()].filter((id) => !reviewed.has(id));
  if (missingMechanismIds.length)
    fail(
      "mechanism_review_register_unreviewed",
      "Every discovered mechanism must receive exactly one explicit review disposition.",
      { missingMechanismIds },
    );
  return Object.freeze({
    mechanismCount: exact.mechanisms.size,
    recordCount: reviewed.size,
    unresolvedCount: register.records.filter((row) => row.disposition === "unresolved_gap").length,
    inScopeMechanismIds: Object.freeze(
      register.records.filter((row) => IN_SCOPE_DISPOSITIONS.has(row.disposition)).map((row) => row.mechanismId),
    ),
    dispositionByMechanismId: Object.freeze(
      Object.fromEntries(register.records.map((row) => [row.mechanismId, row.disposition])),
    ),
  });
}
