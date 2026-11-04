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
 * <item>Every answer names the family it came from, so "we did not look" and "there is nothing" cannot be the same answer.</item>
 * <item>A fact the snapshot does not carry answers `unknown` and NAMES the missing field — never a guess, never a silent
 * omission. `weatherTomorrow` and festival flags are exactly this today: the Mod does not publish them.</item>
 * <item>Every answer is bounded, and truncation is reported as `omitted`. An unbounded lookup is `stardew_observe` again.</item>
 * </list>
 */

/** Rows per answer before `omitted` starts counting. Small on purpose: this is a question, not a dump. */
export const MAX_LOOKUP_ROWS = 20;

export const LOOKUP_SUBJECTS = Object.freeze(["crops", "chests", "inventory", "npcs", "calendar"] as const);

export type LookupSubject = (typeof LOOKUP_SUBJECTS)[number];

export type LookupAnswer = Readonly<{
  subject: LookupSubject;
  /** The snapshot family this answer was computed from. Present on every success, by rule. */
  source: Readonly<{ family: string }>;
  answer: Readonly<Record<string, unknown>>;
}>;

export type LookupRefusal = Readonly<{ refused: string; subjects: readonly LookupSubject[] }>;

export type LookupUnknown = Readonly<{ unknown: string; missingField: string }>;

function matches(needle: string, ...haystack: readonly (string | undefined)[]): boolean {
  const wanted = needle.trim().toLowerCase();
  if (wanted.length === 0) return true;
  return haystack.some((value) => typeof value === "string" && value.toLowerCase().includes(wanted));
}

function bound<T>(rows: readonly T[]): Readonly<{ rows: readonly T[]; omitted?: number }> {
  if (rows.length <= MAX_LOOKUP_ROWS) return { rows };
  return { rows: rows.slice(0, MAX_LOOKUP_ROWS), omitted: rows.length - MAX_LOOKUP_ROWS };
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
    return { unknown: "this snapshot carries no whole-map crop summary", missingField: "wateringWhereabouts" };
  return {
    subject: "crops",
    source: { family: "wateringWhereabouts" },
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
    return { unknown: "this snapshot carries no chest family", missingField: "chests" };
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
    source: { family: "chests" },
    answer: {
      searched: all.length,
      ...(all.length === 0 ? { note: "no chest is in reach; a chest across the farm is not in this family" } : {}),
      matches: bounded.rows,
      ...(bounded.omitted === undefined ? {} : { omitted: bounded.omitted }),
      summary: summary ?? null,
    },
  };
}

function inventory(snapshot: Snapshot, query: string): LookupAnswer | LookupUnknown {
  const rows = snapshot.inventoryItemFacts;
  if (rows === undefined)
    return { unknown: "this snapshot publishes no inventory facts", missingField: "inventoryItemFacts" };
  const hits = rows.filter((item) => matches(query, item.displayName, item.qualifiedItemId));
  const bounded = bound(hits);
  return {
    subject: "inventory",
    source: { family: "inventoryItemFacts" },
    answer: {
      ...bounded,
      // Said out loud, because a narrow family reported as "your inventory" is worse than no answer.
      note: "inventoryItemFacts is published for a subset of items today; a missing item is not proof it is not held",
    },
  };
}

function npcs(snapshot: Snapshot, query: string): LookupAnswer | LookupUnknown {
  const rows = snapshot.villagerWhereabouts;
  if (rows === undefined)
    return { unknown: "this snapshot carries no villager whereabouts", missingField: "villagerWhereabouts" };
  const hits = rows
    .filter((row) => matches(query, row.npcName, row.displayName))
    .map((row) => ({ name: row.displayName, location: row.location, at: { x: row.x, y: row.y } }));
  const bounded = bound(hits);
  return { subject: "npcs", source: { family: "villagerWhereabouts" }, answer: { ...bounded } };
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
    source: { family: "dayOfMonth" },
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

export function lookUp(snapshot: Snapshot, subject: string, query = ""): LookupAnswer | LookupRefusal | LookupUnknown {
  switch (subject) {
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
    default:
      // The valid list is derived from the table, so adding a subject cannot leave this message stale.
      return { refused: `unknown_subject:${subject}`, subjects: LOOKUP_SUBJECTS };
  }
}
