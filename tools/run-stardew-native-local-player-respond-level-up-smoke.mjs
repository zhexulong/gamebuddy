/**
 * `respond_level_up` live proof (the level-up half of the modal family).
 *
 * The menu only appears at a night rollover, so this gate drives ONE night and then resolves what the rollover
 * put on screen: `advance_day` (the actor sleeps in its own bed, armed home by the fixture), the `LevelUpMenu`
 * the engine pushes for the pending entry (`Game1.cs:9130-9134`), `respond_level_up { choice: "confirm" }`, and a
 * fresh read-back proving the pair left `Farmer.newLevels` and the menu stopped being active.
 *
 * `confirm` is the only choice this gate exercises: it is the ONE value an ordinary level accepts, so it takes no
 * decision on the companion's behalf. A 5/10 milestone is a profession choice and belongs to the companion, which
 * is why the fixture arms an ordinary entry (combat at level 6, whose perk is `maxHealth += 5`).
 *
 * The fixture is the composed multi-day world, which already delivers exactly this Given - a world where days can
 * cross and one ordinary level-up is pending - rather than a second scenario that would duplicate it.
 */
import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForActionable,
  waitForFreshSnapshot,
  waitForTerminal,
  validateNativeLocalFixturePolicy,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const SCENARIO = "native_respond_level_up_v1";
const EXPECTED_ACTIONS = ["advance_day", "respond_level_up", "move_to_tile", "observe_scene"];
const REQUIRED_CAPABILITIES = ["advance_day", "respond_level_up", "move_to_tile", "observe_scene"].sort();

/** The pair the multi-day Given arms: combat (skill 4) at level 6, an ordinary level, never a milestone. */
const EXPECTED_SKILL = 4;
const EXPECTED_LEVEL = 6;

export const LEVEL_UP_RESOLVED_EVIDENCE_KEYS = Object.freeze([
  "modal_type",
  "skill",
  "level",
  "is_profession",
  "chosen_profession",
  "remaining_new_levels",
  "menu_closed",
]);

/** The Mod's `key=value;...` projection, refused when a key repeats (a malformed tuple is not a fact). */
export function parseStrictEvidence(evidence) {
  const detail = typeof evidence === "string" ? evidence : typeof evidence?.detail === "string" ? evidence.detail : "";
  const result = {};
  for (const part of detail.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0 || index === part.length - 1) continue;
    const key = part.slice(0, index);
    if (Object.hasOwn(result, key)) return {};
    result[key] = part.slice(index + 1);
  }
  return result;
}

/**
 * Does this run's final observation prove the menu is gone?
 *
 * The receipt's own evidence is the primary fact (the Mod read `newLevels` and the menu's active flag fresh after
 * the write), and the snapshot is the independent half: the actor must no longer be held, and the reported pair
 * must not have changed. Both are required, because a receipt that says `menu_closed=true` while the snapshot
 * still shows the modal would be a contradiction, not a pass.
 */
export function levelUpPostconditionHolds({ receiptEvidence, snapshot }) {
  const facts = parseStrictEvidence(receiptEvidence);
  const missing = LEVEL_UP_RESOLVED_EVIDENCE_KEYS.filter((key) => !Object.hasOwn(facts, key));
  if (missing.length > 0) return { ok: false, reasonCode: `level_up_evidence_incomplete:${missing.join(",")}`, facts };
  if (facts.modal_type !== "LevelUpMenu")
    return { ok: false, reasonCode: `level_up_modal_type:${facts.modal_type}`, facts };
  if (facts.is_profession !== "false")
    return { ok: false, reasonCode: `level_up_was_a_profession:${facts.is_profession}`, facts };
  if (facts.chosen_profession !== "none")
    return { ok: false, reasonCode: `level_up_chose_a_profession:${facts.chosen_profession}`, facts };
  if (facts.remaining_new_levels !== "0")
    return { ok: false, reasonCode: `level_up_left_entries:${facts.remaining_new_levels}`, facts };
  if (facts.menu_closed !== "true") return { ok: false, reasonCode: "level_up_menu_still_active", facts };
  if (String(facts.skill) !== String(EXPECTED_SKILL) || String(facts.level) !== String(EXPECTED_LEVEL)) {
    return { ok: false, reasonCode: `level_up_wrong_pair:${String(facts.skill)}@${String(facts.level)}`, facts };
  }
  // The independent half: nothing may still be holding the actor as a modal.
  if (snapshot?.actorDispositionKind === "modal") {
    return {
      ok: false,
      reasonCode: `level_up_snapshot_still_modal:${String(snapshot.actorDispositionDetail ?? "unknown")}`,
      facts,
    };
  }
  return { ok: true, reasonCode: null, facts };
}

export async function runRespondLevelUpSmoke(
  client,
  receipts,
  config,
  {
    terminalTimeoutMs = 30_000,
    nightTimeoutMs = 240_000,
    postconditionTimeoutMs = 20_000,
    stabilizeTimeoutMs = 10_000,
  } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalFixturePolicy(config, { requiredActions: EXPECTED_ACTIONS });
  try {
    let snapshot = await observeFresh(client);
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);

    // The actor must start inside the farmhouse for `advance_day` to begin a night at all
    // (`SleepAndAdvanceDayLifecycle`: it only walks to the bed from inside a FarmHouse).
    if (snapshot.location !== "FarmHouse") throw new Error(`actor_not_home:${String(snapshot.location)}`);
    const home = snapshot;
    trace.push({ step: "home", snapshot: summarizeSnapshot(home) });

    // ---- phase 1: the night the fixture's pending level-up is queued for ----
    const nightAccepted = await executeFresh(client, {
      action: "advance_day",
      args: {},
      snapshot: home,
      requestId: `respond_level_up_night_${String(Date.now())}`,
      idempotencyKey: `respond_level_up_night_${String(Date.now())}_idem`,
      timeoutMs: terminalTimeoutMs,
    });
    trace.push({ step: "night_dispatch", action: "advance_day", state: nightAccepted.state });
    if (nightAccepted.state !== "accepted")
      throw new Error(`advance_day_not_accepted:${String(nightAccepted.reasonCode)}`);
    const nightTerminal = await waitForTerminal(receipts, nightAccepted, nightTimeoutMs);
    if (nightTerminal.state !== "succeeded" || nightTerminal.reasonCode !== "day_advanced") {
      throw new Error(`advance_day_not_completed:${String(nightTerminal.state)}/${String(nightTerminal.reasonCode)}`);
    }
    trace.push({ step: "night", receipt: summarizeReceipt(nightTerminal) });

    // ---- phase 2: settle the menu the rollover raised ----
    // The menu is the actor's blocker, so the probe is a FRESH observation rather than the cached projection: a
    // stale snapshot could show the pre-rollover world and make the next dispatch look actionable when it is not.
    const onMenu = await waitForFreshSnapshot(client, {
      timeoutMs: postconditionTimeoutMs,
      check: (fresh) =>
        fresh.actorDispositionKind === "modal" && String(fresh.actorDispositionDetail ?? "") === "LevelUpMenu",
    }).catch(() => null);
    if (onMenu === null) throw new Error("level_up_menu_not_observed");
    trace.push({ step: "menu", snapshot: summarizeSnapshot(onMenu) });

    const resolved = await executeFresh(client, {
      action: "respond_level_up",
      args: { choice: "confirm", expectedSkill: EXPECTED_SKILL, expectedLevel: EXPECTED_LEVEL },
      snapshot: onMenu,
      requestId: `respond_level_up_${String(Date.now())}`,
      idempotencyKey: `respond_level_up_${String(Date.now())}_idem`,
      timeoutMs: terminalTimeoutMs,
    });
    trace.push({ step: "resolve_dispatch", action: "respond_level_up", state: resolved.state });
    if (resolved.state !== "accepted") throw new Error(`respond_level_up_not_accepted:${String(resolved.reasonCode)}`);
    const terminal = await waitForTerminal(receipts, resolved, terminalTimeoutMs);
    trace.push({ step: "resolve", receipt: summarizeReceipt(terminal) });
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "level_up_resolved") {
      throw new Error(`respond_level_up_not_completed:${String(terminal.state)}/${String(terminal.reasonCode)}`);
    }

    // ---- phase 3: fresh read-back, and the actor must be free again ----
    const after = await waitForActionable(client, onMenu, stabilizeTimeoutMs);
    const verdict = levelUpPostconditionHolds({ receiptEvidence: terminal.evidence, snapshot: after });
    trace.push({
      step: "after",
      snapshot: summarizeSnapshot(after),
      postcondition: verdict.reasonCode ?? "level_up_resolved",
    });
    if (!verdict.ok) throw new Error(verdict.reasonCode ?? "level_up_postcondition_unavailable");

    return {
      scenario: SCENARIO,
      state: "passed",
      reasonCode: null,
      durationMs: Date.now() - startedAt,
      levelUp: { skill: EXPECTED_SKILL, level: EXPECTED_LEVEL, choice: "confirm" },
      trace,
    };
  } catch (error) {
    return {
      scenario: SCENARIO,
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      durationMs: Date.now() - startedAt,
      trace,
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runRespondLevelUpSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
