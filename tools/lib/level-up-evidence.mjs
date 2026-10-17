/**
 * Reading the pending level-up out of the Mod's own refusal.
 *
 * `dismiss_modal` genuinely cannot close an active `LevelUpMenu` (its close hook grants the perk,
 * `LevelUpMenu.cs:629-635`), and its refusal publishes what is pending from `Farmer.newLevels`:
 * `pending_level_ups=<count>` plus one `level_up=<skill>@<level>` per entry. That is what lets the rollover
 * watcher name the pair `respond_level_up` needs while the companion is blocked inside its own `advance_day`.
 *
 * The parse is its own pure function because getting it wrong is silent: measured 2026-10-17 on run g10, the
 * watcher built the pair from `String(fact.evidence)` - an OBJECT, so it stringified to `[object Object]` - and
 * the run reported `level_up_pair_not_published` while the Mod had published `level_up=4@6` all along.
 */

/** Every pending `(skill, level)` the evidence names, in the order the Mod wrote them. */
export function parsePendingLevelUps(evidence) {
  const detail = evidenceDetail(evidence);
  const pairs = [];
  for (const match of detail.matchAll(/level_up=(\d{1,2})@(\d{1,2})/gu)) {
    pairs.push({ skill: Number.parseInt(match[1], 10), level: Number.parseInt(match[2], 10) });
  }
  return pairs;
}

/**
 * The `detail` string of an evidence value, whichever of the three shapes it arrives in: the fact log carries
 * `{ detail }`, some projections carry a bare string, and the world-fact payload nests it. An unknown shape
 * yields the empty string rather than a stringified object, so a parse failure is visible as "not published"
 * instead of as a pair that looks real.
 */
export function evidenceDetail(evidence) {
  if (typeof evidence === "string") return evidence;
  if (evidence === null || evidence === undefined) return "";
  if (typeof evidence.detail === "string") return evidence.detail;
  if (typeof evidence.worldFactPayload?.evidence?.detail === "string") return evidence.worldFactPayload.evidence.detail;
  if (typeof evidence.worldFactPayload?.detail === "string") return evidence.worldFactPayload.detail;
  return "";
}

/**
 * The pair to resolve, or a named reason there is none.
 *
 * A MILESTONE is deliberately NOT a resolution the watcher may take: the two branches at levels 5 and 10 are a
 * permanent part of the companion's growth path, so naming them here is how the run stops honestly instead of
 * the harness deciding for it.
 */
export function chooseLevelUpResolution(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return Object.freeze({ levelUp: null, choice: null, reasonCode: "level_up_pair_not_published" });
  }
  const levelUp = pairs[0];
  if (levelUp.level === 5 || levelUp.level === 10) {
    return Object.freeze({
      levelUp,
      choice: null,
      reasonCode: `level_up_requires_companion_choice:${String(levelUp.skill)}@${String(levelUp.level)}`,
    });
  }
  return Object.freeze({ levelUp, choice: "confirm", reasonCode: null });
}
