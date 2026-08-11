import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const DISPOSITIONS = new Set(["runtime_modeled", "approved_scope_boundary"]);
const KINDS = new Set(["runtime_receiver_snapshot", "runtime_delegate_snapshot", "runtime_content_snapshot", "runtime_lifecycle_trace", "approved_scope_exclusion"]);
const FORBIDDEN = /\b(action|primitive|operation|capability|contract|receipt|evidence|policy|projection|semantic[_ -]?family)\b/i;
const TOOL_RUNTIME_RECORD = /^[a-f0-9]{64}$/;

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function object(value, code, message) { if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, message); }
function string(value, code, message) { if (typeof value !== "string" || value.length === 0) fail(code, message); }
function sha(value) { return createHash("sha256").update(value).digest("hex"); }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
export function runtimeBoundaryModelDigest(model) { return sha(canonical(model)); }
function noTerms(value, at = "$") { if (typeof value === "string") return; if (Array.isArray(value)) return value.forEach((item, index) => noTerms(item, `${at}[${index}]`)); if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { const normalized = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " "); if (FORBIDDEN.test(normalized)) fail("runtime_boundary_model_forbidden_vocabulary", `forbidden key ${at}.${key}`); noTerms(child, `${at}.${key}`); } }

/** Validates a version-locked dynamic-boundary disposition model; it does not validate gameplay behavior. */
export function validateNativeRuntimeBoundaryModel(model, { targetAssemblySha256, contentManifestSha256 } = {}) {
  object(model, "runtime_boundary_model_invalid", "runtime boundary model must be an object"); noTerms(model);
  if (model.schemaVersion !== 1 || model.artifactKind !== "native_runtime_boundary_model") fail("runtime_boundary_model_kind_invalid", "expected native_runtime_boundary_model schema version 1");
  object(model.attestation, "runtime_boundary_model_attestation_missing", "attestation is required");
  for (const field of ["targetAssemblySha256", "contentManifestSha256"]) if (!SHA256.test(model.attestation[field] ?? "")) fail("runtime_boundary_model_attestation_invalid", `${field} must be a SHA-256`);
  if (targetAssemblySha256 && model.attestation.targetAssemblySha256 !== targetAssemblySha256) fail("runtime_boundary_model_target_mismatch", "target assembly does not match model");
  if (contentManifestSha256 && model.attestation.contentManifestSha256 !== contentManifestSha256) fail("runtime_boundary_model_content_mismatch", "content manifest does not match model");
  if (!Array.isArray(model.boundaries) || !model.boundaries.length) fail("runtime_boundary_model_boundaries_missing", "at least one dynamic boundary is required");
  const ids = new Set();
  for (const boundary of model.boundaries) {
    object(boundary, "runtime_boundary_model_boundary_invalid", "boundary must be an object"); string(boundary.boundaryId, "runtime_boundary_model_boundary_id_invalid", "boundaryId is required");
    if (!/^boundary:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(boundary.boundaryId) || ids.has(boundary.boundaryId)) fail("runtime_boundary_model_boundary_id_invalid", "boundary IDs must be unique neutral IDs"); ids.add(boundary.boundaryId);
    if (!DISPOSITIONS.has(boundary.disposition) || !KINDS.has(boundary.kind)) fail("runtime_boundary_model_boundary_kind_invalid", "boundary disposition or kind is invalid");
    if (boundary.disposition === "runtime_modeled") { if (!SHA256.test(boundary.runtimeRecordSha256 ?? "")) fail("runtime_boundary_model_runtime_record_missing", "runtime modeled boundary requires a runtime record hash"); }
    else { string(boundary.scopeReason, "runtime_boundary_model_scope_reason_missing", "scope boundary requires a reason"); if (!SHA256.test(boundary.approvalRecordSha256 ?? "")) fail("runtime_boundary_model_scope_approval_missing", "scope boundary requires approval hash"); }
  }
  return Object.freeze({ boundaryCount: ids.size, modelSha256: runtimeBoundaryModelDigest(model) });
}

/** Validates the redacted target runtime Data/Tools snapshot emitted by ContentProbe. */
export function validateToolContentRuntimeRecord(record, { targetAssemblySha256, contentManifestSha256 } = {}) {
  object(record, "tool_runtime_record_invalid", "tool runtime record must be an object");
  if (!SHA256.test(targetAssemblySha256 ?? "") || !SHA256.test(contentManifestSha256 ?? "")) fail("tool_runtime_record_attestation_invalid", "exact target and content hashes are required");
  if (record.state !== "loaded" || !Array.isArray(record.entries) || !record.entries.length || !TOOL_RUNTIME_RECORD.test(record.digest ?? "")) fail("tool_runtime_record_invalid", "loaded tool entries and digest are required");
  const ids = new Set();
  const lines = [];
  for (const entry of record.entries) {
    object(entry, "tool_runtime_record_entry_invalid", "tool record entry must be an object"); string(entry.itemId, "tool_runtime_record_entry_invalid", "tool itemId is required"); string(entry.className, "tool_runtime_record_entry_invalid", "tool className is required");
    if (ids.has(entry.itemId)) fail("tool_runtime_record_entry_duplicate", "duplicate tool itemId"); ids.add(entry.itemId);
    if (!Number.isInteger(entry.upgradeLevel) || !Number.isInteger(entry.attachmentSlots) || typeof entry.instantUse !== "boolean") fail("tool_runtime_record_entry_invalid", "tool entry fields are incomplete");
    lines.push(`${entry.itemId}\t${entry.className}\t${entry.upgradeLevel}\t${entry.instantUse ? "True" : "False"}\t${entry.attachmentSlots}`);
  }
  const actual = sha(`${[...lines].sort().join("\n")}\n`); if (actual !== record.digest) fail("tool_runtime_record_digest_mismatch", "tool runtime record digest is stale");
  return Object.freeze({ toolCount: ids.size, toolRecordSha256: record.digest, targetAssemblySha256, contentManifestSha256 });
}
