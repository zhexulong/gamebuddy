import { SNAPSHOT_KEYS } from "./protocol.js";
import type { Snapshot } from "./protocol.js";

/**
 * Answers to questions the companion can already ask of the state it holds.
 *
 * <p>
 * The Host could dispatch actions but not answer a question, and that asymmetry was visible in play: a companion stood in
 * Town at 13:20 with 268/270 stamina while its own farm was dry, because nothing in its world model said "there are 34 dry
 * crop tiles". The facts were already being sent — `wateringWhereabouts` counts every loaded location, `chests` already
 * carries each chest's `items` — so "which chest has the iron ore" was answerable the whole time. This module is the asking.
 * </p>
 * <p>
 * Three rules, and every one of them exists because its absence was measured:
 * </p>
 * <list type="bullet">
 * <item>Every answer names the family it came from, so "we did not look" and "there is nothing" cannot be the same answer.
 * A subject the snapshot does not carry answers `source.family: null` — null is the only spelling of "not looked", and it
 * is never replaced by an empty list, which would be a claim about the world.</item>
 * <item>A fact the snapshot does not carry also NAMES the missing field — never a guess, never a silent omission.
 * `weatherTomorrow` and festival flags are exactly this today: the Mod does not publish them.</item>
 * <item>Every answer is bounded, and truncation is reported as `omitted`, present even when it is 0 so that "nothing was
 * dropped" is a measurement rather than an absent key. An unbounded lookup is `stardew_observe` again.</item>
 * </list>
 * <p>
 * One subject is DERIVED rather than read: `affordances` answers "what can be done here, now" by grouping the target families
 * the live surface declares into kinds, so its `source.family` names the derivation rather than a single wire field, and each
 * group carries the family it counted. Its population comes from the Mod's own `targetFamily` declarations (the same ones
 * the discovery audit's `TARGET_FIELD` verifies), never from a table here.
 * </p>
 */

/** Rows per answer before `omitted` starts counting. Small on purpose: this is a question, not a dump. */
export const MAX_LOOKUP_ROWS = 20;

/**
 * Kinds per affordance answer before `omitted` starts counting.
 *
 * Ten rows cost about 1.5 KB - a fifth of one observation - and a farm puts roughly that many kinds of target inside the
 * 13x13 view at once. The cap is not about saving bytes: an answer listing every family the Mod can ever publish is
 * `stardew_observe` with different field names.
 */
export const MAX_AFFORDANCE_GROUPS = 10;

export const LOOKUP_SUBJECTS = Object.freeze([
  "affordances",
  "crops",
  "chests",
  "inventory",
  "npcs",
  "calendar",
] as const);

type LookupSubject = (typeof LOOKUP_SUBJECTS)[number];

/**
 * Where an answer came from.
 *
 * `family` is null exactly when nothing was read: an absent snapshot family, or a refused subject. `snapshotRevision`
 * names the revision the answer describes, because this module reads the snapshot the session already holds and a
 * revision the model cannot see is a stale coordinate it will act on.
 */
type LookupSource = Readonly<{ family: string | null; snapshotRevision: number | null }>;

export type LookupAnswer = Readonly<{
  // A named family answers under its own name, so this is the subject asked for, not only the five shaped ones.
  subject: string;
  source: LookupSource;
  answer: Readonly<Record<string, unknown>>;
}>;

export type LookupRefusal = Readonly<{
  source: LookupSource;
  refused: string;
  subjects: readonly LookupSubject[];
}>;

export type LookupUnknown = Readonly<{
  source: LookupSource;
  unknown: string;
  missingField: string;
}>;

function sourceOf(snapshot: Snapshot | null, family: string | null): LookupSource {
  return Object.freeze({ family, snapshotRevision: snapshot === null ? null : snapshot.revision });
}

/** The family this subject is computed from, or null when the answer is "not looked". */
const NOT_LOOKED: LookupSource = Object.freeze({ family: null, snapshotRevision: null });

function matches(needle: string, ...haystack: readonly (string | undefined)[]): boolean {
  const wanted = needle.trim().toLowerCase();
  if (wanted.length === 0) return true;
  return haystack.some((value) => typeof value === "string" && value.toLowerCase().includes(wanted));
}

/** Bounded rows plus the count that did not fit. `omitted` is always a number: 0 is a measurement, not a missing key. */
function bound<T>(rows: readonly T[], limit = MAX_LOOKUP_ROWS): Readonly<{ rows: readonly T[]; omitted: number }> {
  if (rows.length <= limit) return { rows, omitted: 0 };
  return { rows: rows.slice(0, limit), omitted: rows.length - limit };
}

/**
 * Crops: how many tiles are dry, how many are ripe, and where — across every loaded location.
 *
 * `cropTargets` is Chebyshev-bounded to the player's neighbourhood, so it answers "what can I reach", never "what needs
 * doing". The two whole-world summaries (`wateringWhereabouts`, `harvestWhereabouts`) are the ones this reads.
 */
function crops(snapshot: Snapshot): LookupAnswer | LookupUnknown {
  const watering = snapshot.wateringWhereabouts;
  const harvest = snapshot.harvestWhereabouts;
  if (watering === undefined && harvest === undefined)
    return {
      source: sourceOf(snapshot, null),
      unknown: "this snapshot carries no whole-map crop summary",
      missingField: "wateringWhereabouts",
    };
  return {
    subject: "crops",
    source: sourceOf(snapshot, "wateringWhereabouts"),
    answer: {
      needsWater: (watering ?? []).map((row) => ({
        location: row.location,
        count: row.needsWaterCount,
        nearest: { x: row.nearestX, y: row.nearestY },
      })),
      readyForHarvest: (harvest ?? []).map((row) => ({
        location: row.location,
        count: row.readyForHarvestCount,
        nearest: { x: row.nearestX, y: row.nearestY },
      })),
      // The bounded family is reported as what it is, not as a total: two numbers that mean different things must not
      // arrive in one field.
      withinReach: snapshot.cropTargets?.length ?? 0,
      here: snapshot.location,
    },
  };
}

/** Chests: which ones hold an item matching `query`, and the container summary beside them. */
function chests(snapshot: Snapshot, query: string): LookupAnswer | LookupUnknown {
  const rows = snapshot.chests;
  const summary = snapshot.chestsSummary;
  if (rows === undefined && summary === undefined)
    return {
      source: sourceOf(snapshot, null),
      unknown: "this snapshot carries no chest family",
      missingField: "chests",
    };
  const all = rows ?? [];
  const hits = all
    .map((chest) => ({
      chestId: chest.chestId,
      at: { x: chest.x, y: chest.y },
      displayName: chest.displayName,
      isFridge: chest.isFridge,
      items: chest.items.filter((item) => matches(query, item.displayName, item.qualifiedItemId)),
    }))
    .filter((chest) => chest.items.length > 0);
  const bounded = bound(hits);
  return {
    subject: "chests",
    source: sourceOf(snapshot, "chests"),
    answer: {
      searched: all.length,
      ...(all.length === 0 ? { note: "no chest is in reach; a chest across the farm is not in this family" } : {}),
      matches: bounded.rows,
      omitted: bounded.omitted,
      summary: summary ?? null,
    },
  };
}

function inventory(snapshot: Snapshot, query: string): LookupAnswer | LookupUnknown {
  const rows = snapshot.inventoryItemFacts;
  if (rows === undefined)
    return {
      source: sourceOf(snapshot, null),
      unknown: "this snapshot publishes no inventory facts",
      missingField: "inventoryItemFacts",
    };
  const bounded = bound(rows.filter((item) => matches(query, item.displayName, item.qualifiedItemId)));
  return {
    subject: "inventory",
    source: sourceOf(snapshot, "inventoryItemFacts"),
    answer: {
      rows: bounded.rows,
      omitted: bounded.omitted,
      // Said out loud, because a narrow family reported as "your inventory" is worse than no answer.
      note: "inventoryItemFacts is published for a subset of items today; a missing item is not proof it is not held",
    },
  };
}

function npcs(snapshot: Snapshot, query: string): LookupAnswer | LookupUnknown {
  const rows = snapshot.villagerWhereabouts;
  if (rows === undefined)
    return {
      source: sourceOf(snapshot, null),
      unknown: "this snapshot carries no villager whereabouts",
      missingField: "villagerWhereabouts",
    };
  const bounded = bound(
    rows
      .filter((row) => matches(query, row.npcName, row.displayName))
      .map((row) => ({ name: row.displayName, location: row.location, at: { x: row.x, y: row.y } })),
  );
  return {
    subject: "npcs",
    source: sourceOf(snapshot, "villagerWhereabouts"),
    answer: { rows: bounded.rows, omitted: bounded.omitted },
  };
}

/**
 * Calendar: what the snapshot knows, and an explicit `unknown` for what it does not.
 *
 * Tomorrow's weather and today's festival are the obvious asks and the snapshot carries neither. Answering them from the
 * clock would be inventing a world, so they come back as `unknown` with the field named.
 */
function calendar(snapshot: Snapshot): LookupAnswer {
  return {
    subject: "calendar",
    source: sourceOf(snapshot, "dayOfMonth"),
    answer: {
      season: snapshot.seasonIndex,
      day: snapshot.dayOfMonth,
      year: snapshot.year,
      timeOfDay: snapshot.timeOfDay,
      weatherNow: snapshot.weather,
      weatherTomorrow: { unknown: "not published by the Mod", missingField: "weatherTomorrow" },
      festivalToday: { unknown: "not published by the Mod", missingField: "festivalToday" },
    },
  };
}

/** The answer to "no snapshot has been admitted yet": not a world with nothing in it, a world nobody has looked at. */
export function noSnapshot(reasonCode: string): LookupUnknown {
  return { source: NOT_LOOKED, unknown: `no authoritative snapshot: ${reasonCode}`, missingField: "snapshot" };
}

/** The largest single value a family answer will carry verbatim when it is not a row list. */
const MAX_LOOKUP_SCALAR_BYTES = 400;

/**
 * One action the surface publishes, with the snapshot family its targets come from.
 *
 * `targetFamily` is the Mod's OWN declaration on the action's descriptor (`FarmhandActionDescriptor.TargetFamily`, published
 * as `targetFamily` and admitted by `protocol.ts`). It is the same declaration the discovery audit's `TARGET_FIELD` table
 * verifies against the wire, so the grouping below is derived from the producer rather than from a second copy of it.
 */
export type AffordanceAction = Readonly<{ actionId: string; targetFamily: string }>;

/**
 * The noun a family's rows are reported under: `weedTargets` -> `weed`, `lanternSlots` -> `lantern`, `chests` -> `chests`.
 *
 * Derived from the family name so a family the Mod adds later arrives with a name and no edit here. The suffix list is a
 * SHAPE of the wire's naming (`*Targets`, `*Slots`, `*Sites`, `*Facts`), not a list of kinds.
 */
const FAMILY_NAME_SUFFIXES = ["Targets", "Slots", "Sites", "Facts"] as const;

function kindOf(family: string): string {
  const suffix = FAMILY_NAME_SUFFIXES.find(
    (candidate) => family.length > candidate.length && family.endsWith(candidate),
  );
  if (suffix === undefined) return family;
  const stem = family.slice(0, -suffix.length);
  return stem[0]!.toLowerCase() + stem.slice(1);
}

/**
 * A row's address, in the order every published row declares one.
 *
 * `targetId` is the wire's name for the opaque address, `chestId` is the container family's, and both are declared before
 * any other `*Id` property, so this reads the row's own first identifier rather than guessing from the value's shape.
 */
function targetIdOf(row: Readonly<Record<string, unknown>>): string | null {
  for (const key of ["targetId", "chestId"]) {
    const value = row[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  for (const [key, value] of Object.entries(row))
    if (key.endsWith("Id") && typeof value === "string" && value.length > 0) return value;
  return null;
}

function tileOf(row: Readonly<Record<string, unknown>>): Readonly<{ x: number; y: number }> | null {
  const { x, y } = row;
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y) ? { x, y } : null;
}

/**
 * The one row of a family a caller should act on first: nearest by Chebyshev distance, because the walk to a diagonal
 * neighbour is one step and its Euclidean length is not.
 *
 * A family whose rows publish no tile (a recipe, a tool slot) has no distance; those rows sort after the locatable ones
 * rather than pretending a distance of 0, and the answer says `tiles: null` instead of omitting the field.
 */
type AffordanceNearest = Readonly<{
  targetId: string | null;
  x: number | null;
  y: number | null;
  tiles: number | null;
}>;

type AffordanceGroup = Readonly<{
  kind: string;
  family: string;
  count: number;
  /** The action the caller would use first when a family has several consumers. */
  action: string;
  /** Every action that consumes this family, in surface order: `machineTargets` has three. */
  actions: readonly string[];
  nearest: AffordanceNearest;
}>;

function nearestOf(
  rows: readonly Readonly<Record<string, unknown>>[],
  actor: Readonly<{ x: number; y: number }>,
): AffordanceNearest {
  let best: AffordanceNearest | null = null;
  for (const row of rows) {
    const at = tileOf(row);
    const targetId = targetIdOf(row);
    const candidate: AffordanceNearest =
      at === null
        ? { targetId, x: null, y: null, tiles: null }
        : { targetId, x: at.x, y: at.y, tiles: Math.max(Math.abs(at.x - actor.x), Math.abs(at.y - actor.y)) };
    if (best === null || closer(candidate, best)) best = candidate;
  }
  if (best === null) throw new Error("nearestOf requires at least one row");
  return best;
}

/** Whether `candidate` is the row to act on before `incumbent`: locatable first, then nearer, then the smaller id. */
function closer(candidate: AffordanceNearest, incumbent: AffordanceNearest): boolean {
  const candTiles = candidate.tiles === null ? Number.POSITIVE_INFINITY : candidate.tiles;
  const incumbentTiles = incumbent.tiles === null ? Number.POSITIVE_INFINITY : incumbent.tiles;
  if (candTiles !== incumbentTiles) return candTiles < incumbentTiles;
  return (candidate.targetId ?? "") < (incumbent.targetId ?? "");
}

/**
 * What can be done HERE, NOW: one group per family that already has a target in the snapshot, with the action that consumes
 * it.
 *
 * <p>
 * This subject exists because actionability was never stated anywhere: a live run attempted 15 of 104 published actions,
 * and the only route to the other 89 was to read the descriptors one at a time and compare each exchange rate of
 * `*Targets` against the snapshot by hand. `stardew_plan_shape` was called 17 times in that session and the snapshot was
 * re-read beside it; nothing joined the two.
 * </p>
 * <p>
 * The population is derived twice over and neither half is a list in this file: the KINDS are the `targetFamily` values the
 * live surface publishes, and the ACTION beside each is the one whose descriptor declares it (a family with several
 * consumers, like `machineTargets`, names all of them). A family with no target in the snapshot is absent rather than
 * reported with 0 - the answer is about this moment, and `stardew_observe` is the answer about what the world holds.
 * </p>
 * <p>
 * A caller must still read the row before it acts: `count` is the number of targets of that family IN VIEW, not the
 * subset the action's own preconditions admit (`harvest_crop` refuses an unready crop, `machine_collect_output` refuses a
 * machine with nothing to collect). Preconditions stay with the receipt that proves them.
 * </p>
 */
function affordances(snapshot: Snapshot, surface: readonly AffordanceAction[]): LookupAnswer {
  /** family -> the actions whose descriptor names it, in the order the surface publishes them. */
  const consumers = new Map<string, string[]>();
  for (const entry of surface) {
    const actions = consumers.get(entry.targetFamily);
    if (actions === undefined) consumers.set(entry.targetFamily, [entry.actionId]);
    else if (!actions.includes(entry.actionId)) actions.push(entry.actionId);
  }
  const fields = snapshot as unknown as Record<string, unknown>;
  const groups: AffordanceGroup[] = [];
  for (const [family, actions] of consumers) {
    const value = fields[family];
    // Not carried this frame, or nothing of that kind in view: both absent. "We did not look" and "there is nothing"
    // are the same statement about THIS moment, and neither is a group with a count of zero.
    if (!Array.isArray(value) || value.length === 0) continue;
    const rows = value.filter(
      (row): row is Readonly<Record<string, unknown>> => typeof row === "object" && row !== null && !Array.isArray(row),
    );
    if (rows.length === 0) continue;
    groups.push({
      kind: kindOf(family),
      family,
      count: value.length,
      action: actions[0]!,
      actions: [...actions],
      nearest: nearestOf(rows, snapshot.tile),
    });
  }
  // Count first, then name: the deterministic ordering that makes two runs on one farm answer the same bytes.
  groups.sort((left, right) =>
    right.count !== left.count ? right.count - left.count : left.kind.localeCompare(right.kind),
  );
  const bounded = bound(groups, MAX_AFFORDANCE_GROUPS);
  return {
    subject: "affordances",
    source: sourceOf(snapshot, "affordances"),
    answer: {
      location: snapshot.location,
      // A fact, not a filter: the kinds are what exists here, and this says whether the body can act on any of them.
      actionable: snapshot.actionable,
      groups: bounded.rows,
      omitted: bounded.omitted,
      ...(groups.length === 0
        ? {
            nothing_actionable_here:
              surface.length === 0
                ? "no published action declares a target family on this surface"
                : "no target of any published action is in this snapshot",
          }
        : {}),
    },
  };
}

/**
 * A named snapshot family, answered as rows when it is a row list.
 *
 * `matched` and `omitted` are both measurements: `omitted: 0` says the answer is complete, and a family the snapshot
 * does not carry this frame is `unknown` with its own name, never an empty list - "I did not look" and "there is
 * nothing" must stay distinguishable.
 */
function familyRows(snapshot: Snapshot, family: string, query: string): LookupAnswer | LookupRefusal | LookupUnknown {
  const value = (snapshot as unknown as Record<string, unknown>)[family];
  if (value === undefined)
    return {
      source: sourceOf(snapshot, family),
      unknown: `this snapshot does not carry \`${family}\` this frame`,
      missingField: family,
    };
  if (!Array.isArray(value)) {
    const text = JSON.stringify(value);
    if (text !== undefined && text.length <= MAX_LOOKUP_SCALAR_BYTES)
      return { subject: family, source: sourceOf(snapshot, family), answer: { [family]: value } };
    return {
      source: sourceOf(snapshot, family),
      refused: `subject_not_a_row_family:${family}`,
      subjects: LOOKUP_SUBJECTS,
    };
  }
  const rows = value.filter((row) =>
    query.trim().length === 0
      ? true
      : matches(
          query,
          ...Object.values(row as Record<string, unknown>)
            .filter((field) => typeof field === "string" || typeof field === "number")
            .map((field) => String(field)),
        ),
  );
  const bounded = bound(rows);
  return {
    subject: family,
    source: sourceOf(snapshot, family),
    answer: { [family]: bounded.rows, matched: rows.length, omitted: bounded.omitted },
  };
}

export function lookUp(
  snapshot: Snapshot,
  subject: string,
  query = "",
  surface: readonly AffordanceAction[] = [],
): LookupAnswer | LookupRefusal | LookupUnknown {
  switch (subject) {
    case "affordances":
      return affordances(snapshot, surface);
    case "crops":
      return crops(snapshot);
    case "chests":
      return chests(snapshot, query);
    case "inventory":
      return inventory(snapshot, query);
    case "npcs":
      return npcs(snapshot, query);
    case "calendar":
      return calendar(snapshot);
    default: {
      // Any family the snapshot declares is answerable by name. The subjects above are shaped answers (five read a
      // family, `affordances` derives one from the whole surface); this is the door to the other ~100 rooms, and its
      // population comes from `SNAPSHOT_KEYS` so a family added later is queryable with no edit here. Without it the
      // tool has five doors and the building has a hundred rooms: the consumer audit measured 70 of 88 action-target
      // pairs with no way to ask (2026-11-06).
      if ((SNAPSHOT_KEYS as readonly string[]).includes(subject)) return familyRows(snapshot, subject, query);
      // The valid list is derived from the table, so adding a subject cannot leave this message stale.
      return { source: sourceOf(snapshot, null), refused: `unknown_subject:${subject}`, subjects: LOOKUP_SUBJECTS };
    }
  }
}
