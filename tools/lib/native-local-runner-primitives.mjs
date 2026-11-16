/**
 * L1: THE PRIMITIVES every `run-stardew-native-local-*.mjs` runner imports, instead of spelling privately.
 *
 * WHY THIS FILE EXISTS, measured on the tree at `3f660c7e`: 122 runner files, and inside them
 *
 *     parseEvidence                    defined privately in 49 of them
 *     parseStrictEvidence              defined privately in 32
 *     validateNativeLocalFixtureConfig defined privately in 29
 *     adjacent / sameTile              in 37 and 14
 *     validFixtureSlotRelationship     in 9
 *     connectWithRetry                 in 4, byte-identical in each
 *     waitForNavigationTerminal        in 3, byte-identical in each
 *
 * The lifecycle template (`native-local-runner-scaffold.mjs`) asked one question - "does this runner's whole lifecycle
 * match the template's?" - and 87 of 110 answered no. But whether a runner submits one frame or five has nothing to do
 * with how it parses an evidence string. Splitting the two layers is what lets a five-frame runner share the parser it
 * already duplicates. So this module holds the parts that are INDEPENDENT of what a runner does with them: nothing here
 * knows about a lifecycle, a scenario or a definition.
 *
 * WHAT IS NOT A PRIMITIVE, and why each stays in its runner. A primitive is the SAME function subject to the action's
 * own words; a different grammar is a different function, and pretending otherwise would be a behaviour change wearing a
 * shared name. The measured exceptions, each of which keeps its own copy and is named in this module's gate baseline:
 *
 *   `ride_bus`'s evidence parse reports the SHAPE of a non-string input (`type=...;shape=...`) - a diagnostic the shared
 *   strict parse does not carry
 *   `fence`'s strict parse asserts an exact key SET and then reports a second, distinct code for an incomplete one
 *   `dig-artifact-spot`'s strict parse additionally requires four numeric fields to be finite decimals
 *   `feed-animal`'s adjacency compares against a collector's SOURCE tile (`sourceX`/`sourceY`), not the collector's own
 *   `scene-reachable-probe`'s fixture check refuses nothing but `Enable`, deliberately - it is a probe, not a gate
 *
 * THE OPTIONS ARE THE MEASURED DIFFERENCES, not a wish list. Every option below exists because at least one private copy
 * encoded it, and the value each copy encoded was read out of its body (the comment on each function says which copies
 * and how many). An option nobody's copy used was not added: `parseEvidence` has no `trim`, because not one lenient copy
 * trimmed, and a parser that starts trimming is a parser whose keys changed.
 */
import {
  connectNativeLocalClient,
  delay,
  NativeSmokeHarnessError,
  validateNativeLocalFixturePolicy,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./host-test-module.mjs";

/** The topology the primitives report, spelled once. */
export const NATIVE_LOCAL_TOPOLOGY = "native_local_player_fixture";

/** The game creates its named pipe asynchronously after launch, so a first connect legitimately fails with ENOENT. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/* ---------------------------------------------------------------------------------------------------------------
 * EVIDENCE
 * ------------------------------------------------------------------------------------------------------------- */

/**
 * The LENIENT grammar: `a=1;b=2`, a pair without a name is dropped, an empty detail is a refusal.
 *
 * Verbatim from the 14 identical `parseEvidence` copies (`run-stardew-native-local-player-break-container-source-smoke.mjs`
 * and thirteen siblings) plus the 3 exported spellings (`dismount-transport`) and the 2 without the empty refusal
 * (`break-rock-source`, which now refuses on the emptiness it used to parse as `{}` - a runner whose evidence is empty
 * has no postcondition to assert, and this is the one place where the shared primitive is STRICTER than a copy).
 *
 * `requiredKeys`: the 6 `craft-partial-recovery-chain` copies took them and threw `native_local_evidence_missing_key:<k>`.
 * `emptyCode`: `enter-mine` spelled its own `enter_mine_evidence_empty`; every other copy used the default.
 *
 * `index > 0` is kept as it was: a leading `=` produces a pair with no name, which is a malformed detail rather than a
 * field called "".
 */
export function parseEvidence(evidence, { requiredKeys = [], emptyCode = "native_local_evidence_empty" } = {}) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error(emptyCode);
  const fields = Object.fromEntries(
    detail
      .split(";")
      .map((pair) => {
        const index = pair.indexOf("=");
        return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
      })
      .filter(Boolean),
  );
  for (const key of requiredKeys)
    if (typeof fields[key] !== "string") throw new Error(`native_local_evidence_missing_key:${key}`);
  return fields;
}

/**
 * The STRICT grammar: a pair that is not `name=value` is a refusal, not a field to skip.
 *
 * From the copies that throw rather than drop - `till-soil` and `mine-elevator` (trailing empty value, duplicate key),
 * `fertilize-tile`, `harvest-crop` and `machine-inspect` (also a key-shape regex, a value-length cap, duplicate keys),
 * `place-wood-fence` (key regex and an exact key set). The options are exactly their differences:
 *
 *   code            the refusal word; `${code}` alone when the copy had one word for every malformation
 *                   (`invalid_fertilize_evidence`), and the base of the two below when it had two
 *   missingCode     the empty-detail word (`mine_elevator_evidence_missing`); defaults to `code`
 *   malformedCode   the per-pair word, reported with the offending pair (`shop_evidence_malformed:<pair>`); defaults to
 *                   `code`
 *   keys            the exact key set the evidence must be, in any order; a set that differs is a refusal
 *   keyPattern      the key-shape regex (`/^[a-z][a-z0-9_]{0,63}$/` in the five copies that had one); null for none
 *   maxValueLength  the value cap those copies carried (512); null for none
 *   trim            the `mine-elevator`/`shop`/`enter-mine-ladder` copies trimmed names and values; nothing else did
 *
 * A string is accepted as well as `{ detail }`, because `mine-elevator`, `shop` and `ride-bus` read the raw detail and the
 * object form loses nothing: no caller passes both, and `usage: "<absent>"` still refuses with `missingCode`.
 */
export function parseStrictEvidence(
  evidence,
  {
    code = "native_local_evidence_malformed",
    missingCode = code,
    malformedCode = code,
    keys = null,
    keyPattern = null,
    maxValueLength = null,
    trim = false,
  } = {},
) {
  const detail = typeof evidence === "string" ? evidence : typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error(missingCode);
  const fields = {};
  for (const part of detail.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0 || index === part.length - 1) throw new Error(`${malformedCode}:${part}`);
    const key = trim ? part.slice(0, index).trim() : part.slice(0, index);
    const value = trim ? part.slice(index + 1).trim() : part.slice(index + 1);
    if (keyPattern !== null && !keyPattern.test(key)) throw new Error(`${malformedCode}:${part}`);
    if (maxValueLength !== null && value.length > maxValueLength) throw new Error(`${malformedCode}:${part}`);
    if (Object.hasOwn(fields, key)) throw new Error(`${malformedCode}:${part}`);
    fields[key] = value;
  }
  if (keys !== null) {
    const expected = new Set(keys);
    const actual = Object.keys(fields);
    const differs = actual.length !== expected.size || actual.some((key) => !expected.has(key));
    if (differs) throw new Error(`${malformedCode}:key_set:${actual.sort().join(",")}`);
  }
  return fields;
}

/**
 * The COMPLETE grammar: the same reading as `parseStrictEvidence`, answering `{}` instead of refusing.
 *
 * `wia-answer-question`'s four copies (and `respond-level-up`, `till-soil`, `place-wood-fence`'s second half) used this
 * to ask one question - "is this evidence mine?" - where a throw would have to be caught to answer it. That is a
 * different contract from a refusal, so it is a different primitive rather than an option on `parseStrictEvidence`: a
 * caller reading `{}` and a caller catching an error make different decisions about the same bytes.
 *
 * The empty-detail case answers `{}` as well, because every copy did: an evidence-less receipt is "not mine", not
 * "malformed".
 */
export function parseCompleteEvidence(evidence, { keys = null } = {}) {
  const detail = typeof evidence === "string" ? evidence : typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) return {};
  const fields = {};
  for (const part of detail.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0 || index === part.length - 1) return {};
    const key = part.slice(0, index);
    if (Object.hasOwn(fields, key)) return {};
    fields[key] = part.slice(index + 1);
  }
  if (keys !== null) {
    const expected = new Set(keys);
    const actual = Object.keys(fields);
    if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) return {};
  }
  return fields;
}

/* ---------------------------------------------------------------------------------------------------------------
 * THE FIXTURE CONFIG REFUSAL
 * ------------------------------------------------------------------------------------------------------------- */

/** The fixture's logical save name and the slot it must be observed under (`craft-partial-recovery-chain` and 8 more). */
export function validFixtureSlotRelationship(logicalName, observedSaveSlot) {
  return (
    typeof logicalName === "string" &&
    /^GameBuddyFixture[A-Za-z0-9]{0,64}$/u.test(logicalName) &&
    typeof observedSaveSlot === "string" &&
    new RegExp(`^${logicalName}_[0-9]{1,32}$`).test(observedSaveSlot)
  );
}

/**
 * The fixture-config refusal: ONE vocabulary, and it names the action.
 *
 * WHAT IT REPLACES, measured. 51 runners spelled this refusal privately under three vocabularies and, for the shared
 * topology, five spellings of the same fact:
 *
 *   native_local_fixture_not_enabled                                          the 19 `enabled` copies
 *   native_local_fixture_config_invalid                                       the 8 `config_invalid` copies
 *   native_local_<action>_fixture_config_invalid                              the 14 `action_prefixed` copies and the
 *                                                                             template's own 12 runners
 *   native_local_fixture_topology_not_isolated[:<json>]                       35 copies
 *   native_local_<action>_topology_invalid / _action_policy_invalid            11 copies
 *
 * The three vocabularies were kept as an option while the copies existed, because a migration that changed a word
 * changed a live report. They are one vocabulary now, and the decision is the tree's own: a refusal has to name the
 * ACTION, because one blocked run's log carries the words of every runner the launcher touched, and
 * `native_local_fixture_config_invalid` alone cannot say which of them refused. The template's runners already spoke
 * that way, so the copies moved onto it rather than the other way round, and the three cause words stay distinct where
 * the cause is actionable:
 *
 *   native_local_<action>_fixture_config_invalid                          the fixture section is not a usable fixture
 *   native_local_<action>_fixture_scenario_mismatch:<found|missing>       the armed world is not the one asserted
 *   native_local_<action>_action_policy_invalid                          a shared topology feature is on
 *
 * The policy itself refuses in the harness's own words (`native_fixture_policy_denies_required:<action>` and
 * `native_fixture_policy_illegal_opt_in:<action>`), because that validator is the fixture's single authority for what a
 * derived policy means and a second copy of its decision is the defect this module exists to prevent.
 *
 * THE ORDER is shape, scenario, topology, policy. The 51 copies used two orders - 16 asserted the policy before the
 * topology, 35 after - and the two answer differently only for a config broken in two ways at once (`policy_before_topology`
 * in the corpus). Both refuse such a config; the order decides only which word is reported, so this is a wording
 * unification rather than a change of acceptance. The shape is read first because everything else is about a fixture the
 * shape already rejected, and the scenario before the topology because a wrong world is the more specific finding.
 *
 * `action` has NO default. It is the refusal's subject, and a default would be a word every future runner inherits
 * without deciding.
 *
 * `fixtureScenario: null` means "this runner arms no scenario of its own" - 39 of the copies never read one, and checking
 * a scenario they never armed would refuse configurations that work today. `requiredActions: null` means the copy made no
 * policy assertion: the 8 `enabled` copies and the two navigation runners made none.
 *
 * `slotRelationship` reads the logical-save/slot relationship 6 copies read; `validFixtureSlotRelationship` is that rule's
 * one spelling.
 *
 * THE BOOTSTRAP IS ALWAYS CHECKED, and that is the one place this primitive is STRICTER than eight of the copies it
 * replaced. `Bootstrap.Enable === true` is the title-screen bootstrap phase's own config - the phase in which no bridge
 * is opened - so an observed run that accepts it asserts postconditions against a world that has not been loaded. The
 * fixture's observed-phase config never carries the key at all (`configureNativeLocalPlayer` replaces the whole
 * `NativeLocalPlayerFixture` section), and `stardew-native-local-player-fixture.mjs` already refuses the same config with
 * the same test, so the check refuses nothing a real run produces.
 */
export function validateNativeLocalFixtureConfig(
  value,
  { action, fixtureScenario = null, slotRelationship = false, requiredActions = null, experimentalActions = null } = {},
) {
  if (typeof action !== "string" || action.length === 0)
    throw new Error(`native_local_fixture_config_action_missing:${String(action)}`);
  const fixture = value?.NativeLocalPlayerFixture;
  const shapeOk =
    fixture?.Enable === true &&
    fixture.Bootstrap?.Enable !== true &&
    (slotRelationship !== true || validFixtureSlotRelationship(fixture.LogicalSaveName, fixture.ObservedSaveSlot));
  if (!shapeOk) throw new Error(`native_local_${action}_fixture_config_invalid`);
  if (fixtureScenario !== null && fixture.FixtureScenario !== fixtureScenario)
    throw new Error(`native_local_${action}_fixture_scenario_mismatch:${fixture.FixtureScenario ?? "missing"}`);
  const topologyShared =
    value?.Portfolio?.Enable === true ||
    value?.HostAutomation?.Enable === true ||
    value?.HostFarmhandProvisioning?.Enable === true ||
    value?.FarmhandProvisioner?.Enable === true;
  if (topologyShared) throw new Error(`native_local_${action}_action_policy_invalid`);
  if (requiredActions !== null || experimentalActions !== null)
    validateNativeLocalFixturePolicy(value, {
      requiredActions: requiredActions ?? [],
      ...(experimentalActions === null ? {} : { experimentalActions }),
    });
}

/* ---------------------------------------------------------------------------------------------------------------
 * TILES
 * ------------------------------------------------------------------------------------------------------------- */

/**
 * The same tile, with the integer guard the majority spelling carries.
 *
 * `craft-partial-recovery-chain`'s 9 copies and `plant-seed`'s guarded spelling are this exactly. `break-resource-clump`'s
 * 3 copies omit the guard; on integer tiles the two agree, and where they do not - an absent or fractional coordinate -
 * this answers `false`, which is the reading a postcondition can act on. No snapshot publishes a fractional tile.
 */
export function sameTile(left, right) {
  return (
    Number.isInteger(left?.x) &&
    Number.isInteger(left?.y) &&
    Number.isInteger(right?.x) &&
    Number.isInteger(right?.y) &&
    left.x === right.x &&
    left.y === right.y
  );
}

/**
 * Within one step on both axes (Chebyshev distance <= 1), so a tile is adjacent to itself.
 *
 * 19 copies spell this with the integer guards (`enter-exit`'s 16, `craft-partial-recovery-chain`'s 3 written as
 * `Math.max(...) <= 1`); 12 more (`break-resource-clump`'s 11, `interact-npc-with-item`'s 1) omit them. The guarded
 * spelling is the primitive: on integer tiles the two agree, and on a missing coordinate the unguarded one computes
 * `NaN <= 1`, which is already `false`.
 */
export function tilesAdjacent(left, right) {
  return (
    Number.isInteger(left?.x) &&
    Number.isInteger(left?.y) &&
    Number.isInteger(right?.x) &&
    Number.isInteger(right?.y) &&
    Math.abs(left.x - right.x) <= 1 &&
    Math.abs(left.y - right.y) <= 1
  );
}

/**
 * Exactly one step on the wider axis (Chebyshev distance === 1), so a tile is NOT neighbouring itself.
 *
 * `water-pet-bowl`'s 2 copies. Kept separate from `tilesAdjacent` rather than a knob, because "adjacent" answering `true`
 * for the actor's own tile is the bug this predicate exists to avoid, and a `mode: "strict"` argument is the kind of
 * option a caller gets wrong silently.
 */
export function tilesNeighbouring(left, right) {
  return (
    Number.isInteger(left?.x) &&
    Number.isInteger(left?.y) &&
    Number.isInteger(right?.x) &&
    Number.isInteger(right?.y) &&
    Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y)) === 1
  );
}

/**
 * Exactly one step on ONE axis (Manhattan distance === 1) - the 5 `cardinalAdjacent` copies.
 *
 * Separate from `tilesAdjacent` because a cardinal predicate excludes the diagonal: a runner that walks to a cardinal
 * neighbour must not accept `{x+1,y+1}`, and the copies said so by spelling the sum instead of the maximum.
 */
export function tilesCardinallyAdjacent(left, right) {
  return (
    Number.isInteger(left?.x) &&
    Number.isInteger(left?.y) &&
    Number.isInteger(right?.x) &&
    Number.isInteger(right?.y) &&
    Math.abs(left.x - right.x) + Math.abs(left.y - right.y) === 1
  );
}

/** The distance itself (Chebyshev), for the 3 `chebyshev` copies that rank candidates rather than test one. */
export function tileChebyshevDistance(left, right) {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

/* ---------------------------------------------------------------------------------------------------------------
 * THE CONNECTION AND PIPE LIFECYCLE
 * ------------------------------------------------------------------------------------------------------------- */

/**
 * Connect-with-retry: the game creates its named pipe asynchronously after launch, so a first connect legitimately
 * fails with ENOENT.
 *
 * Byte-identical in the 4 copies that spelled it (`open-geode`, `break-resource-clump`, and two more). A non-ENOENT
 * failure is rethrown at once: a pipe that refuses with another code is not a pipe that is still arriving.
 */
export async function connectWithRetry(
  config,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  {
    connect = connectNativeLocalClient,
    loadModule = loadHostTestModule,
    wait = delay,
    now = Date.now,
    retryDelayMs = 250,
  } = {},
) {
  const deadline = now() + timeoutMs;
  let lastError;
  while (now() < deadline) {
    try {
      return await connect(config, { loadModule });
    } catch (error) {
      lastError = error;
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
      await wait(retryDelayMs);
    }
  }
  throw lastError ?? new Error("native_local_bridge_connect_timeout");
}

/**
 * The navigation wait a `prepare` step needs: the terminal, then a fresh actionable observation at or past its revision.
 *
 * Identical in the 3 copies that spelled it (`break-resource-clump`, `clear-debris`, `sweep-scythe`). The harness's own
 * timeout codes are mapped back to the runner's navigation vocabulary, so a caller's bounded fixture-approach fallback
 * keeps its decision surface instead of learning a second set of error names.
 */
export async function waitForNavigationTerminal(client, receipts, accepted, predicate, timeoutMs) {
  const navigated = async (work) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof NativeSmokeHarnessError) throw new Error(`navigation_timeout:${accepted.executionId}`);
      throw error;
    }
  };
  const terminal = await navigated(() => waitForTerminal(receipts, accepted, timeoutMs));
  if (terminal.state !== "succeeded") throw new Error(`navigation_failed:${terminal.reasonCode}`);
  const snapshot = await navigated(() =>
    waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs,
      requireActionable: true,
      check: predicate,
    }),
  );
  return { receipt: terminal, snapshot };
}
