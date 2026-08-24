import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const SCENARIO_IDS = Object.freeze(["SIM-01", "SIM-02", "SIM-03", "SIM-04", "SIM-05"]);
const RUN_ORDER = Object.freeze(["SIM-01", "SIM-02", "SIM-04", "SIM-05", "SIM-03"]);
const TOPOLOGY = "native_ai_farmhand_multiplayer";
const EVENT_KEYS = Object.freeze([
  "kind",
  "eventId",
  "epoch",
  "toolId",
  "published",
  "ownerId",
  "receiptId",
  "presentationId",
  "source",
  "hidden",
  "naturalLanguageHeuristic",
  "phraseId",
  "timingProfile",
  "stopId",
  "terminal",
  "scopeAllowed",
  "windowId",
]);
const EVENT_KINDS = new Set([
  "player_input",
  "redirect",
  "action_dispatch",
  "authoritative_progress",
  "terminal_receipt",
  "stop_receipt",
  "silence_window_receipt",
  "scope_receipt",
  "presentation",
  "speech",
  "text",
]);
const SOURCES = new Set(["fixture", "host", "bridge", "mod"]);
const HEURISTICS = new Set(["none", "possible_natural_language"]);
const TIMING_PROFILES = new Set(["active_execution", "provider_or_tool_wait"]);
const OPAQUE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VERSION = /^[0-9][0-9A-Za-z._-]{0,31}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
export const COMPANION_FIXTURE_EVIDENCE_SCHEMA = "gamebuddy_stardew_companion_fixture_evidence/v1";
const SUMMARY_KEYS = Object.freeze(["schema", "suiteId", "evidenceClass", "scenarios", "evidenceDigest"]);
const fixtureRoot = new URL("../../fixtures/stardew/companion-live/", import.meta.url);

export class CompanionLiveScenarioError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = "CompanionLiveScenarioError";
    this.code = code;
    this.detail = detail;
  }
}
function object(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CompanionLiveScenarioError(code);
  return value;
}
function exactKeys(value, allowed, code) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new CompanionLiveScenarioError(code);
}
function phraseIdValid(value) {
  return typeof value === "string" && /^(open_help|redirect|stop|silence|reject):[1-4]$/.test(value);
}
function opaqueId(value) {
  return typeof value === "string" && OPAQUE_ID.test(value);
}
function boundedInteger(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1_000_000_000;
}
function expectedPhrase(id, manifest) {
  return `${scenarioFor(id, manifest).phraseSet}:1`;
}
function scenarioFor(id, manifest) {
  const scenario = manifest.scenarios.find((item) => item.id === id);
  if (!scenario) throw new CompanionLiveScenarioError("scenario_manifest_contract_mismatch");
  return scenario;
}
function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** The versioned JSON fixtures are the only source of scenario and phrase content. */
export async function loadCompanionLiveFixtures({ read = readFile } = {}) {
  try {
    const [manifest, phrases] = await Promise.all([
      read(new URL("scenarios.v1.json", fixtureRoot), "utf8"),
      read(new URL("phrases.zh-CN.v1.json", fixtureRoot), "utf8"),
    ]);
    return Object.freeze({
      manifest: validateScenarioManifest(JSON.parse(manifest)),
      phrases: validatePhraseManifest(JSON.parse(phrases)),
    });
  } catch (error) {
    if (error instanceof CompanionLiveScenarioError) throw error;
    throw new CompanionLiveScenarioError("companion_fixture_json_unavailable");
  }
}
export function validateScenarioManifest(input) {
  object(input, "scenario_manifest_contract_mismatch");
  if (
    Object.keys(input).sort().join(",") !== "scenarios,schemaVersion,suiteId" ||
    input.schemaVersion !== 1 ||
    input.suiteId !== "stardew_companion_live_v1" ||
    !Array.isArray(input.scenarios) ||
    input.scenarios.length !== SCENARIO_IDS.length ||
    input.scenarios.map((scenario) => scenario.id).join(",") !== SCENARIO_IDS.join(",")
  )
    throw new CompanionLiveScenarioError("scenario_manifest_contract_mismatch");
  for (const scenario of input.scenarios) {
    object(scenario, "scenario_manifest_contract_mismatch");
    const keys = [
      "id",
      "version",
      "topology",
      "phraseSet",
      "trigger",
      "attachmentReuseGroup",
      "worldCheckpointId",
      "events",
      "timeoutMs",
      "assertions",
      "nonInheritableEvidence",
    ];
    if (
      Object.keys(scenario).length !== keys.length ||
      Object.keys(scenario).some((key) => !keys.includes(key)) ||
      scenario.version !== 1 ||
      scenario.topology !== TOPOLOGY ||
      !/^(open_help|redirect|stop|silence|reject)$/.test(scenario.phraseSet) ||
      !/^run_[ab]$/.test(scenario.attachmentReuseGroup) ||
      scenario.worldCheckpointId !== "fresh_coop_day" ||
      !boundedInteger(scenario.timeoutMs) ||
      scenario.timeoutMs === 0 ||
      scenario.timeoutMs > 120000
    )
      throw new CompanionLiveScenarioError("scenario_manifest_contract_mismatch");
    object(scenario.trigger, "scenario_manifest_contract_mismatch");
    if (
      Object.keys(scenario.trigger).join(",") !== "kind" ||
      !["initial_ready", "active_execution", "post_process_milestone"].includes(scenario.trigger.kind) ||
      !Array.isArray(scenario.events) ||
      scenario.events.length !== 1 ||
      !object(scenario.events[0], "scenario_manifest_contract_mismatch") ||
      !Array.isArray(scenario.assertions) ||
      scenario.assertions.length === 0 ||
      scenario.assertions.some(
        (assertion) => typeof assertion !== "string" || !/^[a-z][a-z_]{2,63}$/.test(assertion),
      ) ||
      !Array.isArray(scenario.nonInheritableEvidence) ||
      scenario.nonInheritableEvidence.length === 0 ||
      scenario.nonInheritableEvidence.some((field) => typeof field !== "string" || !/^[a-z][A-Za-z0-9]*$/.test(field))
    )
      throw new CompanionLiveScenarioError("scenario_manifest_contract_mismatch");
    const event = scenario.events[0];
    if (scenario.id === "SIM-03") {
      if (
        Object.keys(event).sort().join(",") !== "kind,timingProfiles" ||
        event.kind !== "stop_all" ||
        !Array.isArray(event.timingProfiles) ||
        event.timingProfiles.join(",") !== "active_execution,provider_or_tool_wait"
      )
        throw new CompanionLiveScenarioError("scenario_manifest_contract_mismatch");
    } else if (
      Object.keys(event).join(",") !== "kind" ||
      !["player_input", "redirect", "silence_window"].includes(event.kind)
    )
      throw new CompanionLiveScenarioError("scenario_manifest_contract_mismatch");
  }
  return Object.freeze(input);
}
export function validatePhraseManifest(input) {
  object(input, "phrase_manifest_contract_mismatch");
  if (
    Object.keys(input).sort().join(",") !== "integrity,locale,phraseSets,revision,schemaVersion" ||
    input.schemaVersion !== 1 ||
    input.locale !== "zh-CN" ||
    typeof input.revision !== "string" ||
    !input.phraseSets ||
    typeof input.phraseSets !== "object" ||
    Array.isArray(input.phraseSets) ||
    Object.keys(input.phraseSets).sort().join(",") !== "open_help,redirect,reject,silence,stop"
  )
    throw new CompanionLiveScenarioError("phrase_manifest_contract_mismatch");
  if (
    Object.values(input.phraseSets).some(
      (phrases) =>
        !Array.isArray(phrases) ||
        phrases.length !== 4 ||
        phrases.some((phrase) => typeof phrase !== "string" || phrase.length === 0 || phrase.length > 256),
    )
  )
    throw new CompanionLiveScenarioError("phrase_manifest_contract_mismatch");
  const actual = `sha256:${digest({ schemaVersion: input.schemaVersion, locale: input.locale, revision: input.revision, phraseSets: input.phraseSets })}`;
  if (input.integrity !== actual) throw new CompanionLiveScenarioError("phrase_manifest_integrity_invalid");
  return Object.freeze(input);
}
function requireFixturePort(adapter) {
  if (
    !adapter ||
    adapter.controlPortKind !== "stardew_companion_control_v1" ||
    ["awaitTrigger", "collectScenarioEvidence", "sendPlayerInput", "redirect", "stopAll", "awaitSilenceWindow"].some(
      (name) => typeof adapter[name] !== "function",
    )
  )
    throw new CompanionLiveScenarioError("deterministic_fixture_control_port_unavailable");
}
export async function runScenarioSuite({ manifest, phrases, adapter }) {
  validateScenarioManifest(manifest);
  validatePhraseManifest(phrases);
  requireFixturePort(adapter);
  const results = [];
  for (const id of RUN_ORDER) {
    const scenario = scenarioFor(id, manifest);
    const before = await adapter.collectScenarioEvidence({ scenarioId: id, phase: "before" });
    if (!Array.isArray(before?.unsettledExecutionOwners) || before.unsettledExecutionOwners.length)
      throw new CompanionLiveScenarioError("previous_execution_owner_unsettled");
    await adapter.awaitTrigger({ scenarioId: id, trigger: scenario.trigger, timeoutMs: scenario.timeoutMs });
    const phraseId = `${scenario.phraseSet}:1`,
      phrase = phrases.phraseSets[scenario.phraseSet][0];
    for (const event of scenario.events) {
      if (event.kind === "player_input") await adapter.sendPlayerInput({ scenarioId: id, phraseId, text: phrase });
      if (event.kind === "redirect")
        await adapter.redirect({ scenarioId: id, redirectId: `${id}:redirect-1`, phraseId, text: phrase });
      if (event.kind === "silence_window")
        await adapter.awaitSilenceWindow({ scenarioId: id, windowId: phrase, timeoutMs: scenario.timeoutMs });
      if (event.kind === "stop_all")
        for (const timingProfile of event.timingProfiles) {
          const stopId = `${id}:${timingProfile}:stop-1`;
          await adapter.stopAll({ scenarioId: id, stopId, timingProfile, phraseId });
          await adapter.stopAll({ scenarioId: id, stopId, timingProfile, phraseId });
        }
    }
    results.push(
      redactScenarioResult(
        id,
        phraseId,
        await adapter.collectScenarioEvidence({ scenarioId: id, phase: "after" }),
        manifest,
        phrases,
      ),
    );
  }
  return sealScenarioSuite({
    schema: COMPANION_FIXTURE_EVIDENCE_SCHEMA,
    suiteId: manifest.suiteId,
    evidenceClass: "deterministic_fixture",
    scenarios: results,
  });
}
export function sealScenarioSuite(summary) {
  const { evidenceDigest, ...unsigned } = object(summary, "summary_invalid");
  if (
    evidenceDigest !== undefined ||
    Object.keys(unsigned).length !== SUMMARY_KEYS.length - 1 ||
    Object.keys(unsigned).some((key) => !SUMMARY_KEYS.includes(key)) ||
    unsigned.schema !== COMPANION_FIXTURE_EVIDENCE_SCHEMA ||
    unsigned.suiteId !== "stardew_companion_live_v1" ||
    unsigned.evidenceClass !== "deterministic_fixture" ||
    !Array.isArray(unsigned.scenarios)
  )
    throw new CompanionLiveScenarioError("summary_invalid");
  return Object.freeze({ ...unsigned, evidenceDigest: digest(unsigned) });
}
function redactScenarioResult(scenarioId, phraseId, evidence, manifest, phrases) {
  if (
    !SCENARIO_IDS.includes(scenarioId) ||
    !phraseIdValid(phraseId) ||
    phraseId !== expectedPhrase(scenarioId, manifest)
  )
    throw new CompanionLiveScenarioError("scenario_identity_invalid");
  const safe = object(evidence, "scenario_evidence_invalid"),
    evidenceKeys = [
      "identity",
      "eventRange",
      "executionOwners",
      "receiptIds",
      "presentationIds",
      "events",
      "bodySettled",
      "verdict",
    ];
  if (scenarioId === "SIM-02") evidenceKeys.push("freshSnapshot");
  exactKeys(safe, evidenceKeys, "scenario_evidence_invalid");
  if (Object.keys(safe).length !== evidenceKeys.length || (scenarioId === "SIM-02" && !("freshSnapshot" in safe)))
    throw new CompanionLiveScenarioError("scenario_evidence_invalid");
  const copy = {
    scenarioId,
    phraseId,
    identity: redactIdentity(safe.identity),
    eventRange: redactRange(safe.eventRange),
    executionOwners: redactIds(safe.executionOwners),
    receiptIds: redactIds(safe.receiptIds),
    presentationIds: redactIds(safe.presentationIds),
    events: Array.isArray(safe.events)
      ? safe.events.map((event) => redactEvent(event, phrases))
      : (() => {
          throw new CompanionLiveScenarioError("scenario_event_evidence_invalid");
        })(),
    bodySettled: safe.bodySettled === true,
    verdict: safe.verdict,
  };
  if (scenarioId === "SIM-02") copy.freshSnapshot = redactSnapshot(safe.freshSnapshot);
  if (!["pass", "fail"].includes(copy.verdict))
    throw new CompanionLiveScenarioError("scenario_verdict_evidence_invalid");
  return { ...copy, evidenceDigest: digest(copy) };
}
function redactIdentity(value) {
  object(value, "scenario_identity_evidence_invalid");
  const keys = ["topology", "game", "smapi", "mod", "host", "model"];
  if (
    Object.keys(value).join(",") !== keys.join(",") ||
    value.topology !== TOPOLOGY ||
    keys.slice(1).some((key) => !VERSION.test(value[key]))
  )
    throw new CompanionLiveScenarioError("scenario_identity_evidence_invalid");
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}
function redactRange(value) {
  object(value, "scenario_range_evidence_invalid");
  if (
    Object.keys(value).join(",") !== "start,end" ||
    !boundedInteger(value.start) ||
    !boundedInteger(value.end) ||
    value.start > value.end
  )
    throw new CompanionLiveScenarioError("scenario_range_evidence_invalid");
  return { start: value.start, end: value.end };
}
function redactIds(value) {
  if (!Array.isArray(value) || value.some((item) => !opaqueId(item)))
    throw new CompanionLiveScenarioError("scenario_ids_evidence_invalid");
  return [...value];
}
function redactSnapshot(value) {
  object(value, "scenario_snapshot_evidence_invalid");
  if (
    Object.keys(value).some((key) => !["beforeReplacement", "oldEpoch"].includes(key)) ||
    typeof value.beforeReplacement !== "boolean" ||
    !boundedInteger(value.oldEpoch)
  )
    throw new CompanionLiveScenarioError("scenario_snapshot_evidence_invalid");
  return { beforeReplacement: value.beforeReplacement, oldEpoch: value.oldEpoch };
}
function redactEvent(value, phrases) {
  object(value, "scenario_event_evidence_invalid");
  exactKeys(value, EVENT_KEYS, "scenario_event_evidence_invalid");
  const windows = new Set(phrases.phraseSets.silence);
  for (const [key, item] of Object.entries(value)) {
    const valid =
      (key === "kind" && EVENT_KINDS.has(item)) ||
      (["eventId", "epoch"].includes(key) && boundedInteger(item)) ||
      (["toolId", "ownerId", "receiptId", "presentationId"].includes(key) && opaqueId(item)) ||
      (key === "published" && typeof item === "boolean") ||
      (key === "source" && SOURCES.has(item)) ||
      (key === "hidden" && item === false) ||
      (key === "naturalLanguageHeuristic" && HEURISTICS.has(item)) ||
      (key === "phraseId" && phraseIdValid(item)) ||
      (key === "timingProfile" && TIMING_PROFILES.has(item)) ||
      (key === "stopId" &&
        typeof item === "string" &&
        /^SIM-03:(active_execution|provider_or_tool_wait):stop-1$/.test(item)) ||
      (["terminal", "scopeAllowed"].includes(key) && typeof item === "boolean") ||
      (key === "windowId" && windows.has(item));
    if (!valid) throw new CompanionLiveScenarioError("scenario_event_evidence_invalid");
  }
  return Object.fromEntries(EVENT_KEYS.filter((key) => key in value).map((key) => [key, value[key]]));
}
function scenarioIngressValid(result) {
  try {
    object(result, "scenario_ingress_invalid");
    if (!SCENARIO_IDS.includes(result.scenarioId) || !phraseIdValid(result.phraseId)) return false;
    const expectedKeys = [
      "scenarioId",
      "phraseId",
      "identity",
      "eventRange",
      "executionOwners",
      "receiptIds",
      "presentationIds",
      "events",
      "bodySettled",
      "verdict",
      "evidenceDigest",
    ];
    if (result.scenarioId === "SIM-02") expectedKeys.splice(-1, 0, "freshSnapshot");
    if (
      Object.keys(result).length !== expectedKeys.length ||
      Object.keys(result).some((key) => !expectedKeys.includes(key)) ||
      typeof result.evidenceDigest !== "string" ||
      !SHA256_HEX.test(result.evidenceDigest)
    )
      return false;
    const { evidenceDigest, ...unsigned } = structuredClone(result);
    return digest(unsigned) === evidenceDigest;
  } catch {
    return false;
  }
}
function redactionValid(result, manifest, phrases) {
  try {
    if (!scenarioIngressValid(result)) return false;
    validateScenarioManifest(manifest);
    validatePhraseManifest(phrases);
    const {
      scenarioId,
      phraseId,
      identity,
      eventRange,
      executionOwners,
      receiptIds,
      presentationIds,
      events,
      bodySettled,
      freshSnapshot,
      verdict,
    } = structuredClone(result);
    if (phraseId !== expectedPhrase(scenarioId, manifest)) return false;
    redactScenarioResult(
      scenarioId,
      phraseId,
      {
        identity,
        eventRange,
        executionOwners,
        receiptIds,
        presentationIds,
        events,
        bodySettled,
        ...(scenarioId === "SIM-02" ? { freshSnapshot } : {}),
        verdict,
      },
      manifest,
      phrases,
    );
    return true;
  } catch {
    return false;
  }
}
function summaryEnvelopeValid(run) {
  try {
    if (
      !run ||
      typeof run !== "object" ||
      Array.isArray(run) ||
      Object.keys(run).length !== SUMMARY_KEYS.length ||
      Object.keys(run).some((key) => !SUMMARY_KEYS.includes(key)) ||
      run.schema !== COMPANION_FIXTURE_EVIDENCE_SCHEMA ||
      run.suiteId !== "stardew_companion_live_v1" ||
      run.evidenceClass !== "deterministic_fixture" ||
      !Array.isArray(run.scenarios) ||
      typeof run.evidenceDigest !== "string" ||
      !SHA256_HEX.test(run.evidenceDigest)
    )
      return false;
    const { evidenceDigest, ...unsigned } = structuredClone(run);
    return digest(unsigned) === evidenceDigest;
  } catch {
    return false;
  }
}
function failedScore(failures) {
  return Object.freeze({
    verdict: "fail",
    failures: Object.freeze([...new Set(failures)]),
    reviewRequired: Object.freeze([]),
    evidenceClass: "deterministic_fixture",
  });
}
export function scoreScenarioSuite(run, { manifest, phrases } = {}) {
  if (!summaryEnvelopeValid(run)) return failedScore(["summary_envelope_invalid"]);
  if (run.scenarios.length !== SCENARIO_IDS.length) return failedScore(["scenario_results_incomplete"]);
  if (run.scenarios.some((result) => !scenarioIngressValid(result)))
    return failedScore(["scenario_result_ingress_invalid"]);
  if (run.scenarios.some((result) => !redactionValid(result, manifest, phrases)))
    return failedScore(["scenario_redaction_contract_invalid"]);
  const failures = [],
    reviewRequired = [],
    ids = new Set(),
    evidenceIds = new Set();
  for (const result of run.scenarios) {
    if (ids.has(result.scenarioId)) failures.push(`duplicate_scenario:${result.scenarioId}`);
    ids.add(result.scenarioId);
    for (const key of ["executionOwners", "receiptIds", "presentationIds"])
      for (const value of result[key]) {
        if (evidenceIds.has(value)) failures.push(`${result.scenarioId}:cross_scenario_evidence_reference`);
        evidenceIds.add(value);
      }
    scoreOne(result, failures, reviewRequired);
  }
  if ([...ids].sort().join(",") !== SCENARIO_IDS.join(",")) failures.push("scenario_result_set_invalid");
  return Object.freeze({
    verdict: failures.length ? "fail" : "pass",
    failures,
    reviewRequired,
    evidenceClass: "deterministic_fixture",
  });
}
function scoreOne(r, failures, review) {
  const id = r.scenarioId,
    fail = (code) => failures.push(`${id}:${code}`),
    events = r.events,
    actions = events.filter((event) => event.kind === "action_dispatch"),
    phrase = r.phraseId;
  if (r.verdict !== "pass") fail("sealed_scenario_verdict_failed");
  if (
    new Set(r.executionOwners).size !== r.executionOwners.length ||
    new Set(r.receiptIds).size !== r.receiptIds.length ||
    new Set(r.presentationIds).size !== r.presentationIds.length
  )
    fail("evidence_ids_invalid");
  const requiredPlayerEvent = id === "SIM-02" ? "redirect" : "player_input";
  if (
    ["SIM-01", "SIM-02", "SIM-05"].includes(id) &&
    (!events.some((event) => event.kind === requiredPlayerEvent && event.phraseId === phrase) ||
      events.some((event) => event.kind === requiredPlayerEvent && event.phraseId !== phrase))
  )
    fail("phrase_correlation_invalid");
  if (
    events.some(
      (event) =>
        event.eventId !== undefined && (event.eventId < r.eventRange.start || event.eventId > r.eventRange.end),
    )
  )
    fail("event_epoch_range_invalid");
  if (events.some((event) => event.toolId && event.published !== true)) fail("unpublished_tool");
  if (actions.some((event) => !r.executionOwners.includes(event.ownerId) || !r.receiptIds.includes(event.receiptId)))
    fail("action_owner_or_receipt_uncorrelated");
  if (
    id === "SIM-01" &&
    (!actions.some((event) => event.phraseId === phrase) ||
      !events.some(
        (event) =>
          ["authoritative_progress", "terminal_receipt"].includes(event.kind) && r.receiptIds.includes(event.receiptId),
      ))
  )
    fail("narration_only_or_missing_authoritative_execution");
  if (
    id === "SIM-02" &&
    (!r.freshSnapshot?.beforeReplacement || actions.some((event) => event.epoch === r.freshSnapshot.oldEpoch))
  )
    fail("redirect_fence_or_snapshot_invalid");
  if (id === "SIM-03") {
    const stops = events.filter((event) => event.kind === "stop_receipt");
    for (const profile of TIMING_PROFILES) {
      const expectedStop = `SIM-03:${profile}:stop-1`,
        matching = stops.filter(
          (event) =>
            event.timingProfile === profile &&
            event.stopId === expectedStop &&
            event.phraseId === phrase &&
            event.terminal === true &&
            r.receiptIds.includes(event.receiptId),
        );
      if (matching.length !== 2 || new Set(matching.map((event) => event.receiptId)).size !== 2)
        fail("stop_not_idempotent_or_terminal_missing");
    }
    const lateOldEpochEvent = events.some(
      (stop, index) =>
        stop.kind === "stop_receipt" &&
        events
          .slice(index + 1)
          .some(
            (event) =>
              event.epoch === stop.epoch && ["action_dispatch", "presentation", "speech", "text"].includes(event.kind),
          ),
    );
    if (
      stops.some(
        (event) =>
          event.phraseId !== phrase ||
          event.stopId !== `SIM-03:${event.timingProfile}:stop-1` ||
          !r.receiptIds.includes(event.receiptId),
      ) ||
      lateOldEpochEvent
    )
      fail("late_old_epoch_event");
  }
  if (
    id === "SIM-04" &&
    (!events.some(
      (event) =>
        event.kind === "silence_window_receipt" &&
        event.windowId === "no_input_for_window" &&
        event.terminal === true &&
        r.receiptIds.includes(event.receiptId),
    ) ||
      actions.length)
  )
    fail("silence_window_or_unprompted_action_invalid");
  if (
    id === "SIM-05" &&
    (!events.some(
      (event) =>
        event.kind === "scope_receipt" &&
        event.phraseId === phrase &&
        event.scopeAllowed === false &&
        r.receiptIds.includes(event.receiptId),
    ) ||
      actions.length)
  )
    fail("scope_expansion_invalid");
  if (["SIM-03", "SIM-04"].includes(id) && r.bodySettled !== true) fail("body_not_settled");
  for (const event of events)
    if (event.naturalLanguageHeuristic && event.naturalLanguageHeuristic !== "none")
      review.push(`${id}:${event.naturalLanguageHeuristic}`);
}
