/**
 * Native multiplayer sensitivity of Stardew game actions.
 *
 * Two independent axes are derived and cross-checked:
 *
 *   Axis 1 — native seam sensitivity: does the action's native seam method body
 *            read multiplayer-scoped game state (team, netWorldState, IsLocalPlayer…)?
 *   Axis 2 — Mod admission: does the Mod's `RequestLocal*` entry point reject
 *            multiplayer (`Context.IsMultiplayer` / `IsMasterGame` / farmers != 1)?
 *
 * Cross-checking the axes finds two classes of defect that are invisible to
 * either axis alone:
 *
 *   over_restriction  — admission rejects multiplayer although the native seam
 *                       carries no multiplayer state. The rejection has no native
 *                       justification, so it is a leftover single-player fixture
 *                       gate rather than a product scope decision.
 *   unverified_scope  — admission admits multiplayer although the native seam
 *                       reads multiplayer state, and no multiplayer live evidence
 *                       exists for the action.
 *
 * `mp-observational` records seams that do read multiplayer state but only for
 * collateral effects (sound, graphics, achievements, global chat, random seed,
 * limited seasonal drops) that cannot change the action's transaction outcome.
 * That distinction cannot be derived from text, so it is authored here once and
 * re-verified against the exact decompiled source.
 *
 * Axis 3 — mechanisms: single-player vs shared-world divergence also lives in
 *            game *mechanisms* that are not Mod actions at all (sleeping, the
 *            cross-day handshake, passing out, the day rollover, ready checks).
 *            An action-only register is structurally blind to them, so a
 *            mechanism is registered as a first-class entry that cites the exact
 *            control-flow forks in the native source it rests on.
 */

/**
 * DECISIVE multiplayer tokens: identifiers whose value genuinely differs between a
 * single-player save and a shared world, or between two farmers in one world.
 * Presence of any of these in a native seam means the seam's behaviour can differ.
 */
export const MP_DECISIVE_PATTERN =
  /IsMultiplayer|otherFarmers|IsLocalPlayer|IsMainPlayer|useSeparateWallets|multiplayerMode|Game1\.server\b|IsMasterGame|Game1\.multiplayer\b|UniqueMultiplayerID/g;

/**
 * CONTEXT tokens: appear in native action seams in BOTH modes.
 *
 *   `team.`        — FarmerTeam exists and is populated in single-player too
 *                    (special orders, skull shrine, limited nut drops, movie
 *                    invitations). Mode-neutral unless proven otherwise.
 *   `netWorldState`— exists in single-player too; the reads found in action
 *                    seams are random seeds only.
 *
 * A seam that reads only context tokens may still be declared mp-insensitive,
 * but the register must then state WHY the read is mode-neutral. This keeps the
 * judgement explicit instead of silently regex-matching it away.
 */
export const MP_CONTEXT_PATTERN = /team\.|netWorldState/g;

export const SEAM_KINDS = Object.freeze(["native", "mod_owned"]);

/**
 * Mechanisms whose single-player and shared-world execution paths are not the
 * same code path, so single-player live evidence can never transfer across the
 * fork. Derived from the forks themselves: a mechanism that has at least one
 * outcome fork requires shared-world evidence. Never hand-typed, so a newly
 * cited outcome fork cannot be understated by forgetting to list it here.
 */
export function deriveRequiredSharedWorldMechanisms(mechanisms) {
  return Object.freeze(
    mechanisms.filter((m) => m.forks.some((f) => f.forkClass === "outcome_fork")).map((m) => m.id),
  );
}

/**
 * A mechanism's cited control-flow forks. `forkClass` is authored, never
 * inferred: no text rule can decide whether two branches produce a different
 * observable game result, so the gate only checks that the citation is real and
 * that the reason names the branch code it rests on.
 */
export const MECHANISM_FORK_CLASSES = Object.freeze(["outcome_fork", "collateral_fork"]);

/**
 * Validate the mechanism axis against the exact decompiled source. Every fork
 * must cite a real method body that really contains the declared predicate, and
 * must carry an authored class plus a reason. Returns frozen mechanism records.
 */
export function validateMultiplayerMechanisms(mechanisms, sources) {
  if (!Array.isArray(mechanisms) || mechanisms.length === 0)
    fail("mp_sensitivity_register_invalid", "Expected non-empty mechanisms array.");
  const seen = new Set();
  const validated = mechanisms.map((mechanism, index) => {
    const where = `mechanisms[${index}]`;
    const id = text(mechanism.id, `${where}.id`);
    if (seen.has(id)) fail("mp_sensitivity_register_invalid", `Duplicate mechanism id ${id}.`, { id });
    seen.add(id);
    const summary = text(mechanism.summary, `${where}.summary`);
    if (!Array.isArray(mechanism.forks) || mechanism.forks.length === 0)
      fail("mp_sensitivity_register_invalid", `${where}.forks must be a non-empty array.`);
    const forks = mechanism.forks.map((fork, forkIndex) => {
      const forkWhere = `${where}.forks[${forkIndex}]`;
      const file = text(fork.file, `${forkWhere}.file`);
      const source = sources[file];
      if (!source) fail("mp_sensitivity_seam_source_missing", `No decompiled source for ${file}.`, { file });
      const signature = text(fork.signature, `${forkWhere}.signature`);
      const body = extractMethodBody(source.text, signature);
      if (body === null)
        fail("mp_sensitivity_seam_signature_missing", `Signature not found in ${file}.`, { file, signature });
      const predicate = text(fork.predicate, `${forkWhere}.predicate`);
      if (!body.includes(predicate))
        fail(
          "mp_sensitivity_mechanism_fork_drift",
          `${id} cites ${predicate} in ${file} ${signature} but the exact source does not contain it.`,
          { id, file, signature, predicate },
        );
      const forkClass = fork.forkClass;
      if (!MECHANISM_FORK_CLASSES.includes(forkClass))
        fail("mp_sensitivity_register_invalid", `Invalid ${forkWhere}.forkClass.`, { id, forkClass });
      return Object.freeze({
        file,
        signature,
        predicate,
        forkClass,
        reason: text(fork.reason, `${forkWhere}.reason`),
      });
    });
    return Object.freeze({ id, summary, forks: Object.freeze(forks) });
  });
  return Object.freeze(validated);
}

export const SEAM_SENSITIVITY = Object.freeze(["mp-insensitive", "mp-observational", "mp-semantic"]);
export const REQUIRED_LIVE_TOPOLOGY = Object.freeze(["single_player_native_companion", "shared_world_multiplayer"]);
export const ADMISSION_VERDICTS = Object.freeze([
  "admits_multiplayer",
  "rejects_multiplayer",
  // Read-only actions are served by the navigation/scene read pipelines, which
  // never create an execution and therefore have no admission guard at all.
  "read_only",
]);

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function text(value, field, details) {
  if (typeof value !== "string" || !value.trim()) fail("mp_sensitivity_register_invalid", `Expected non-empty ${field}.`, details);
  return value;
}

/**
 * Extract the body of a method identified by an exact signature prefix from one
 * source text, by brace balancing. Returns null when the signature is absent.
 */
export function extractMethodBody(sourceText, signature) {
  const start = sourceText.indexOf(signature);
  if (start < 0) return null;
  let depth = 0;
  let started = false;
  for (let index = start; index < sourceText.length; index += 1) {
    const character = sourceText[index];
    if (character === "{") {
      depth += 1;
      started = true;
    } else if (character === "}") {
      depth -= 1;
      if (started && depth === 0) return sourceText.slice(start, index + 1);
    }
  }
  return null;
}

/** Distinct decisive multiplayer tokens present in a method body. */
export function collectDecisiveTokens(bodyText) {
  const seen = new Set();
  for (const match of bodyText.match(MP_DECISIVE_PATTERN) ?? []) seen.add(match.replace(/\.$/, ""));
  return [...seen].sort();
}

/** Distinct mode-neutral context tokens present in a method body. */
export function collectContextTokens(bodyText) {
  const seen = new Set();
  for (const match of bodyText.match(MP_CONTEXT_PATTERN) ?? []) seen.add(match.replace(/\.$/, ""));
  return [...seen].sort();
}

/**
 * Re-derive, from the exact decompiled sources, the multiplayer tokens present
 * in every registered native seam.
 */
export function deriveNativeSeamEvidence(seams, sources) {
  if (!Array.isArray(seams)) fail("mp_sensitivity_register_invalid", "Expected seams array.");
  return seams.map((seam) => {
    const kind = seam.kind ?? "native";
    if (!SEAM_KINDS.includes(kind)) fail("mp_sensitivity_register_invalid", `Invalid seam kind ${kind}.`, { kind });
    if (kind === "mod_owned") {
      // The action has no native seam: the Mod implements the whole mutation
      // itself (body movement, emotes, facing). There is no game method whose
      // multiplayer behaviour could differ, so the seam is inline by definition.
      const authority = text(seam.authority, "mod_owned seam.authority");
      return Object.freeze({
        kind,
        authority,
        file: null,
        signature: null,
        decisiveTokens: Object.freeze([]),
        contextTokens: Object.freeze([]),
      });
    }
    const file = text(seam.file, "seam.file");
    const source = sources[file];
    if (!source) fail("mp_sensitivity_seam_source_missing", `No decompiled source for ${file}.`, { file });
    const signature = text(seam.signature, "seam.signature");
    const body = extractMethodBody(source.text, signature);
    if (body === null)
      fail("mp_sensitivity_seam_signature_missing", `Signature not found in ${file}.`, { file, signature });
    return Object.freeze({
      kind,
      file,
      signature,
      decisiveTokens: Object.freeze(collectDecisiveTokens(body)),
      contextTokens: Object.freeze(collectContextTokens(body)),
    });
  });
}

/**
 * Validate one action entry and return its derived defect list.
 */
function validateAction(action, sources, index, scopeAcksByAction) {
  const where = `actions[${index}]`;
  const actionId = text(action.actionId, `${where}.actionId`);
  // The full ladder from design/10 section 3.1.1: experimental -> live_verified ->
  // published. `live_verified` is a real resting state (a live run passed, no
  // independent review yet), so it must be admitted here rather than rejected as
  // an unknown lifecycle -- the gate's job is multiplayer scope, not publication
  // ranking.
  if (!["published", "live_verified", "experimental"].includes(action.lifecycle))
    fail("mp_sensitivity_register_invalid", `Invalid lifecycle for ${actionId}.`, { actionId, lifecycle: action.lifecycle });

  if (!Array.isArray(action.seams) || action.seams.length === 0)
    fail("mp_sensitivity_register_invalid", `${actionId} must declare at least one native seam.`, { actionId });
  const evidence = deriveNativeSeamEvidence(action.seams, sources);

  for (const [seamIndex, seam] of action.seams.entries()) {
    const sensitivity = seam.sensitivity;
    if (!SEAM_SENSITIVITY.includes(sensitivity))
      fail("mp_sensitivity_register_invalid", `Invalid sensitivity for ${actionId}.seams[${seamIndex}].`, { actionId, sensitivity });
    const decisive = evidence[seamIndex].decisiveTokens;
    const context = evidence[seamIndex].contextTokens;
    const isNative = (seam.kind ?? "native") === "native";
    if ((seam.kind ?? "native") === "mod_owned" && sensitivity !== "mp-insensitive")
      fail(
        "mp_sensitivity_register_invalid",
        `${actionId} declares a mod_owned seam as ${sensitivity}; a Mod-owned mutation has no native seam to be sensitive to.`,
        { actionId },
      );
    if (sensitivity === "mp-insensitive" && decisive.length > 0)
      fail(
        "mp_sensitivity_classification_drift",
        `${actionId} declares ${seam.file} mp-insensitive but the exact source reads the decisive token(s) ${decisive.join(", ")}.`,
        { actionId, file: seam.file, sensitivity, decisiveTokens: decisive },
      );
    // A mode-neutral-context read must be explained, not regex-ed away.
    if (isNative && context.length > 0 && sensitivity === "mp-insensitive")
      text(seam.modeNeutralReason ?? "", `${actionId}.seams[${seamIndex}].modeNeutralReason`);
    if (sensitivity !== "mp-insensitive" && isNative && decisive.length === 0 && context.length === 0)
      fail(
        "mp_sensitivity_classification_drift",
        `${actionId} declares ${seam.file} ${sensitivity} but the exact source reads no multiplayer token.`,
        { actionId, file: seam.file, sensitivity },
      );
    // Context-only sensitivity must be declared as such, with the reason on record.
    // An mp-observational seam that DOES read a decisive token must also say why
    // that read cannot change the transaction outcome; otherwise a reviewer cannot
    // tell a genuine collateral effect from a swallowed real one.
    if (sensitivity === "mp-observational" && isNative)
      text(seam.observedEffect ?? "", `${actionId}.seams[${seamIndex}].observedEffect`);
    if (sensitivity !== "mp-insensitive" && isNative && decisive.length === 0 && sensitivity !== "mp-semantic")
      text(seam.contextEffect ?? "", `${actionId}.seams[${seamIndex}].contextEffect`);
    if (sensitivity === "mp-semantic" && !text(seam.semanticEffect ?? "", `${actionId}.seams[${seamIndex}].semanticEffect`))
      fail(
        "mp_sensitivity_register_invalid",
        `${actionId} declares ${seam.file} mp-semantic without recording the semantic effect.`,
        { actionId, file: seam.file },
      );
  }

  const derivedSensitivity = evidence.some((seam, seamIndex) => action.seams[seamIndex].sensitivity === "mp-semantic")
    ? "mp-semantic"
    : evidence.some((seam, seamIndex) => action.seams[seamIndex].sensitivity === "mp-observational")
      ? "mp-observational"
      : "mp-insensitive";

  const admission = action.admission;
  if (!admission || !ADMISSION_VERDICTS.includes(admission.verdict))
    fail("mp_sensitivity_register_invalid", `Invalid admission verdict for ${actionId}.`, { actionId });
  if (admission.verdict === "rejects_multiplayer") text(admission.reasonCode, `${actionId}.admission.reasonCode`);

  const requiredTopology = text(action.requiredLiveTopology, `${actionId}.requiredLiveTopology`);
  if (!REQUIRED_LIVE_TOPOLOGY.includes(requiredTopology))
    fail("mp_sensitivity_register_invalid", `Invalid requiredLiveTopology for ${actionId}.`, { actionId, requiredTopology });

  // Policy: an action whose native seam can change its transaction outcome under
  // multiplayer must be gated by an actual multiplayer live run, not a
  // single-player one. This is the rule that keeps future actions honest.
  if (derivedSensitivity === "mp-semantic" && requiredTopology !== "shared_world_multiplayer")
    fail(
      "mp_sensitivity_topology_understated",
      `${actionId} has an mp-semantic native seam but requires only ${requiredTopology} live evidence.`,
      { actionId, derivedSensitivity, requiredTopology },
    );
  if (derivedSensitivity === "mp-insensitive" && requiredTopology === "shared_world_multiplayer")
    fail(
      "mp_sensitivity_topology_overstated",
      `${actionId} has only mp-insensitive seams but requires shared_world_multiplayer live evidence.`,
      { actionId, derivedSensitivity, requiredTopology },
    );

  const defects = [];
  if (admission.verdict === "read_only") {
    // A read pipeline mutates nothing; there is no admission to be restrictive.
    return Object.freeze({
      actionId,
      lifecycle: action.lifecycle,
      derivedSensitivity,
      admission: admission.verdict,
      requiredLiveTopology: requiredTopology,
      evidence: Object.freeze(evidence),
      defects: Object.freeze([]),
      rawDefects: Object.freeze([]),
      acknowledged: Object.freeze([]),
    });
  }
  // Product rule: GameBuddy is a companion that joins the player's world, so
  // multiplayer IS the product topology. Any admission that rejects a shared
  // world must carry a native justification, or be openly pinned as a gap.
  if (admission.verdict === "rejects_multiplayer" && derivedSensitivity !== "mp-semantic")
    defects.push(
      Object.freeze({
        actionId,
        defect: "over_restriction",
        detail: `Admission rejects multiplayer (${admission.reasonCode}) but no native seam reads outcome-affecting multiplayer state: ${evidence
          .map((seam) =>
            seam.kind === "mod_owned"
              ? `${seam.authority}[mod-owned]`
              : `${seam.file}[${seam.decisiveTokens.length} decisive, ${seam.contextTokens.length} context]`,
          )
          .join(", ")}. The rejection has no native justification.`,
      }),
    );
  if (admission.verdict === "rejects_multiplayer" && derivedSensitivity === "mp-semantic")
    defects.push(
      Object.freeze({
        actionId,
        defect: "mp_sensitive_exclusion",
        detail: `Admission rejects multiplayer (${admission.reasonCode}) although a native seam reads outcome-affecting multiplayer state, so the native path does support a shared world.`,
      }),
    );
  if (admission.verdict === "admits_multiplayer" && derivedSensitivity === "mp-semantic")
    defects.push(
      Object.freeze({
        actionId,
        defect: "unverified_scope",
        detail: "Admission admits multiplayer but a native seam reads multiplayer state that can change the transaction outcome.",
      }),
    );

  // A defect may be pinned as known with an explicit reason and owner. Pinned
  // defects are reported but do not fail the gate; unpinned ones do. Nothing
  // may be pinned without a reason, so suppression cannot be silent.
  const rawDefects = [...defects];
  const acknowledged = [];
  const ack = action.acknowledgedDefect ?? scopeAcksByAction?.get(actionId);
  if (ack) {
    text(ack.reason, `${actionId}.acknowledgedDefect.reason`);
    text(ack.owner, `${actionId}.acknowledgedDefect.owner`);
    if (ack.defect !== "over_restriction" && ack.defect !== "unverified_scope" && ack.defect !== "mp_sensitive_exclusion")
      fail("mp_sensitivity_register_invalid", `Invalid acknowledgedDefect.defect for ${actionId}.`, { actionId });
    const matched = defects.find((defect) => defect.defect === ack.defect);
    if (!matched)
      fail(
        "mp_sensitivity_stale_acknowledgement",
        `${actionId} pins ${ack.defect} but that defect is no longer derived. Remove the stale acknowledgement.`,
        { actionId, defect: ack.defect },
      );
    acknowledged.push(Object.freeze({ ...matched, reason: ack.reason, owner: ack.owner }));
    defects.splice(defects.indexOf(matched), 1);
  }

  return Object.freeze({
    actionId,
    lifecycle: action.lifecycle,
    derivedSensitivity,
    admission: admission.verdict,
    requiredLiveTopology: requiredTopology,
    evidence: Object.freeze(evidence),
    defects: Object.freeze(defects),
    rawDefects: Object.freeze(rawDefects),
    acknowledged: Object.freeze(acknowledged),
  });
}

/**
 * Validate a whole register against exact decompiled sources.
 * Returns a frozen report; throws on structural invalidity only.
 */
export function validateMultiplayerSensitivityRegister(register, sources) {
  if (!register || typeof register !== "object") fail("mp_sensitivity_register_invalid", "Expected register object.");
  if (register.schemaVersion !== 1) fail("mp_sensitivity_register_invalid", "Unsupported schemaVersion.");
  if (register.artifactKind !== "stardew_native_multiplayer_sensitivity")
    fail("mp_sensitivity_register_invalid", "Unexpected artifactKind.");
  if (!Array.isArray(register.actions) || register.actions.length === 0)
    fail("mp_sensitivity_register_invalid", "Expected non-empty actions array.");

  const mechanisms = validateMultiplayerMechanisms(register.mechanisms, sources);
  const requiredSharedWorldMechanisms = deriveRequiredSharedWorldMechanisms(mechanisms);

  const scopeAcks = (register.scopeAcknowledgements ?? []).map((scope, index) => {
    const where = `scopeAcknowledgements[${index}]`;
    const isMechanism = scope.defect === "unverified_mechanism_scope";
    if (scope.defect !== "over_restriction" && scope.defect !== "unverified_scope" && scope.defect !== "mp_sensitive_exclusion" && !isMechanism)
      fail("mp_sensitivity_register_invalid", `Invalid ${where}.defect.`, { defect: scope.defect });
    // Mechanism pins name mechanisms; action pins name actions. Never both, never neither.
    const key = isMechanism ? "mechanisms" : "actions";
    if (!isMechanism && !Array.isArray(scope.actions))
      fail("mp_sensitivity_register_invalid", `${where}.actions must be an array.`);
    if (isMechanism && !Array.isArray(scope.mechanisms))
      fail("mp_sensitivity_register_invalid", `${where}.mechanisms must be an array.`);
    const ids = scope[key];
    if (!Array.isArray(ids) || ids.length === 0)
      fail("mp_sensitivity_register_invalid", `${where}.${key} must be a non-empty array.`);
    return Object.freeze({
      defect: scope.defect,
      actions: Object.freeze((scope.actions ?? []).map((id) => text(id, `${where}.actions[]`))),
      mechanisms: Object.freeze((scope.mechanisms ?? []).map((id) => text(id, `${where}.mechanisms[]`))),
      reason: text(scope.reason, `${where}.reason`),
      owner: text(scope.owner, `${where}.owner`),
    });
  });
  const scopeAcksByAction = new Map();
  for (const scope of scopeAcks)
    for (const id of scope.actions) scopeAcksByAction.set(id, { defect: scope.defect, reason: scope.reason, owner: scope.owner });

  const actions = register.actions.map((action, index) => validateAction(action, sources, index, scopeAcksByAction));

  const seen = new Set();
  for (const action of actions) {
    if (seen.has(action.actionId)) fail("mp_sensitivity_register_invalid", `Duplicate actionId ${action.actionId}.`);
    seen.add(action.actionId);
  }
  const declared = register.declaredActionIds;
  if (!Array.isArray(declared) || declared.length !== actions.length)
    fail("mp_sensitivity_register_invalid", "declaredActionIds must cover every action exactly once.");
  for (const actionId of declared) if (!seen.has(actionId)) fail("mp_sensitivity_register_invalid", `declaredActionIds names unknown ${actionId}.`);

  const defects = actions.flatMap((action) => action.defects);
  // Every scope acknowledgement must still be justified by a derived finding, so
  // a policy pin cannot silently outlive the gap it describes. Action pins are
  // justified by a derived action defect; mechanism pins by a derived mechanism.
  for (const scope of scopeAcks) {
    const stillDerived =
      scope.defect === "unverified_mechanism_scope"
        ? scope.mechanisms.some((id) => requiredSharedWorldMechanisms.includes(id))
        : actions.some(
            (action) =>
              scope.actions.includes(action.actionId) &&
              action.rawDefects.some((defect) => defect.defect === scope.defect),
          );
    if (!stillDerived)
      fail(
        "mp_sensitivity_stale_acknowledgement",
        `Policy pin for ${scope.defect} over ${[...scope.actions, ...scope.mechanisms].join(", ")} is stale: nothing still derives it.`,
        { defect: scope.defect, actions: scope.actions, mechanisms: scope.mechanisms },
      );
  }
  return Object.freeze({
    actionCount: actions.length,
    actions: Object.freeze(actions),
    defects: Object.freeze(defects),
    scopeAcknowledgements: Object.freeze(scopeAcks),
    acknowledged: Object.freeze(actions.flatMap((action) => action.acknowledged)),
    overRestricted: Object.freeze(defects.filter((defect) => defect.defect === "over_restriction")),
    mpSensitiveExclusions: Object.freeze(defects.filter((defect) => defect.defect === "mp_sensitive_exclusion")),
    unverifiedScope: Object.freeze(defects.filter((defect) => defect.defect === "unverified_scope")),
    mechanisms: Object.freeze(mechanisms),
    requiredSharedWorldMechanisms: Object.freeze(requiredSharedWorldMechanisms),
  });
}
