import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * AN OBSERVATION-BUDGET ELISION MUST NEVER MAKE A PUBLISHED ACTION UNCALLABLE.
 *
 * <p>
 * `round17` ran 28 minutes and `talk_to_npc` was dispatched zero times. Every observation disclosed
 * `elidedVillagerRows: 24-39`, and that elision reduces each villager row on ANOTHER map to
 * `{ npcName, displayName, location }` - the tile is gone. The question nobody had asked is the one this gate answers:
 * <b>does an elision ever remove the field an action's addressing argument is derived from?</b>
 * </p>
 *
 * <h2>Both sides are derived; neither is a list typed here</h2>
 * <ul>
 *   <li><b>Which row properties are addresses.</b> From `action-surface.v1.json`: an action is <i>addressed</i> when it
 *       takes an opaque identifier - a `string` argument ending in `Id` that carries no `enum`, because a closed
 *       vocabulary is a value the model may CHOOSE while an identifier is one it must be SHOWN. Today that is
 *       `expectedTargetId`, `expectedQualifiedItemId` and `chestId`, and each reads the row property of the same name
 *       minus the `expected` prefix: `targetId`, `qualifiedItemId`, `chestId`. A family whose rows carry one of those is
 *       an ADDRESSABLE family - some published action names its target there.</li>
 *   <li><b>What each elision removes.</b> From the shipped `boundObservedSnapshot`, executed: one battery input per
 *       counter, then the published rows are diffed against the input rows. Which families lose rows, which lose
 *       FIELDS, and exactly which rows vanish are measurements of the real function, not a restatement of its source.</li>
 * </ul>
 *
 * <h2>What is asserted</h2>
 * <ol>
 *   <li>Every counter the function reports has a reading below, and every reading names a counter that still exists. The
 *       population is `Object.keys(budget)` from a live call, so a NEW elision fails here by name instead of shipping
 *       uncovered. `bytesRemoved` is declared separately: it is a byte ledger, not an elision.</li>
 *   <li>No elision removes an ADDRESSING property from a row, and no elision rewrites a row of an addressable family.
 *       Removing `targetId`/`qualifiedItemId`/`chestId` from a row that an action names its target through is the
 *       uncallable-action defect in its purest form.</li>
 *   <li>Every DROPPED row is justified by the row itself, per the reading. Dropping whole rows is legal - the recipe
 *       counter does it on every observation - but only when the dropped row could not be dispatched at anyway: a recipe
 *       the inventory cannot make, a plantable tile farther than the nearer window of its own stack, a villager who is
 *       not in the actor's location. Without this clause the recipe counter would be indistinguishable from an elision
 *       that silently emptied the family `craft_item` names.</li>
 * </ol>
 *
 * <h2>What the roster elision is allowed to do, and why it had to change</h2>
 * <p>
 * `villagerWhereabouts` used to carry no addressing property at all: its rows were `npcName`, `displayName`, `location`,
 * `x`, `y`, `inCurrentLocation` - a roster of who is where, not a list of addresses - and `talk_to_npc` named its
 * villager only through `npcRelationshipTargets`. That family is bounded to the Mod's 6-tile discovery envelope, so a
 * villager forty tiles away on the actor's own map was in the roster with a tile and addressable nowhere: 18
 * observations, `npcRelationshipTargets` empty in every one, 39 roster rows, zero `talk_to_npc` receipts. The roster now
 * carries `targetId` (`BuildNpcRelationshipTargetId`, a function of the name and the map, never of a tile), which is the
 * same id the action resolves.
 * </p>
 * <p>
 * So this gate's second clause is now stated precisely rather than absolutely: an elision may never remove an ADDRESSING
 * property from a row, and may remove any other field from an addressable family's row ONLY when that same reading has
 * already justified the row as undispatchable. The villager reduction qualifies - it fires only when both signals say the
 * villager is on another map, where `talk_to_npc` refuses by its own precondition - and it keeps the address, dropping
 * only the tile and its `false` flag. A reading that has no justification may not touch an addressed row at all.
 * </p>
 */
function repoRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, "integrations", "stardew", "action-development"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repository root not found from ${start}`);
    directory = parent;
  }
}

const ROOT = repoRoot(dirname(fileURLToPath(import.meta.url)));

// The shipped function imports its sibling as `./body-program-script.js` - the specifier the TypeScript build rewrites
// to. Under `node --test --experimental-strip-types` (how `test:stardew-wire-agreement` runs) no such file exists on
// disk, and this hook is what lets the gate call the REAL function rather than a copy of its logic. In the compiled
// suite the `.js` files do exist, the first resolve succeeds, and the hook never fires.
register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(specifier, context, next) {
      try {
        return await next(specifier, context);
      } catch (error) {
        if (!specifier.endsWith(".js")) throw error;
        return await next(specifier.slice(0, -3) + ".ts", context);
      }
    }`),
);

const BUDGET_MODULE_URL = new URL(
  existsSync(new URL("./stardew-observation-budget.ts", import.meta.url))
    ? "./stardew-observation-budget.ts"
    : "./stardew-observation-budget.js",
  import.meta.url,
).href;
const budgetModule: any = await import(BUDGET_MODULE_URL);
const boundObservedSnapshot: (snapshot: any, revision?: number) => any = budgetModule.boundObservedSnapshot;

const CATALOG: any = JSON.parse(
  readFileSync(
    join(ROOT, "integrations/stardew/action-development/contracts/generated/action-surface.v1.json"),
    "utf8",
  ),
);
const SCHEMA: any = JSON.parse(readFileSync(join(ROOT, "protocol", "bridge-v1.schema.json"), "utf8"));

/**
 * The WIRE's own row shape per snapshot family, from the schema's `$defs`.
 *
 * `protocol.ts` is proven against this same schema by `schema-contract.test.ts`, so a row property has one authority on
 * both sides. Reading it here (rather than importing `protocol.ts`) keeps this gate runnable under plain `node --test`,
 * and keeps it honest: a family whose row gains an identifier appears without anyone editing this file.
 */
function familyRowProperties(): ReadonlyMap<string, ReadonlySet<string>> {
  const definitions = SCHEMA.$defs ?? {};
  const families = new Map<string, ReadonlySet<string>>();
  for (const [field, spec] of Object.entries<any>(definitions.snapshot?.properties ?? {})) {
    const reference = spec?.items?.$ref;
    if (typeof reference !== "string") continue;
    const definition = definitions[reference.slice(reference.lastIndexOf("/") + 1)];
    const properties = definition?.properties;
    if (properties === undefined || typeof properties !== "object") continue;
    families.set(field, new Set(Object.keys(properties)));
  }
  return families;
}

const FAMILY_ROW_PROPERTIES = familyRowProperties();

/** `expectedTargetId` -> `targetId`: the row property an `expected*` argument is checked against. */
function addressingRowProperty(argumentName: string): string {
  if (!argumentName.startsWith("expected")) return argumentName;
  const rest = argumentName.slice("expected".length);
  return rest[0]!.toLowerCase() + rest.slice(1);
}

/**
 * Every row property some published action must be SHOWN in order to be called, and the actions that read it.
 *
 * An argument qualifies when it is a `string` with no `enum`: a closed vocabulary is a value the model can choose from
 * the surface, while an opaque identifier can only be copied out of an observation. The complement is worth stating too
 * - `emote`, `direction`, `choice` and `tool` carry enums and are NOT addresses; `text`, `quantity` and `x`/`y` are
 * authored values, not identifiers of an entity.
 */
function addressingProperties(): ReadonlyMap<string, readonly string[]> {
  const properties = new Map<string, string[]>();
  for (const action of CATALOG.actions ?? []) {
    for (const [name, spec] of Object.entries<any>(action.argumentSchema ?? {})) {
      if (spec?.type !== "string" || spec?.enum !== undefined || !name.endsWith("Id")) continue;
      const property = addressingRowProperty(name);
      properties.set(property, [...(properties.get(property) ?? []), action.actionId]);
    }
  }
  return properties;
}

const ADDRESSING_PROPERTIES = addressingProperties();
const ADDRESSING_NAMES = new Set(ADDRESSING_PROPERTIES.keys());

/** family -> the addressing properties its rows carry. Non-empty means some published action names a target there. */
function addressableFamilies(): ReadonlyMap<string, readonly string[]> {
  const addressable = new Map<string, readonly string[]>();
  for (const [family, properties] of FAMILY_ROW_PROPERTIES) {
    const carried = [...ADDRESSING_NAMES].filter((name) => properties.has(name)).sort();
    if (carried.length > 0) addressable.set(family, carried);
  }
  return addressable;
}

const ADDRESSABLE_FAMILIES = addressableFamilies();

/**
 * One elision, as a claim about what the code may remove and why each removed row is removable.
 *
 * `families` and the justification are the ONLY authored parts of this gate, because "a recipe the inventory cannot make
 * has no decision attached" is a product decision, not a fact derivable from a row schema. Everything the decision is
 * applied to - which rows actually vanished, which fields actually disappeared - is measured, and the measurement is
 * compared against the claim, so a declaration that stops describing the code fails here.
 */
type ElisionReading = Readonly<{
  /** The families this counter may touch. Measured and compared, so a counter that starts touching another fails. */
  families: readonly string[];
  /** Why one row may be dropped. Checked against every dropped row; a reading without it may not drop any. */
  justifies?: (row: any, context: Readonly<{ keptForSlot: (slot: number) => readonly any[]; tile: any }>) => boolean;
  /** Why this elision cannot cost an action its address. Printed in the failure message. */
  reasoning: string;
}>;

const ELISION_READINGS: Readonly<Record<string, ElisionReading>> = {
  elidedVillagerRows: {
    families: ["villagerWhereabouts"],
    justifies: (row) => row.inCurrentLocation === false,
    reasoning:
      "the row is reduced exactly when both signals already said the villager is on another map, where `talk_to_npc` " +
      "refuses by its own precondition - so the tile it drops names nothing the actor could dispatch at from here, and " +
      "the `targetId` it keeps is the address the action resolves once the actor walks onto that map",
  },
  withheldUnavailableRecipes: {
    families: ["craftingRecipeTargets", "cookingRecipeTargets"],
    justifies: (row) => row.ingredientsAvailable === false,
    reasoning:
      "`craft_item`/`cook_recipe` name these families through `targetId`, so a withheld row must be one the inventory " +
      "cannot make now - otherwise the elision is removing a craftable address",
  },
  withheldDistantSeedTargets: {
    families: ["seedTargets"],
    justifies: (row, context) => isBeyondPublishedWindow(row, context),
    reasoning:
      "a plan names at most one window of a stack and the published window is the NEAREST of that stack, so a withheld " +
      "tile is farther than every tile a plan can already name",
  },
  withheldDistantSaplingTargets: {
    families: ["treeSaplingTargets"],
    justifies: (row, context) => isBeyondPublishedWindow(row, context),
    reasoning:
      "same window as the seed family: a withheld sapling tile is farther than every tile a plan can already name",
  },
};

/**
 * A withheld plantable row is legal only when a nearer row of the SAME stack is published: rows are per-slot choices, so
 * the window that matters is the one this row's own slot kept.
 */
function isBeyondPublishedWindow(
  row: any,
  context: Readonly<{ keptForSlot: (slot: number) => readonly any[]; tile: any }>,
): boolean {
  const kept = context.keptForSlot(row.slot);
  if (kept.length === 0) return false;
  const distance = (candidate: any) =>
    Math.max(Math.abs(candidate.x - context.tile.x), Math.abs(candidate.y - context.tile.y));
  return distance(row) >= Math.min(...kept.map(distance));
}

/** Counters that are not elisions: they account for bytes and rows, they remove no fact an action reads. */
const ACCOUNTING_COUNTERS: ReadonlySet<string> = new Set(["bytesRemoved"]);

const TILE = Object.freeze({ x: 64, y: 15 });

/** Plantable rows in ONE stack, the shape the Mod publishes: 64 alternatives for a single held slot. */
function catalogue(slot: number, count: number, item: string): readonly any[] {
  return Array.from({ length: count }, (_, index) => ({
    targetId: `target_${slot}_${String(index).padStart(3, "0")}`,
    slot,
    x: TILE.x + (index % 6) + 1,
    y: TILE.y + Math.floor(index / 6),
    qualifiedItemId: item,
    displayName: item,
  }));
}

/** A villager standing on another map: the row `round17` carried 24-39 of on every observation. */
const OFF_MAP_VILLAGER = Object.freeze({
  targetId: "npc_relationship_marlon",
  npcName: "Marlon",
  displayName: "马龙",
  location: "AdventureGuild",
  x: 5,
  y: 11,
  inCurrentLocation: false,
});

/** The row an action IS dispatched at: an in-location villager, kept whole so the rewrite test has a control. */
const HERE_VILLAGER = Object.freeze({
  targetId: "npc_relationship_abigail",
  npcName: "Abigail",
  displayName: "阿比盖尔",
  location: "Farm",
  x: 70,
  y: 20,
  inCurrentLocation: true,
});

/** The addressable row the village actions name, which the budget must not touch at all. */
const NPC_TARGET = Object.freeze({
  targetId: "npc_0123456789abcdef",
  x: 70,
  y: 20,
  npcName: "Abigail",
  friendshipPoints: 100,
  friendshipStatus: "friendly",
  talkedToToday: false,
  giftsToday: 0,
  giftsThisWeek: 0,
});

const BASE = Object.freeze({
  revision: 412,
  location: "Farm",
  tile: TILE,
  stamina: 270,
  health: 100,
  exhausted: false,
  actionable: true,
  catalogRevision: 9,
  npcRelationshipTargets: [NPC_TARGET],
});

/**
 * One input per elision counter: the smallest snapshot that makes THAT counter fire.
 *
 * The keys are authored, and deliberately so - a counter's name is the only thing that can say which input triggers it.
 * What removes the drift is the assertion below: `Object.keys(budget)` must equal these keys plus the accounting
 * counters, in BOTH directions. A counter added to the code without a trigger here fails loudly, naming itself, rather
 * than being silently uncovered.
 */
const TRIGGERS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  elidedVillagerRows: { villagerWhereabouts: [OFF_MAP_VILLAGER, HERE_VILLAGER] },
  withheldUnavailableRecipes: {
    craftingRecipeTargets: [
      { targetId: "Campfire", displayName: "篝火", ingredientsAvailable: false },
      { targetId: "Chest", displayName: "宝箱", ingredientsAvailable: true },
    ],
    cookingRecipeTargets: [{ targetId: "Fried_Egg", displayName: "煎蛋", ingredientsAvailable: false }],
  },
  withheldDistantSeedTargets: { seedTargets: catalogue(5, 40, "(O)474") },
  withheldDistantSaplingTargets: { treeSaplingTargets: catalogue(7, 40, "(O)309") },
};

type FamilyDiff = Readonly<{
  /** Rows present in the input and absent from the output. */
  dropped: readonly any[];
  /** One entry per surviving row that came back with FEWER keys, with the row it came from. */
  removedFieldsByRow: readonly Readonly<{ removed: readonly string[]; row: any }>[];
  /** The rows that survived, so a justification can compare a dropped row against its own stack. */
  kept: readonly any[];
}>;

/**
 * Published rows are matched to input rows by SUBSET: a reduction keeps every key it did not remove, so a row whose
 * every published key equals the input's is that row. A row with no match was dropped outright.
 */
function diffFamily(inputRows: readonly any[], publishedRows: readonly any[]): FamilyDiff {
  const remaining = [...publishedRows];
  const dropped: any[] = [];
  const removedFieldsByRow: { removed: readonly string[]; row: any }[] = [];
  for (const row of inputRows) {
    const index = remaining.findIndex((candidate) =>
      Object.entries(candidate).every(([key, value]) => row[key] === value),
    );
    if (index === -1) {
      dropped.push(row);
      continue;
    }
    const [published] = remaining.splice(index, 1);
    const removed = Object.keys(row).filter((key) => !(key in published));
    if (removed.length > 0) removedFieldsByRow.push({ removed, row });
  }
  return { dropped, removedFieldsByRow, kept: publishedRows };
}

type Measurement = Readonly<{
  /** Counters with a non-zero count on this input: the trigger must isolate exactly one. */
  fired: readonly string[];
  /** family -> measured diff, for the families this input carried. */
  families: ReadonlyMap<string, FamilyDiff>;
}>;

function measure(counter: string): Measurement {
  const rows = TRIGGERS[counter];
  if (rows === undefined) throw new Error(`no battery input for counter ${counter}`);
  const input = { ...BASE, ...rows };
  const { snapshot: published, budget } = boundObservedSnapshot(input);
  const families = new Map<string, FamilyDiff>();
  for (const [field, familyRows] of Object.entries<any>(rows)) {
    if (!Array.isArray(familyRows)) continue;
    const publishedRows = published[field];
    assert.ok(Array.isArray(publishedRows), `${field} was dropped from the published snapshot entirely`);
    families.set(field, diffFamily(familyRows, publishedRows));
  }
  const fired = Object.entries<number>(budget)
    .filter(([name, value]) => !ACCOUNTING_COUNTERS.has(name) && typeof value === "number" && value > 0)
    .map(([name]) => name);
  return { fired, families };
}

test("every counter the bound can report is accounted for, and every reading names a live counter", () => {
  // The population is the FUNCTION's own report, not this file's table: a new elision counter appears in `budget` and has
  // no reading, which is the loud failure the task asks for. `bytesRemoved` is declared separately because it removes
  // nothing - it is the byte ledger, and treating it as an elision would demand a family it does not have.
  const reported = Object.keys(boundObservedSnapshot({ ...BASE, ...TRIGGERS.elidedVillagerRows }).budget);
  const elisions = reported.filter((name) => !ACCOUNTING_COUNTERS.has(name));

  assert.deepEqual(
    elisions.filter((name) => ELISION_READINGS[name] === undefined),
    [],
    `the observation budget reports elision counters this gate does not read: a new elision can remove a fact an action ` +
      `needs and nobody would see it. Add a reading (families, justification, reasoning) or delete the counter.\n` +
      `reported: [${reported.join(", ")}]`,
  );
  assert.deepEqual(
    Object.keys(ELISION_READINGS).filter((name) => !elisions.includes(name)),
    [],
    `ELISION_READINGS names a counter the function no longer reports - the reading now describes nothing, which reads ` +
      `as a green gate over a deleted feature.\nreported: [${elisions.join(", ")}]`,
  );
  // Neither side may be vacuously empty.
  assert.ok(elisions.length >= 4, `the bound must still report its elisions (found ${elisions.length})`);
  assert.ok(
    (CATALOG.actions ?? []).length >= 50,
    `the catalog must have been read (found ${(CATALOG.actions ?? []).length})`,
  );
  assert.ok(
    ADDRESSING_NAMES.size >= 3,
    `the surface must declare addressing arguments (found ${ADDRESSING_NAMES.size})`,
  );
  assert.ok(
    ADDRESSABLE_FAMILIES.size >= 10,
    `the wire must publish addressable families (found ${ADDRESSABLE_FAMILIES.size})`,
  );
});

test("each trigger isolates one counter, and that counter removes rows or fields - so nothing below is vacuous", () => {
  const problems: string[] = [];
  for (const counter of Object.keys(ELISION_READINGS)) {
    const { fired, families } = measure(counter);
    if (fired.length !== 1 || fired[0] !== counter)
      problems.push(
        `${counter}: the battery input was expected to fire exactly that counter, but the bound reported ` +
          `[${fired.join(", ")}] - attributing the measured removal to it would be wrong`,
      );
    const touched = [...families].filter(([, diff]) => diff.dropped.length > 0 || diff.removedFieldsByRow.length > 0);
    if (touched.length === 0)
      problems.push(`${counter}: fired, but no row was dropped and no field was removed - the reading is untested`);
    const measuredFamilies = touched.map(([family]) => family).sort();
    assert.deepEqual(
      measuredFamilies,
      [...ELISION_READINGS[counter]!.families].sort(),
      `${counter} touched [${measuredFamilies.join(", ")}] but its reading declares ` +
        `[${[...ELISION_READINGS[counter]!.families].join(", ")}] - the declaration no longer describes the code`,
    );
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

/** `a, b, c` for a short set; `n actions (a, b, c, ...)` for a long one, so a failure stays readable and still exact. */
function summarize(names: readonly string[]): string {
  if (names.length <= 6) return names.map((name) => `\`${name}\``).join(", ");
  return `${names.length} published actions, including ${names
    .slice(0, 3)
    .map((name) => `\`${name}\``)
    .join(", ")}`;
}

/**
 * One row of a family, built from the schema's own `required` list.
 *
 * No value here needs to be realistic: `boundObservedSnapshot` validates nothing - it only filters, ranks and rewrites
 * rows - so the row's purpose is to be a shape the elisions can recognise, and to be compared byte-for-byte afterwards.
 * A family whose row needs a field this does not produce would fail loudly rather than silently, because the assertion
 * is equality against exactly what was handed in.
 */
function sampleRow(family: string): Readonly<Record<string, unknown>> {
  const reference = SCHEMA.$defs.snapshot.properties[family].items.$ref as string;
  const definition = SCHEMA.$defs[reference.slice(reference.lastIndexOf("/") + 1)];
  const row: Record<string, unknown> = {};
  for (const name of definition.required ?? []) {
    const spec = definition.properties[name] ?? {};
    const resolved = spec.$ref === undefined ? spec : SCHEMA.$defs[spec.$ref.slice(spec.$ref.lastIndexOf("/") + 1)];
    if (resolved.type === "integer" || resolved.type === "number") row[name] = 1;
    else if (resolved.type === "boolean") row[name] = true;
    else if (resolved.type === "array") row[name] = [];
    else if (typeof resolved.const === "string") row[name] = resolved.const;
    else row[name] = `${family}_${name}`;
  }
  return row;
}

test("no elision touches a family some published action names its target through", () => {
  // THE EXHAUSTIVE HALF, and the one that does not depend on this file's trigger table. Every addressable family is
  // exercised with a schema-built row: the bound may not drop it, reorder it, or remove a single key. A new elision that
  // registers no counter still fails here, because the population is the WIRE's families crossed with the CATALOG's
  // addressing arguments - not the counters the code happens to declare.
  const problems: string[] = [];
  for (const [family, carried] of ADDRESSABLE_FAMILIES) {
    const row = sampleRow(family);
    const { snapshot: published } = boundObservedSnapshot({ ...BASE, [family]: [row] });
    const survivors = published[family];
    if (!Array.isArray(survivors) || survivors.length !== 1) {
      problems.push(
        `\`${family}\` carries ${carried.map((name) => `\`${name}\``).join(", ")} - an action names its target there - ` +
          `but the bound did not publish its single row (got ${JSON.stringify(survivors)})`,
      );
      continue;
    }
    const missing = Object.keys(row).filter((name) => !(name in survivors[0]));
    const changed = Object.keys(row).filter((name) => name in survivors[0] && survivors[0][name] !== row[name]);
    if (missing.length > 0 || changed.length > 0)
      problems.push(
        `\`${family}\` rows are rewritten by the observation budget (` +
          `${[...missing.map((name) => `removed ${name}`), ...changed.map((name) => `changed ${name}`)].join(", ")}), ` +
          `and ${summarize(ADDRESSING_PROPERTIES.get(carried[0]!)!)} name their target through ` +
          `${carried.map((name) => `\`${name}\``).join(", ")}. A companion handed a reduced row cannot name the target.`,
      );
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("an elision never removes an addressing property, and may rewrite an addressed row only as undispatchable", () => {
  // THE CROSSING. Left side: the row properties some published action must be SHOWN (`targetId`, `qualifiedItemId`,
  // `chestId`, derived from the catalog). Right side: what the shipped bound actually took away, measured. Removing an
  // addressing property is never legal - a row that cannot supply the identifier its action needs is an uncallable
  // action. Removing any OTHER field from a family some action addresses is legal only when the same reading already
  // justifies that row as one nothing can be dispatched at, so the reduction costs no decision.
  const problems: string[] = [];
  for (const counter of Object.keys(ELISION_READINGS)) {
    const reading = ELISION_READINGS[counter]!;
    const measurement = measure(counter);
    const input = { ...BASE, ...TRIGGERS[counter] };
    for (const [family, diff] of measurement.families) {
      const removals = [...new Set(diff.removedFieldsByRow.flatMap((row) => row.removed))].sort();
      if (removals.length === 0) continue;
      const addressing = removals.filter((field) => ADDRESSING_NAMES.has(field));
      const carried = ADDRESSABLE_FAMILIES.get(family) ?? [];
      if (addressing.length > 0)
        problems.push(
          `${counter} removes ${addressing.map((field) => `\`${field}\``).join(", ")} from \`${family}\` rows, and ` +
            `${summarize(ADDRESSING_PROPERTIES.get(addressing[0]!)!)} name their target through that property. A row can ` +
            `no longer supply the identifier the action must be shown, so the action becomes uncallable. An elision may ` +
            `drop a fact nothing can be dispatched at; it may not drop an address.`,
        );
      else if (carried.length > 0) {
        const unjustified = diff.removedFieldsByRow.filter(
          (entry) =>
            reading.justifies === undefined ||
            !reading.justifies(entry.row, {
              tile: input.tile,
              keptForSlot: (slot: number) => diff.kept.filter((candidate) => candidate.slot === slot),
            }),
        );
        if (unjustified.length > 0)
          problems.push(
            `${counter} rewrites \`${family}\` rows (removing ${removals.map((field) => `\`${field}\``).join(", ")}), ` +
              `and that family carries ${carried.map((field) => `\`${field}\``).join(", ")}. A partial reduction of an ` +
              `addressed row is legal only for a row the reading has already justified as undispatchable, and ` +
              `${unjustified.length} of them are not: ${reading.justifies === undefined ? "the reading declares no justification" : "its justification did not hold"}.`,
          );
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("every dropped row is justified by the row itself, so a withheld address is never a lost one", () => {
  // The complement of the previous test. Dropping a ROW is legal only when the dropped row could not be dispatched at
  // anyway - a recipe the inventory cannot make, a tile beyond the nearer window of its own stack, a villager who is not
  // here. Without this clause `withheldUnavailableRecipes` would be indistinguishable from an elision that silently
  // emptied the only family `craft_item` can name.
  const problems: string[] = [];
  for (const [counter, reading] of Object.entries(ELISION_READINGS)) {
    const measurement = measure(counter);
    const input = { ...BASE, ...TRIGGERS[counter] };
    for (const [family, diff] of measurement.families) {
      const carried = ADDRESSABLE_FAMILIES.get(family) ?? [];
      for (const row of diff.dropped) {
        const justified =
          reading.justifies === undefined
            ? false
            : reading.justifies(row, {
                tile: input.tile,
                keptForSlot: (slot: number) => diff.kept.filter((candidate) => candidate.slot === slot),
              });
        if (justified) continue;
        const identifier = row.targetId ?? row.npcName ?? row.chestId ?? "(anonymous row)";
        problems.push(
          `${counter} dropped \`${identifier}\` from \`${family}\`, and nothing about that row says it could not be ` +
            `used: ${reading.justifies === undefined ? "the reading declares no justification" : "the reading's justification did not hold"}. ` +
            `${carried.length === 0 ? "That family carries no addressing property" : `That family carries ${carried.map((field) => `\`${field}\``).join(", ")}`}. ` +
            `Reading's stated reason: ${reading.reasoning}`,
        );
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("the roster is addressable, keeps its address when reduced, and the family the village actions name is untouched", () => {
  // THE DECISION THIS GATE PROTECTS, in one place. `talk_to_npc` is dispatched at a villager named by
  // `BuildNpcRelationshipTargetId`, and that family is bounded to the 6-tile discovery envelope - so a villager further
  // away on the actor's own map had a tile in this roster and an address nowhere. The roster therefore carries the SAME
  // id, and the elision that reduces an off-map row keeps it: what it drops is the tile and its `false` flag, the two
  // facts a row for a villager on another map cannot be dispatched at.
  const roster = FAMILY_ROW_PROPERTIES.get("villagerWhereabouts");
  assert.ok(roster !== undefined, "the wire must still publish `villagerWhereabouts`");
  assert.deepEqual(
    [...ADDRESSING_NAMES].filter((name) => roster.has(name)).sort(),
    ["targetId"],
    "`villagerWhereabouts` carries the villager's address, which is what makes a villager past the discovery envelope " +
      "callable at all. A wire that stopped publishing it would put the roster back to a list of tiles nothing accepts.",
  );
  assert.deepEqual(
    ADDRESSABLE_FAMILIES.get("villagerWhereabouts"),
    ["targetId"],
    "a published action names its target through `villagerWhereabouts.targetId`",
  );

  assert.ok(
    ADDRESSABLE_FAMILIES.get("npcRelationshipTargets")?.includes("targetId"),
    "`talk_to_npc` names its villager through `npcRelationshipTargets.targetId`; that family must stay addressable",
  );
  const { snapshot: published } = boundObservedSnapshot({
    ...BASE,
    villagerWhereabouts: [OFF_MAP_VILLAGER, HERE_VILLAGER],
  });
  assert.deepEqual(
    published.npcRelationshipTargets,
    [NPC_TARGET],
    "the family every village action is dispatched at must survive the bound unchanged",
  );
  const keptVillager = published.villagerWhereabouts.find((row: any) => row.npcName === "Abigail");
  assert.deepEqual(
    keptVillager,
    HERE_VILLAGER,
    "a villager in the actor's own location keeps the tile an action needs",
  );
  const reducedVillager = published.villagerWhereabouts.find((row: any) => row.npcName === "Marlon");
  assert.equal(
    reducedVillager?.targetId,
    OFF_MAP_VILLAGER.targetId,
    "the reduced row keeps the address `talk_to_npc` resolves, so travelling there still names her",
  );
  assert.equal(reducedVillager?.x, undefined, "and loses the tile, which addresses nothing from this map");
});
