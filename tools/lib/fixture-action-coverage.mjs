/**
 * Does a fixture lane grant the actions its run actually needs?
 *
 * WHY THIS EXISTS: the multi-day night died on the `LevelUpMenu` because the lane's enabled-action set did not
 * contain `respond_level_up` - an action the harness itself dispatches, and the only thing that can close that menu
 * (`advance_day` waits for `DayStarted`, which waits for the menu, which waits for a bridge request). The set is
 * hand-maintained YAML-ish source, nothing joined it to the published surface, and the failure surfaced as the
 * CALLER's 45 s timer because the Mod's capability refusal had no correlation id (measured 2026-10-17, run g22:
 * four dispatches, zero receipts).
 *
 * Two rules, both falsifiable:
 *   1. a lane may only grant actions the published surface carries (granting what the product does not publish
 *      cannot be honoured);
 *   2. a lane whose run needs a specific action must grant it - the case above.
 */

/** The `if (action === "X") return [...]` statements of the fixture's action-set function. */
export function parseFixtureActionSets(source) {
  const sets = new Map();
  // Comments are stripped FIRST: a declared list is routinely documented inline, and a quoteword inside a comment
  // (`// a note about "quotes"`) otherwise parses as an action id - which the parser did on its first run.
  const withoutComments = String(source).replace(/\/\/[^\n]*/gu, "");
  const pattern = /if \(action === "([a-z0-9_]+)"\)\s*\n?\s*return \[([^\]]*)\];/gu;
  for (const match of withoutComments.matchAll(pattern)) {
    const ids = [...match[2].matchAll(/"([a-z0-9_]+)"/gu)].map((id) => id[1]);
    // Two lanes with the same name are impossible, but a DUPLICATE would silently keep the last one: name it.
    if (sets.has(match[1])) throw new Error(`fixture_action_set_declared_twice:${match[1]}`);
    sets.set(match[1], ids);
  }
  return sets;
}

/**
 * Every lane whose run the live runner can require, and the actions that run cannot work without.
 *
 * The trio for the multi-day lane is the night's own causal chain, not a preference: `advance_day` performs the
 * night, `dismiss_modal` closes the settlement menu the rollover raises, and `respond_level_up` closes the level-up
 * menu raised in the same window - and closing those is what lets the night finish.
 */
export const REQUIRED_LANE_ACTIONS = Object.freeze({
  play_session_multi_day: Object.freeze(["advance_day", "dismiss_modal", "respond_level_up"]),
});

/**
 * The coverage violations of a fixture's action sets, as data.
 *
 * Pure, so both rules can be falsified in a test without a game: pass a lane that grants an unpublished action, or
 * one that omits a required action, and the corresponding code must appear.
 */
export function fixtureActionCoverageViolations({ sets, publishedIds, required = REQUIRED_LANE_ACTIONS }) {
  const violations = [];
  const published = publishedIds instanceof Set ? publishedIds : new Set(publishedIds ?? []);
  if (published.size === 0) violations.push({ code: "published_surface_empty", where: "action-surface" });
  for (const [lane, ids] of sets ?? []) {
    for (const id of ids) {
      if (!published.has(id)) violations.push({ code: `fixture_grants_unpublished_action:${lane}:${id}`, where: lane });
    }
    const needed = required?.[lane];
    if (needed === undefined) continue;
    for (const id of needed) {
      if (!ids.includes(id))
        violations.push({ code: `fixture_lane_missing_required_action:${lane}:${id}`, where: lane });
    }
  }
  // A required lane that the fixture does not declare at all is the same defect one level up: the run names it and
  // nothing grants it.
  for (const lane of Object.keys(required ?? {})) {
    if (!(sets ?? new Map()).has(lane)) violations.push({ code: `fixture_lane_not_declared:${lane}`, where: lane });
  }
  return violations;
}
