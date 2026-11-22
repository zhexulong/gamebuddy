import type { BodyProgramStatusResult, DataQueryResult, Snapshot } from "./protocol.js";
import { SNAPSHOT_KEYS } from "./protocol.js";

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
  // Derived from the Mod's journal rather than from the snapshot the other subjects read; see `myWork`.
  "my_work",
  // The game's OWN content tables, read through the engine's loaders rather than from the snapshot; see `dataTable`.
  "data",
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

function tilePair(x: unknown, y: unknown): Readonly<{ x: number; y: number }> | null {
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y) ? { x, y } : null;
}

/**
 * A row's tile, in the two spellings the wire publishes it in.
 *
 * `x`/`y` is almost every family's. `ownerTileX`/`ownerTileY` is a shop counter's, and it is the COUNTER's own tile - the
 * Mod publishes `counter.CounterX/CounterY` there, the same pair its `targetId@x,y` counter token spells - which is the
 * tile a caller must stand beside. Read here and nowhere else, because its absence was measurable: after `round90` the
 * shop group answered `tiles: null` for nine counters that all publish a tile, so the answer named a walk to nowhere and
 * the one id it did carry was the only thing a caller could pass.
 */
function tileOf(row: Readonly<Record<string, unknown>>): Readonly<{ x: number; y: number }> | null {
  return tilePair(row.x, row.y) ?? tilePair(row.ownerTileX, row.ownerTileY);
}

/**
 * One row's address, which is what a caller dispatches with: the id the action takes, and the walk to it.
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

function addressOf(
  row: Readonly<Record<string, unknown>>,
  actor: Readonly<{ x: number; y: number }>,
): AffordanceNearest {
  const targetId = targetIdOf(row);
  const at = tileOf(row);
  return at === null
    ? { targetId, x: null, y: null, tiles: null }
    : { targetId, x: at.x, y: at.y, tiles: Math.max(Math.abs(at.x - actor.x), Math.abs(at.y - actor.y)) };
}

/** A counted row with its address: the two things a group orders once and reports per kind. */
type AddressedRow = Readonly<{ row: Readonly<Record<string, unknown>>; at: AffordanceNearest }>;

/**
 * The family whose rows are shop COUNTERS, and the one family this module shapes past its `nearest`.
 *
 * <p>
 * `shop_purchase` resolves a counter's opaque `targetId` (`shop_<16 hex>`), and a row's `shopId` is not that value: a shop
 * has one counter per owner who can run it, and only some of them may be open today. Measured `round90`: `shopTargets`
 * published nine counters, two `shop_purchase` calls passed `SeedShop` - the shop id every counter's row carries beside it -
 * and both were refused `shop_target_is_a_shop_id_not_a_counter`. The refusal was right and the answer before it named the
 * shop: a count, an opaque id, and no tile at all (see `tileOf`).
 * </p>
 * <p>
 * Naming the counters is also the only way `stockPrices` reaches a caller: a price belongs to a counter, so an answer that
 * elides the counters hides the prices the wire just gained.
 * </p>
 */
const SHOP_COUNTER_FAMILY = "shopTargets";

/**
 * Counters one group names before `countersOmitted` starts counting.
 *
 * Ordered nearest first, so the bound keeps the counters a caller can act on soonest rather than an arbitrary prefix, and
 * the nearest counter - the one `nearest` already reports - is always in the answer.
 */
export const MAX_AFFORDANCE_COUNTERS = 3;

/**
 * Stock rows one counter names before it stops. The counter's own `stockCount` stays the total, so a bounded list is never
 * read as the whole menu.
 */
export const MAX_COUNTER_SELLS = 4;

/** One thing a counter sells, and the number the menu charges for one unit of it (`null` when it published no price). */
type AffordanceCounterSell = Readonly<{ qualifiedItemId: string; price: number | null }>;

/**
 * One shop counter in the shape `shop_purchase` takes it: the id to pass, the tile to walk to, whether the body can trade
 * without walking, and what it sells.
 *
 * `shopId` and `ownerName` are carried so a caller can recognise WHICH shop a counter belongs to - they are names, never
 * the value the action resolves - and every other member is read from the row the Mod published for that counter.
 */
type AffordanceCounter = Readonly<{
  targetId: string | null;
  shopId: string | null;
  ownerName: string | null;
  x: number | null;
  y: number | null;
  tiles: number | null;
  ownerInReach: boolean | null;
  /** How many rows the menu holds. Read, not counted: `sells` is bounded and this is the total. */
  stockCount: number | null;
  sells: readonly AffordanceCounterSell[];
}>;

/** A row's non-empty string member, or null: an empty string is not a name. */
function textOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * What one counter sells, joined to what the menu charges by item id - never by list position.
 *
 * The two lists are published side by side for exactly this join, and a price paired to an id by position is an identity
 * keyed on position. A named id with no published price answers `price: null`: NOT MEASURED, which is neither `0` nor
 * "free".
 */
function sellsOf(row: Readonly<Record<string, unknown>>): readonly AffordanceCounterSell[] {
  const ids = Array.isArray(row.stockItemIds)
    ? row.stockItemIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const prices = new Map<string, number>();
  if (Array.isArray(row.stockPrices)) {
    for (const entry of row.stockPrices) {
      if (typeof entry !== "object" || entry === null) continue;
      const { qualifiedItemId, price } = entry as Record<string, unknown>;
      if (typeof qualifiedItemId === "string" && typeof price === "number" && !prices.has(qualifiedItemId))
        prices.set(qualifiedItemId, price);
    }
  }
  return ids
    .slice(0, MAX_COUNTER_SELLS)
    .map((qualifiedItemId) => ({ qualifiedItemId, price: prices.get(qualifiedItemId) ?? null }));
}

function counterOf(row: Readonly<Record<string, unknown>>, at: AffordanceNearest): AffordanceCounter {
  return {
    targetId: at.targetId,
    shopId: textOf(row.shopId),
    ownerName: textOf(row.ownerName),
    x: at.x,
    y: at.y,
    tiles: at.tiles,
    ownerInReach: typeof row.ownerInReach === "boolean" ? row.ownerInReach : null,
    stockCount:
      typeof row.stockCount === "number" && Number.isSafeInteger(row.stockCount) && row.stockCount >= 0
        ? row.stockCount
        : null,
    sells: sellsOf(row),
  };
}

type AffordanceGroup = Readonly<{
  kind: string;
  family: string;
  count: number;
  /** The action the caller would use first when a family has several consumers. */
  action: string;
  /** Every action that consumes this family, in surface order: `machineTargets` has three. */
  actions: readonly string[];
  nearest: AffordanceNearest;
  /** `SHOP_COUNTER_FAMILY` only: the counters this group counts, nearest first. Absent for every other family. */
  counters?: readonly AffordanceCounter[];
  /** `SHOP_COUNTER_FAMILY` only: the counters `MAX_AFFORDANCE_COUNTERS` left out. */
  countersOmitted?: number;
}>;

/** Whether `candidate` is the row to act on before `incumbent`: locatable first, then nearer, then the smaller id. */
function closer(candidate: AffordanceNearest, incumbent: AffordanceNearest): boolean {
  const candTiles = candidate.tiles === null ? Number.POSITIVE_INFINITY : candidate.tiles;
  const incumbentTiles = incumbent.tiles === null ? Number.POSITIVE_INFINITY : incumbent.tiles;
  if (candTiles !== incumbentTiles) return candTiles < incumbentTiles;
  return (candidate.targetId ?? "") < (incumbent.targetId ?? "");
}

/** `closer` as the comparator every group's rows are sorted by, so the nearest row is `[0]` and one order is used twice. */
function compareAddress(left: AddressedRow, right: AddressedRow): number {
  if (closer(left.at, right.at)) return -1;
  return closer(right.at, left.at) ? 1 : 0;
}

/**
 * Which empty this is, in words - because the three are three different facts.
 *
 * `declaredFamilies` is how many target families the live surface publishes, `measuredFamilies` how many of them this
 * snapshot actually carries. A caller that reads "no target of any published action is in this snapshot" over a frame that
 * measured two of seventy concludes there is no shop in the world, when the truth is that nobody looked.
 */
function emptyAnswerReason(declaredFamilies: number, measuredFamilies: number): string {
  if (declaredFamilies === 0) return "no published action declares a target family on this surface";
  if (measuredFamilies === 0)
    return `this snapshot carries none of the ${String(declaredFamilies)} target ${declaredFamilies === 1 ? "family" : "families"} the surface declares: nothing here was measured, so stardew_observe before acting`;
  return "no target of any published action is in this snapshot";
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
 * consumers, like `machineTargets`, names all of them). A family the snapshot carries with no row in view is absent rather
 * than reported with 0 - the answer is about this moment, and `stardew_observe` is the answer about what the world holds.
 * </p>
 * <p>
 * A family the surface declares and the snapshot does NOT carry is a different fact and is not passed over in silence:
 * `notMeasured` names it. Measured `round90`: the shop question was asked in a snapshot that published no `shopTargets`,
 * the answer said nothing about shops at all, and the sentence that stood in for it - "no target of any published action" -
 * is a claim about the WORLD where the truth was that nothing had been measured.
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
  const notMeasured: string[] = [];
  for (const [family, actions] of consumers) {
    const value = fields[family];
    // Declared by the surface and absent from this frame: NOT MEASURED. It is never a group with a count of zero, and it
    // is not silence either - a caller told only "nothing actionable here" goes looking in the wrong place.
    if (!Array.isArray(value)) {
      notMeasured.push(family);
      continue;
    }
    // Carried this frame with nothing of that kind in view: measured emptiness. Absent, because a group of zero is a row
    // about a kind that has no row.
    if (value.length === 0) continue;
    const rows = value.filter(
      (row): row is Readonly<Record<string, unknown>> => typeof row === "object" && row !== null && !Array.isArray(row),
    );
    if (rows.length === 0) continue;
    // One ordering for every family: the nearest row first, then by id, so `nearest` and a bounded `counters` list are the
    // same measurement rather than two sortings that could disagree about which counter is closest.
    const addressed = rows
      .map((row): AddressedRow => ({ row, at: addressOf(row, snapshot.tile) }))
      .sort(compareAddress);
    groups.push({
      kind: kindOf(family),
      family,
      count: value.length,
      action: actions[0]!,
      actions: [...actions],
      nearest: addressed[0]!.at,
      ...(family === SHOP_COUNTER_FAMILY
        ? {
            counters: addressed.slice(0, MAX_AFFORDANCE_COUNTERS).map(({ row, at }) => counterOf(row, at)),
            countersOmitted: Math.max(0, addressed.length - MAX_AFFORDANCE_COUNTERS),
          }
        : {}),
    });
  }
  // Count first, then name: the deterministic ordering that makes two runs on one farm answer the same bytes.
  groups.sort((left, right) =>
    right.count !== left.count ? right.count - left.count : left.kind.localeCompare(right.kind),
  );
  const bounded = bound(groups, MAX_AFFORDANCE_GROUPS);
  const boundedNotMeasured = bound([...notMeasured].sort((left, right) => left.localeCompare(right)));
  return {
    subject: "affordances",
    source: sourceOf(snapshot, "affordances"),
    answer: {
      location: snapshot.location,
      // A fact, not a filter: the kinds are what exists here, and this says whether the body can act on any of them.
      actionable: snapshot.actionable,
      groups: bounded.rows,
      omitted: bounded.omitted,
      // The declared families this snapshot does not carry, so "not looked" and "there is nothing" stay different
      // answers. Bounded like the groups, and `notMeasuredOmitted` counts what the bound dropped.
      notMeasured: boundedNotMeasured.rows,
      notMeasuredOmitted: boundedNotMeasured.omitted,
      ...(groups.length === 0
        ? {
            nothing_actionable_here: emptyAnswerReason(consumers.size, consumers.size - notMeasured.length),
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

/**
 * `my_work`: what this companion has actually done, answered from the Mod's Body Program journal with no id.
 *
 * <p>
 * This subject exists because of what a context fold leaves behind. A 48-minute run was forked afterwards and asked what
 * it had done; it answered "15 plan submissions, 0 tiles tilled" against 143 submissions and ~20 tilled tiles. Nothing in
 * that answer was a hallucination - it was the size of what remained. The only place a `programId` was ever handed to the
 * model is the `stardew_plan_work` answer, an unprotected tool result, and a fold drops those; the durable record sat in
 * the Mod's journal the whole time but could be read only by a program id. So this answer depends on NOTHING that lives
 * in the transcript: it is built from one query of the Mod's journal (an absent `programId` asks for the newest programs),
 * which is why it reads the same before a fold and after any number of them.
 * </p>
 * <p>
 * The three properties that make it usable are the ones a fold puts under pressure: it names no id it was not given (the
 * journal supplies the ids), it carries no field that changes between two reads without a new program (no clock, no "now",
 * no reason code), and every list is bounded with its omissions counted. `population` prints "programs read N of M" so a
 * journal bounded by the transport reads as truncated rather than as short.
 * </p>
 */

/** Programs named before `omitted` starts counting. Matches the transport page, so the answer never claims more than it read. */
export const MAX_MY_WORK_PROGRAMS = 8;

/**
 * "You asked for a day boundary and the journal has none".
 *
 * One spelling, because it is the same fact wherever it is reached from: a caller that scopes this by day must be told that
 * the scope does not exist rather than handed the whole journal under a heading it did not earn.
 */
const NO_DAY_BOUNDARY: LookupUnknown = Object.freeze({
  source: NOT_LOOKED,
  unknown: "the Body Program journal records no day boundary, so this cannot be scoped to one",
  missingField: "BodyProgramJournal.program.day",
});

/** No journal to read: a named absence, never an empty history. */
export function journalUnavailable(reason: string, missingField = "BodyProgramJournal"): LookupUnknown {
  return { source: NOT_LOOKED, unknown: reason, missingField };
}

/**
 * Node states, grouped into the buckets the answer prints, in the order it prints them.
 *
 * The population is the wire's own closed vocabulary - every state `BodyProgramNodeStatus.state` can hold has an arm - so a
 * state added to the Mod cannot arrive uncounted. `unsettled` is the four states that mean "not finished": pending, awaiting
 * admission, admitted and running. The two skip words share one bucket because this answer counts WORK, and neither ran:
 * which of the two causes is the plan's own node row (`planBatchAnswer`), never a total that would have to pick one.
 */
const MY_WORK_NODE_BUCKETS: readonly (readonly [string, readonly string[]])[] = Object.freeze([
  ["succeeded", ["succeeded"]],
  ["partiallySucceeded", ["partially_succeeded"]],
  ["failed", ["failed"]],
  ["cancelled", ["cancelled"]],
  ["rejected", ["rejected"]],
  ["skipped", ["skipped_dependency", "skipped_program_abandoned"]],
  ["abandoned", ["abandoned"]],
  ["recoveryRequired", ["recovery_required"]],
  ["unsettled", ["pending", "awaiting_host_admission", "host_admitted", "running"]],
]);

/**
 * The states in which the Mod had already dispatched the node into the game.
 *
 * This is the number a summary should use for "actions I ran": `host_admitted` means the Host approved it but nothing has
 * happened yet, and a rejected node was never dispatched at all - counting either as an execution is how a run reports work
 * it did not do.
 */
const MY_WORK_DISPATCHED: ReadonlySet<string> = new Set([
  "running",
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
  "recovery_required",
  "abandoned",
]);

const MY_WORK_PROGRAM_STATES = Object.freeze({
  settled: new Set(["succeeded", "failed", "cancelled"]),
  running: new Set(["active"]),
  recoveryRequired: new Set(["recovery_required", "quarantined"]),
});

/**
 * The journal as this answer reads it: the programs the Mod listed, and the journal's own total beside them.
 *
 * `programCount` is not `programs.length`: the page is bounded by the transport, and the difference between the two is
 * exactly what "read N of M" is for.
 */
export type MyWorkJournal = Readonly<{
  programs: readonly Readonly<{
    programId: string;
    state: string;
    nodes: readonly Readonly<{ actionId: string; state: string; x: number | null; y: number | null }>[];
  }>[];
  programCount: number;
}>;

export type MyWorkRequest = Readonly<{ since?: string | undefined; programLimit?: number | undefined }>;

/**
 * The answer, from one journal page. Pure: two calls on one payload answer the same bytes, which is the property the
 * fold-survival test asserts.
 */
export function myWork(journal: MyWorkJournal, request: MyWorkRequest = {}): LookupAnswer | LookupUnknown {
  // A DAY BOUNDARY IS NOT IN THIS JOURNAL, and this is where saying so is cheaper than guessing.
  //
  // Programs and events carry the Mod's monotonic `atMs` and nothing else about time: no day, no season, no year. Scoping
  // by `day_3` would mean attributing programs to a day nobody recorded, and an answer that quietly reported the whole
  // journal under a "since" heading would be wrong in the one direction a summary must never be wrong.
  if (typeof request.since === "string" && request.since.trim().length > 0) return NO_DAY_BOUNDARY;
  const nodes = journal.programs.flatMap((program) => program.nodes);
  const counted = (states: ReadonlySet<string>): number => nodes.filter((node) => states.has(node.state)).length;
  const programsIn = (states: ReadonlySet<string>): number =>
    journal.programs.filter((program) => states.has(program.state)).length;

  const nodeTotals: Record<string, number> = {};
  for (const [bucket, states] of MY_WORK_NODE_BUCKETS) nodeTotals[bucket] = counted(new Set(states));

  const byAction = new Map<string, { actionId: string; succeeded: number; failed: number; rejected: number }>();
  for (const node of nodes) {
    const row = byAction.get(node.actionId) ?? { actionId: node.actionId, succeeded: 0, failed: 0, rejected: 0 };
    if (node.state === "succeeded") row.succeeded += 1;
    else if (node.state === "failed") row.failed += 1;
    else if (node.state === "rejected") row.rejected += 1;
    byAction.set(node.actionId, row);
  }
  // Count first, then name: two runs over one journal answer the same bytes, and the order is stated rather than implied.
  const actionRows = [...byAction.values()].sort((left, right) => {
    const leftTotal = left.succeeded + left.failed + left.rejected;
    const rightTotal = right.succeeded + right.failed + right.rejected;
    return rightTotal !== leftTotal ? rightTotal - leftTotal : left.actionId.localeCompare(right.actionId);
  });
  const boundedActions = bound(actionRows);

  // Tiles come from the SUCCEEDED nodes that carry one, and only from those: `x`/`y` is the tile the Mod bound at
  // admission, so a node that failed on its way there addressed no tile. A succeeded node without a coordinate pair is
  // counted as `unproven` rather than dropped - the two numbers together are the population.
  const tiles = new Set<string>();
  let unproven = 0;
  for (const node of nodes) {
    if (node.state !== "succeeded") continue;
    if (node.x === null || node.y === null) unproven += 1;
    else tiles.add(`${String(node.x)},${String(node.y)}`);
  }
  const tileRows = [...tiles]
    .map((key) => key.split(",").map(Number))
    .map(([x, y]) => ({ x: x as number, y: y as number }))
    .sort((left, right) => (left.y !== right.y ? left.y - right.y : left.x - right.x));
  const boundedTiles = bound(tileRows);

  const limit = Math.max(1, request.programLimit ?? MAX_MY_WORK_PROGRAMS);
  const programRows = journal.programs.slice(0, limit).map((program) => ({
    programId: program.programId,
    state: program.state,
  }));

  return {
    subject: "my_work",
    // The family is the journal, and the revision is null because none of this came from a snapshot: reporting the last
    // observed revision here would invite a reader to compare two things that were never in the same frame.
    source: Object.freeze({ family: "BodyProgramJournal", snapshotRevision: null }),
    answer: {
      totals: {
        programs: {
          submitted: journal.programCount,
          read: journal.programs.length,
          settled: programsIn(MY_WORK_PROGRAM_STATES.settled),
          running: programsIn(MY_WORK_PROGRAM_STATES.running),
          recoveryRequired: programsIn(MY_WORK_PROGRAM_STATES.recoveryRequired),
        },
        nodes: nodeTotals,
        executions: nodes.filter((node) => MY_WORK_DISPATCHED.has(node.state)).length,
      },
      byAction: { rows: boundedActions.rows, omitted: boundedActions.omitted },
      tiles: { rows: boundedTiles.rows, unproven, omitted: boundedTiles.omitted },
      programs: { rows: programRows, omitted: journal.programs.length - programRows.length },
      population: `programs read ${String(journal.programs.length)} of ${String(journal.programCount)}`,
    },
  };
}

/**
 * `my_work` from the Mod's answer, or a named refusal when the journal published no page.
 *
 * The two refusals stay distinct because they need different corrections: `programs: null` means the caller asked about one
 * program (`found` with a snapshot, or `not_found`), and there is simply nothing to summarise.
 */
export function myWorkFromJournal(
  result: BodyProgramStatusResult,
  request: MyWorkRequest = {},
): LookupAnswer | LookupUnknown {
  if (result.programs === null)
    return journalUnavailable(
      `the journal answered no recent-program page:${result.code}`,
      "BodyProgramJournal.programs",
    );
  return myWork(
    {
      programs: result.programs.map((program) => ({
        programId: program.programId,
        state: program.state,
        nodes: program.nodes.map((node) => ({
          actionId: node.actionId,
          state: node.state,
          x: typeof node.x === "number" ? node.x : null,
          y: typeof node.y === "number" ? node.y : null,
        })),
      })),
      programCount: result.programCount,
    },
    request,
  );
}

/**
 * `data`: the game's own content tables, answered by the Mod through the engine's loaders.
 *
 * <p>
 * This subject exists because the questions a player actually asks are about the TABLES, not about the world: what a
 * chicken costs, how many days until it lays, what a keg accepts and what comes out. Every one of those facts lives in
 * `Data/FarmAnimals`, `Data/Shops`, `Data/Machines` and their siblings, the engine already parses them into its own
 * caches, and nothing could ask. The observation baseline filed those caches as "never read" - this is the asking.
 * </p>
 * <p>
 * Three outcomes are named rather than inferred, because they need different corrections: `data_table_unknown:<table>`
 * (the engine has no such table - check the spelling), `data_row_absent:<table>:<key>` (the table exists and has no such
 * row), `data_row_found:<table>:<key>`. A table with ZERO rows is `data_table_index` with `population: 0`, never
 * unknown: "this table is empty" and "there is no such table" are different worlds.
 * </p>
 * <p>
 * An index is bounded by BYTES, not by rows, because a row id can be four characters (`72`) or forty (`(BC)67`): a fixed
 * row cap would make one table cost 200 bytes and the next 3 KB. `omitted` is always present, so "nothing was dropped"
 * is a measurement, and `population` sits beside `matched` so a short list can never be read as the whole table.
 * </p>
 */

/** Bytes one content-table index may spend on row ids. An observation is ~8 KB; this must stay cheaper than one. */
export const MAX_DATA_INDEX_BYTES = 1600;

/** The family every content-table answer names: the engine's loaders, not the snapshot this session holds. */
const DATA_SOURCE: LookupSource = Object.freeze({ family: "DataLoader", snapshotRevision: null });

/** No reader to ask: the same named absence `my_work` answers when the session has no journal. */
export function dataQueryUnavailable(reason: string): LookupUnknown {
  return { source: NOT_LOOKED, unknown: reason, missingField: "dataQuery" };
}

/** The longest prefix of `ids` that fits `budget` bytes once quoted and comma-separated, plus what did not fit. */
function boundIds(
  ids: readonly string[],
  budget = MAX_DATA_INDEX_BYTES,
): Readonly<{ rows: readonly string[]; omitted: number }> {
  const rows: string[] = [];
  let bytes = 0;
  for (const id of ids) {
    // Quotes and the separator are part of what the model is handed, so they are part of the budget.
    const cost = id.length + 4;
    if (bytes + cost > budget) break;
    rows.push(id);
    bytes += cost;
  }
  return { rows, omitted: ids.length - rows.length };
}

/**
 * The one content-table answer, shaped from the Mod's own result.
 *
 * Pure: the same result answers the same bytes, which is what lets the fixture-driven test assert the projection
 * without a bridge.
 */
export function dataTable(result: DataQueryResult, key: string | null): LookupAnswer {
  if (result.status === "unknown_table")
    return {
      subject: "data",
      source: NOT_LOOKED,
      answer: { code: `data_table_unknown:${result.table}`, table: result.table, detail: result.detail },
    };
  if (result.status === "not_projectable")
    return {
      subject: "data",
      source: NOT_LOOKED,
      answer: {
        code: `data_table_not_projectable:${result.table}:${result.detail}`,
        table: result.table,
        detail: result.detail,
      },
    };
  if (result.status === "absent_row")
    return {
      subject: "data",
      source: DATA_SOURCE,
      answer: {
        code: `data_row_absent:${result.table}:${key ?? ""}`,
        table: result.table,
        population: result.population,
        matched: 0,
        rows: [],
        omitted: 0,
        detail: result.detail,
      },
    };
  if (result.status === "row")
    return {
      subject: "data",
      source: DATA_SOURCE,
      answer: {
        code: `data_row_found:${result.table}:${result.row.id}`,
        table: result.table,
        population: result.population,
        matched: 1,
        row: result.row,
      },
    };
  const ids = result.status === "index" ? result.ids : [];
  const bounded = boundIds(ids);
  return {
    subject: "data",
    source: DATA_SOURCE,
    answer: {
      code: `data_table_index:${result.table}`,
      table: result.table,
      population: result.population,
      matched: ids.length,
      rows: bounded.rows,
      omitted: bounded.omitted,
      ...(result.population === 0 ? { note: "the table exists and has zero rows" } : {}),
    },
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
    // `my_work` reads the Mod's journal through the bridge, never this snapshot. Reaching here means the session has no
    // journal reader at all, which is a different answer from "you have done nothing".
    case "my_work":
      return journalUnavailable("this session has no Body Program journal reader");
    // `data` reads the game's own content tables through the bridge for the same reason: the tables are engine state,
    // not snapshot state, and a snapshot cannot carry them without becoming an observation.
    case "data":
      return dataQueryUnavailable("this session has no content-data reader");
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
