import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const FAMILY_KINDS = new Set([
  "input_lifecycle",
  "world_interaction_dispatch",
  "movement_lifecycle",
  "content_protocol",
  "event_protocol",
  "save_day_network_protocol",
]);
const STEP_KINDS = new Set([
  "ingress",
  "source_owner",
  "direct_handoff",
  "polymorphic_handoff",
  "event_registration",
  "event_resume",
  "update_resume",
  "content_dispatch",
  "unresolved_gap",
]);
const FORBIDDEN = new Set([
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
  "playerOutcome",
]);
const FAMILY_ID = /^source-family:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GAP_ID = /^gap:[a-z0-9]+(?:-[a-z0-9]+)*$/;
function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function rejectProductTerms(value, at = "$") {
  if (Array.isArray(value)) return value.forEach((item, index) => rejectProductTerms(item, `${at}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN.has(key))
      fail("state_machine_family_forbidden_field", `State-machine family register must not infer ${key}.`, {
        at: `${at}.${key}`,
      });
    rejectProductTerms(child, `${at}.${key}`);
  }
}
function exact(anchor, sourceFiles, field) {
  if (
    !anchor ||
    typeof anchor.relativePath !== "string" ||
    !Number.isInteger(anchor.startByte) ||
    !Number.isInteger(anchor.endByte) ||
    anchor.endByte <= anchor.startByte ||
    !SHA256.test(anchor.sliceSha256 ?? "") ||
    !SHA256.test(anchor.sourceFileSha256 ?? "")
  )
    fail("state_machine_family_anchor_invalid", `Expected exact ${field} anchor.`);
  const source = sourceFiles?.[anchor.relativePath];
  if (!source || typeof source.text !== "string" || source.sha256 !== anchor.sourceFileSha256)
    fail("state_machine_family_source_missing", `Exact source is missing for ${field}.`, {
      relativePath: anchor.relativePath,
    });
  const bytes = Buffer.from(source.text, "utf8");
  if (anchor.endByte > bytes.length || hash(bytes.subarray(anchor.startByte, anchor.endByte)) !== anchor.sliceSha256)
    fail("state_machine_family_anchor_stale", `Exact ${field} anchor is stale.`, { relativePath: anchor.relativePath });
  return bytes.subarray(anchor.startByte, anchor.endByte).toString("utf8");
}
/**
 * A family is the bounded source-owned lifecycle surface that later Stage 2
 * turns into transitions. It is deliberately not a transition/action basis:
 * every source handoff stays visible and dynamic edges remain blocking gaps.
 */
export function validateNativeStateMachineFamilyRegister(register, { sourceFiles } = {}) {
  rejectProductTerms(register);
  if (!register || register.schemaVersion !== 1 || register.artifactKind !== "native_state_machine_family_register")
    fail("state_machine_family_schema_invalid", "Expected native state-machine family register schema version 1.");
  if (!Array.isArray(register.families) || !register.families.length)
    fail("state_machine_family_missing", "At least one exact source family is required.");
  const ids = new Set();
  let blockingGapCount = 0;
  for (const family of register.families) {
    if (!family || typeof family.familyId !== "string" || !FAMILY_ID.test(family.familyId) || ids.has(family.familyId))
      fail(
        "state_machine_family_id_invalid",
        "Family IDs must be unique, neutral source IDs using source-family:<kebab-case>.",
      );
    ids.add(family.familyId);
    if (!FAMILY_KINDS.has(family.familyKind))
      fail("state_machine_family_kind_invalid", "Family kind must be structural and source-neutral.", {
        familyId: family.familyId,
      });
    if (!Array.isArray(family.steps) || !family.steps.length)
      fail("state_machine_family_steps_missing", "Every family needs an ordered source step inventory.", {
        familyId: family.familyId,
      });
    const sequence = new Set();
    let hasIngress = false;
    let hasOwner = false;
    for (const step of family.steps) {
      if (!Number.isInteger(step?.sequence) || step.sequence < 0 || sequence.has(step.sequence))
        fail("state_machine_family_sequence_invalid", "Family steps need unique nonnegative sequence values.", {
          familyId: family.familyId,
        });
      sequence.add(step.sequence);
      if (!STEP_KINDS.has(step.kind))
        fail("state_machine_family_step_kind_invalid", "Unknown neutral state-machine step kind.", {
          familyId: family.familyId,
          kind: step?.kind,
        });
      const source = exact(step.anchor, sourceFiles, `family ${family.familyId} step ${step.sequence}`);
      if (
        typeof step.ownerSyntax !== "string" ||
        !step.ownerSyntax ||
        !source.includes(step.ownerSyntax.split(/[.#]/).at(-1))
      )
        fail("state_machine_family_owner_unproven", "Step owner must occur in its exact source span.", {
          familyId: family.familyId,
          sequence: step.sequence,
        });
      if (step.kind === "ingress") hasIngress = true;
      if (step.kind === "source_owner") hasOwner = true;
      if (step.kind === "unresolved_gap") {
        if (step.possiblyGameplayBearing !== true || typeof step.gapId !== "string" || !GAP_ID.test(step.gapId))
          fail(
            "state_machine_family_gap_invalid",
            "An unresolved family step must be a blocking gameplay-bearing gap with neutral gap:<kebab-case> ID.",
            { familyId: family.familyId, sequence: step.sequence },
          );
        blockingGapCount += 1;
      }
      if (step.kind !== "unresolved_gap" && step.possiblyGameplayBearing !== undefined)
        fail("state_machine_family_non_gap_bearing_invalid", "Only unresolved gaps carry possiblyGameplayBearing.", {
          familyId: family.familyId,
          sequence: step.sequence,
        });
    }
    if (!hasOwner || (!hasIngress && !["save_day_network_protocol"].includes(family.familyKind)))
      fail(
        "state_machine_family_structure_missing",
        "An interaction family needs exact ingress and source-owner steps; a save/day/network protocol may begin at an exact source owner.",
        { familyId: family.familyId },
      );
    if (family.coverageState !== "partial_with_blocking_gaps" && family.coverageState !== "exact_source_slice_only")
      fail("state_machine_family_coverage_invalid", "Unsupported family coverage state.", {
        familyId: family.familyId,
      });
    if (
      family.coverageState === "partial_with_blocking_gaps" &&
      !family.steps.some((step) => step.kind === "unresolved_gap")
    )
      fail("state_machine_family_gap_missing", "Partial family must retain an explicit blocking gap.", {
        familyId: family.familyId,
      });
    if (
      family.coverageState === "exact_source_slice_only" &&
      family.steps.some((step) => step.kind === "unresolved_gap")
    )
      fail(
        "state_machine_family_slice_gap_invalid",
        "An exact source slice must not disguise a blocking gap; use partial_with_blocking_gaps.",
        { familyId: family.familyId },
      );
  }
  return Object.freeze({
    familyCount: register.families.length,
    blockingGapCount,
    familyDerivationState: "source_attested_partial",
    analysisBoundary: Object.freeze({
      transitionDerivation: "not_performed",
      primitiveDerivation: "not_performed",
      contextualEquivalence: "not_performed",
      playerOperationDerivation: "not_performed",
      publicActionProjection: "not_performed",
    }),
  });
}
