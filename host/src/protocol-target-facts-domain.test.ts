import assert from "node:assert/strict";
import { test } from "node:test";

import {
  captured,
  hostFamilyRules,
  hostValidators,
  lowerFirst,
  modFamilies,
  modRecords,
  validatorFor,
} from "./wire-declaration.test-support.js";

/**
 * EVERY NUMERIC FIELD THE MOD PUBLISHES MUST BE A VALUE THE HOST ACCEPTS.
 *
 * <p>
 * `declaration-agreement.test.ts` compares field NAMES: a field on one side only is a wire break. That gate cannot see
 * the other half of the same defect - the field is on both sides, and the two sides disagree about what values it can
 * hold. Three shipped commits are that shape, and two of them are the same field:
 * </p>
 *
 * <pre>
 *   def2fb07  rockSourceTargets.health  Mod 1..25  | Host `=== 1`   -> every mine node invisible
 *   c66ad0eb  treeChopSourceTargets.health  Mod > 0 | Host `=== 1`  -> bridge closed on a real farm
 *   a2373de3  rockSourceTargets.health  Mod 1..25  | Host 1..100    -> the invented ceiling hid it
 * </pre>
 *
 * <p>
 * Each one was found by a live run dying, never by a gate - because the round-trip gate that could have found it covers
 * 7 of 78 families and the other 76 are "absent, with a reason". So this gate does not run the producer; it compares
 * the two DECLARATIONS, which exist for every family.
 * </p>
 *
 * <h2>What is compared</h2>
 * <ul>
 * <li><b>The producer's domain</b> - from the C# record's declared type. An `int` is the whole int range: the record
 * declares no clamp, and a reader is not entitled to assume one. Where the ENGINE really does bound a value, the
 * declared entry below says so and cites the line.</li>
 * <li><b>The consumer's interval</b> - from the Host predicate's own comparisons and the helpers it calls
 * (`isTileCoordinate`, `isToolSlot`, ...).</li>
 * </ul>
 *
 * <p>
 * A producer domain that is NOT a subset of the consumer's interval is a NARROWING: there is a value the Mod is
 * entitled to publish and the Host refuses. That is the defect, and it is reported with both ranges.
 * </p>
 *
 * <h2>Why a narrowing is not automatically a failure</h2>
 * <p>
 * Most of them are correct and deliberate - a tile coordinate really is `0..1000`, and the Mod's own discovery clamps
 * it there. But "deliberate" is a claim about the ENGINE, and a claim nobody wrote down is exactly what made
 * `health <= 100` look the same as `health <= 25`. So every narrowing is DECLARED below, grouped by the
 * `(declared type -> accepted interval)` signature that carries one reason.
 * </p>
 *
 * <h2>The ratchet, and why it counts rather than lists</h2>
 * <p>
 * 166 fields narrow today. Naming all 166 here would be a hand-maintained list that has to be edited on every unrelated
 * family change - the shape that stops being read. Instead each signature declares its REASON and its COUNT, and the
 * gate prints every member. A field that appears in a declared signature raises that signature's count and fails; a
 * field in a signature nothing declares fails by name; a declared signature whose count falls means the Host widened
 * something and the entry must be removed. The same three-way reading `TargetFamilyRoundTripTests` uses, for the same
 * reason: a repair without removing its entry is red rather than quietly absorbed.
 * </p>
 *
 * red-proof: history  reverting the rock bound from `<= 25` to the invented `<= 100` that `a2373de3` shipped -> the
 *                   declaration test names `RockSourceTargets.health: the Mod publishes a C# int
 *                   ([-2147483648, 2147483647]) and the Host accepts only [1, 100]`, and the count test reports the
 *                   `int [1, 100]` signature with no declaration
 *                   (host/src/protocol-target-facts-domain.test.ts)
 * red-proof: history  the same bound as `=== 1`, the state `def2fb07` shipped -> the same two tests name
 *                   `RockSourceTargets.health` against `[1, 1]` and the census drops it out of its declared signature
 *                   (host/src/protocol-target-facts-domain.test.ts)
 */

/** One end of an interval, with the inclusivity the predicate actually used. */
interface Bound {
  readonly value: number;
  readonly inclusive: boolean;
}

interface Interval {
  readonly low: Bound;
  readonly high: Bound;
}

const UNBOUNDED: Interval = {
  low: { value: Number.NEGATIVE_INFINITY, inclusive: false },
  high: { value: Number.POSITIVE_INFINITY, inclusive: false },
};

/**
 * The domain a C# declared type implies, before any clamp the record does not state.
 *
 * `float`/`double` are read as the whole real line rather than their IEEE range: the question is "is there a value the
 * engine can produce that the Host refuses", and a float durability of 1e-30 is a legal answer to it.
 */
const PRODUCER_DOMAINS: ReadonlyMap<string, Interval> = new Map([
  ["int", { low: { value: -2147483648, inclusive: true }, high: { value: 2147483647, inclusive: true } }],
  ["long", { low: { value: -(2 ** 63), inclusive: true }, high: { value: 2 ** 63, inclusive: true } }],
  ["short", { low: { value: -32768, inclusive: true }, high: { value: 32767, inclusive: true } }],
  ["byte", { low: { value: 0, inclusive: true }, high: { value: 255, inclusive: true } }],
  ["float", UNBOUNDED],
  ["double", UNBOUNDED],
  ["decimal", UNBOUNDED],
]);

/** The Host helpers that bound a numeric field, as the interval they impose. */
const HOST_HELPERS: ReadonlyMap<string, Interval> = new Map([
  ["isTileCoordinate", { low: { value: 0, inclusive: true }, high: { value: 1000, inclusive: true } }],
  ["isToolSlot", { low: { value: 0, inclusive: true }, high: { value: 36, inclusive: true } }],
  // Non-negative and within the safe-integer range, which is wider than `int`: never a narrowing on its own.
  [
    "isNonNegativeSafeInteger",
    { low: { value: 0, inclusive: true }, high: { value: Number.MAX_SAFE_INTEGER, inclusive: true } },
  ],
  ["isFiniteNumber", UNBOUNDED],
  // A machine's own trigger-row consumption count: positive, and bounded above by the Host's ceiling rather than by a
  // game fact (`MachineOutputTriggerRule.RequiredCount`).
  ["isMachineInputCount", { low: { value: 1, inclusive: true }, high: { value: 9999, inclusive: true } }],
]);

const escapePattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The interval one Host predicate imposes on one field.
 *
 * Reads only comparisons against LITERALS and the named helpers. A comparison against another field
 * (`value.maxHealth >= value.health`) says nothing about this field's own range and is skipped rather than guessed at.
 */
function consumerInterval(body: string, key: string): Interval {
  let low: Bound = UNBOUNDED.low;
  let high: Bound = UNBOUNDED.high;
  let exact: number | null = null;
  const escaped = escapePattern(key);
  for (const match of body.matchAll(
    new RegExp(`value\\.${escaped}\\s*(>=|<=|>|<|===)\\s*(-?\\d+(?:\\.\\d+)?)`, "gu"),
  )) {
    const operator = captured(match, 1, `a comparison operator on \`${key}\``);
    const bound = Number(captured(match, 2, `a comparison literal on \`${key}\``));
    if (operator === ">=") low = tighterLow(low, { value: bound, inclusive: true });
    else if (operator === ">") low = tighterLow(low, { value: bound, inclusive: false });
    else if (operator === "<=") high = tighterHigh(high, { value: bound, inclusive: true });
    else if (operator === "<") high = tighterHigh(high, { value: bound, inclusive: false });
    else exact = bound;
  }
  for (const [helper, interval] of HOST_HELPERS) {
    if (!new RegExp(`${helper}\\(\\s*value\\.${escaped}\\s*\\)`, "u").test(body)) continue;
    low = tighterLow(low, interval.low);
    high = tighterHigh(high, interval.high);
  }
  // `=== n` is a single value, and it is the tightest statement the predicate can make.
  if (exact !== null) return { low: { value: exact, inclusive: true }, high: { value: exact, inclusive: true } };
  return { low, high };
}

function tighterLow(current: Bound, candidate: Bound): Bound {
  if (candidate.value > current.value) return candidate;
  if (candidate.value < current.value) return current;
  return { value: current.value, inclusive: current.inclusive && candidate.inclusive };
}

function tighterHigh(current: Bound, candidate: Bound): Bound {
  if (candidate.value < current.value) return candidate;
  if (candidate.value > current.value) return current;
  return { value: current.value, inclusive: current.inclusive && candidate.inclusive };
}

/** Whether every value of `producer` is accepted by `consumer`. */
function isSubset(producer: Interval, consumer: Interval): boolean {
  if (producer.low.value < consumer.low.value) return false;
  if (producer.low.value === consumer.low.value && producer.low.inclusive && !consumer.low.inclusive) return false;
  if (producer.high.value > consumer.high.value) return false;
  if (producer.high.value === consumer.high.value && producer.high.inclusive && !consumer.high.inclusive) return false;
  return true;
}

function renderInterval(interval: Interval): string {
  const open = interval.low.inclusive ? "[" : "(";
  const close = interval.high.inclusive ? "]" : ")";
  const endpoint = (value: number): string => {
    if (Number.isFinite(value)) return String(value);
    return value > 0 ? "int.MaxValue+" : "-inf";
  };
  return `${open}${endpoint(interval.low.value)}, ${endpoint(interval.high.value)}${close}`;
}

/** One field whose producer domain the Host narrows. */
interface Narrowing {
  readonly field: string;
  readonly declaredType: string;
  readonly producer: Interval;
  readonly consumer: Interval;
}

/** The declared reason one `(declared type -> accepted interval)` signature is legitimate. */
interface DeclaredNarrowing {
  readonly declaredType: string;
  readonly accepts: string;
  readonly count: number;
  readonly reason: string;
}

/**
 * Every narrowing signature this tree accepts, with the ENGINE fact that makes it legitimate.
 *
 * `count` is the derived population at this commit, pinned so a new field in a known signature fails instead of
 * inheriting an assumption nobody checked. Removing an entry is how a widening is recorded.
 */
const DECLARED_NARROWINGS: readonly DeclaredNarrowing[] = [
  {
    declaredType: "int",
    accepts: "[0, 1000]",
    count: 105,
    reason:
      "a tile coordinate. `isTileCoordinate` bounds every one of them, and the Mod's own discovery clamps to the same " +
      "range before publishing - `DiscoverWeedTargets` and `DiscoverGrassTargets` both spell out `>= 0 && <= 1000`. A " +
      "coordinate outside it is not a place in any Stardew map. This is the largest group because a tile is on almost " +
      "every family. The three `farmAnimalPetTargets` fields that joined it: `x`/`y` are the animal's tile, and " +
      "`friendship` is `FarmAnimal.friendshipTowardFarmer`, which the engine itself caps with `Math.Min(1000, ...)` on " +
      "every branch of `FarmAnimal.pet` (FarmAnimal.cs:754/758/762/774) - so `[0, 1000]` is the animal's own range, " +
      "not a Host guess.",
  },
  {
    declaredType: "int",
    accepts: "[0, 36]",
    count: 14,
    reason:
      "a backpack slot. The farmer's inventory is 36 slots, the same ceiling `isToolSlot` states and the same one the " +
      "Mod's `MaximumInventorySlot` names; a slot outside it indexes nothing.",
  },
  {
    declaredType: "int?",
    accepts: "[0, 36]",
    count: 2,
    reason: "the same 36-slot backpack bound, on a field the Mod may omit entirely.",
  },
  {
    declaredType: "int?",
    accepts: "[0, 1000]",
    count: 4,
    reason:
      "the nearest ripening tile on `harvestWhereabouts` and `wateringWhereabouts`, absent when the row describes another " +
      "map. A coordinate for a map the actor is not on is not an address, so the Mod publishes its count alone; when the " +
      "pair IS present both members are a real tile, bounded by the same `isTileCoordinate` as every other coordinate.",
  },
  {
    declaredType: "int",
    accepts: "[1, 25]",
    count: 1,
    reason:
      "a breakable stone's DURABILITY, and both ends are the engine's. Every path that creates a stone writes 1 or " +
      "more and never 0 - the constructor's `default` arm writes 1 and 8/10/12/14/25 get their own value " +
      "(Object.cs:920-943), the mountain writes 2-16 (Farm.cs:551-601, Mountain.cs:259-317), a mine node writes 1 up " +
      "to 25 (MineShaft.cs:4354-4359), the volcano writes 1-16 (VolcanoDungeon.cs:1521-1556). 25 is the largest value " +
      "ANY path writes and nothing clamps above it, so 25 is measured, not rounded - the `100` this replaced was the " +
      "round number. A stone reaches 0 only inside the swing that removes it (Object.cs:1129-1133, Pickaxe.cs:139-178) " +
      "and discovery runs on the game thread, so 0 is never a discoverable stone.",
  },
  {
    declaredType: "float",
    accepts: "(0, 10]",
    count: 1,
    reason:
      "a live tree's health. A mature tree starts at `startingHealth = 10` (Tree.cs:38, assigned :187 and :203) and the " +
      "axe subtracts in place until it falls at `<= 0` (Tree.cs:1177-1200), so `> 0 && <= 10` is exactly the engine's " +
      "population. This is the field the Host read as `=== 1` in `c66ad0eb`.",
  },
  {
    declaredType: "int",
    accepts: "[5, 20]",
    count: 1,
    reason:
      "a choppable tree's growth stage. The floor of 5 is `Tree.treeStage` - the stage at which a tree can be chopped - " +
      "and 20 is the ceiling the Mod's discovery applies before publishing.",
  },
  {
    declaredType: "float",
    accepts: "[5, 5]",
    count: 1,
    reason:
      "a felled tree's stump health. `Tree.performToolAction` sets `health.Value = 5f` on the felling swing " +
      "(Tree.cs:1496), so a stump IS the single value 5 and the Host's `=== 5` is the engine's constant, not a guess.",
  },
  {
    declaredType: "float",
    accepts: "[0, 1000]",
    count: 1,
    reason: "a tree stump's health as the stump family publishes it, bounded by the Host at 1000.",
  },
  {
    declaredType: "int",
    accepts: "[1, 1000]",
    count: 1,
    reason:
      "a grass tuft's `numberOfWeeds`. Discovery refuses `<= 0` before publishing (`DiscoverGrassTargets`), and 1000 is " +
      "the same bound the Host applies to the tile the tuft occupies.",
  },
  {
    declaredType: "int",
    accepts: "[1, 8]",
    count: 1,
    reason: "a grass type. `Grass.grassType` is the game's own 1..8 index into the tuft's sprite sheet.",
  },
  {
    declaredType: "int",
    accepts: "[0, 100]",
    count: 1,
    reason:
      "the water currently in a watering can. The Host bounds it at the can's own `max`, which is on the same " +
      "predicate; 100 is that ceiling.",
  },
  {
    declaredType: "int",
    accepts: "(0, 100]",
    count: 2,
    reason:
      "a watering can's capacity and a debris clump's health. Both are bounded above by the Host's own `<= 100`, which " +
      "has NO engine citation behind it - this is one of the invented ceilings this gate was built to make visible.",
  },
  {
    declaredType: "int",
    accepts: "(0, 999]",
    count: 5,
    reason: "a stack count. `Item.maximumStackSize` is 999 and a published stack is never empty.",
  },
  {
    declaredType: "int",
    accepts: "[1, 1]",
    count: 2,
    reason: "the single bait item a crab pot holds; the Mod writes the literal `1` at both publish sites.",
  },
  {
    declaredType: "int?",
    accepts: "[1, 9999]",
    count: 1,
    reason:
      "the count a machine's own `Data/Machines` trigger row declares for the input it accepts " +
      "(`MachineOutputTriggerRule.RequiredCount`), which the Mod publishes as `loadInputStack` and then consumes. The " +
      "floor is the engine's: a load consumes at least one item (the same row's count decides how many, so the Host's " +
      "9999 is an invented ceiling, not a game fact).",
  },
  {
    declaredType: "int",
    accepts: "[2, 2]",
    count: 1,
    reason:
      "the single produce stack the milk/shear contract admits; the Mod publishes `produce.Stack` for a tool that " +
      "yields 2.",
  },
  {
    declaredType: "int",
    accepts: "[0, 1]",
    count: 2,
    reason: "a per-map count the Host reads as a flag (`readyForHarvestCount`, `needsWaterCount`).",
  },
  {
    declaredType: "int",
    accepts: "[0, 2000]",
    count: 1,
    reason: "a `parentSheetIndex`, the game's own sprite index, bounded by the Host at 2000.",
  },
  {
    declaredType: "int",
    accepts: "[0, 4]",
    count: 1,
    reason:
      "a tool upgrade level. `Tool.upgradeLevel` is 0..4 (basic through iridium), the same closed set the Mod's " +
      "`FarmhandResourceTemplateValue.AnyUpgrade` admits.",
  },
  {
    declaredType: "int",
    accepts: "[0, 100000]",
    count: 1,
    reason:
      "a machine's `MinutesUntilReady`. The Host's ceiling has NO engine citation; a long-running machine's own " +
      "countdown is the only producer bound, so this is one of the invented ceilings.",
  },
  {
    declaredType: "int",
    accepts: "[-1, 10000]",
    count: 1,
    reason:
      "a friendship score. `Friendship.points` is a running total with no engine ceiling; -1 is the Host's floor for " +
      "an unmet villager and 10000 its upper bound.",
  },
  {
    declaredType: "int",
    accepts: "[0, 10]",
    count: 1,
    reason: "the gifts given today, bounded by the Host at 10 around the game's own two-gift daily limit.",
  },
  {
    declaredType: "int",
    accepts: "[0, 20]",
    count: 1,
    reason: "the gifts given this week, bounded by the Host at 20.",
  },
  {
    declaredType: "int",
    accepts: "[0, 120]",
    count: 1,
    reason: "a mine elevator floor. The deepest reachable floor of the vanilla mine is 120.",
  },
  {
    declaredType: "int",
    accepts: "[-299, 1000]",
    count: 1,
    reason:
      "an item's `Edibility`, whose negative end is the engine's own inedible sentinel and whose upper end is the " +
      "Host's ceiling.",
  },
  {
    declaredType: "int",
    accepts: "[0, 9007199254740991]",
    count: 2,
    reason:
      "a container's stack and item totals, read through `isNonNegativeSafeInteger`. The bound is wider than `int`, so " +
      "it exists only to keep the signature visible rather than to exclude anything.",
  },
  {
    declaredType: "int",
    accepts: "[0, int.MaxValue+)",
    count: 6,
    reason:
      "an unbounded count floored at 0 by the Host and by no engine fact: `upgradeLevel`, a minecart price, a shop " +
      "stock count, a fish pond's occupants, a building's cost and its build days.",
  },
  {
    declaredType: "int",
    accepts: "[1, int.MaxValue+)",
    count: 1,
    reason: "a positive stack the Host floors at 1; a collected crab pot's `outputStack` is never zero.",
  },
  {
    declaredType: "int",
    accepts: "(0, int.MaxValue+)",
    count: 2,
    reason: "a positive count the Host floors exclusively at 0 (`shippingBinTargets.stack`, `rewardCount`).",
  },
  {
    declaredType: "int",
    accepts: "[-1, int.MaxValue+)",
    count: 2,
    reason: "a slot or day counter whose -1 is the engine's own 'not set' sentinel.",
  },
  {
    declaredType: "float",
    accepts: "(0, int.MaxValue+)",
    count: 1,
    reason: "a fence's health, floored above zero by the Host; the Mod publishes it from the live fence.",
  },
  {
    declaredType: "long",
    accepts: "[0, int.MaxValue+)",
    count: 1,
    reason: "a player's `UniqueMultiplayerID`, a `long` the Host reads as a non-negative number.",
  },
];

const signatureOf = (declaredType: string, consumer: Interval): string => `${declaredType} ${renderInterval(consumer)}`;

/** Every numeric field of every family the Host validates, with the domain each side implies. */
function narrowings(): readonly Narrowing[] {
  const records = modRecords();
  const families = modFamilies();
  const validators = hostValidators();
  const rules = hostFamilyRules();
  const found: Narrowing[] = [];
  for (const [family, recordName] of families) {
    const matched = validatorFor(lowerFirst(family), rules, validators);
    if ("missing" in matched) continue;
    const fields = records.get(recordName);
    if (fields === undefined) continue;
    const declaredKeys = new Set(matched.validator.keys);
    for (const field of fields) {
      const declaredType = field.type.trim();
      const producer = PRODUCER_DOMAINS.get(declaredType.replace(/\?$/u, ""));
      // A `string`/`bool`/list field has no numeric domain; `int?` carries the same one as `int`.
      if (producer === undefined) continue;
      const key = lowerFirst(field.name);
      // A key the Host's own list does not name is `declaration-agreement.test.ts`'s finding, not this one's.
      if (!declaredKeys.has(key)) continue;
      const consumer = consumerInterval(matched.validator.body, key);
      if (isSubset(producer, consumer)) continue;
      found.push({ field: `${family}.${key}`, declaredType, producer, consumer });
    }
  }
  return found;
}

test("the comparison is not vacuous: the fields this repository got wrong are all found", () => {
  // A parser that found nothing would report perfect agreement with everything. These three are the fields the
  // round-trip work already proved exist on both sides, and two of them are the defect this gate was built for.
  const found = new Set(narrowings().map((entry) => entry.field));
  for (const field of ["RockSourceTargets.health", "TreeChopSourceTargets.health", "GrassTargets.numberOfWeeds"])
    assert.ok(found.has(field), `the gate must find \`${field}\`; it found ${found.size} narrowings in total`);

  assert.ok(modRecords().size > 100, `the Mod's records must have been parsed (found ${modRecords().size})`);
  assert.ok(modFamilies().size > 70, `BridgeSnapshot must declare its families (found ${modFamilies().size})`);
  assert.ok(hostValidators().size > 80, `the Host's validators must have been parsed (found ${hostValidators().size})`);

  // And a field with NO Host bound must not be reported: the comparison has to be able to say "fine".
  assert.ok(!found.has("ToolSlots.label"), "a string field must not be reported as a numeric narrowing");
  assert.ok(!found.has("RockSourceTargets.targetId"), "an opaque id must not be reported as a numeric narrowing");
});

test("every numeric field the Host narrows is declared, with the engine fact that justifies it", () => {
  const declared = new Set(
    DECLARED_NARROWINGS.map((entry) => signatureOf(entry.declaredType, parseInterval(entry.accepts))),
  );
  const undeclared = narrowings()
    .filter((entry) => !declared.has(signatureOf(entry.declaredType, entry.consumer)))
    .map(
      (entry) =>
        `${entry.field}: the Mod publishes a C# \`${entry.declaredType}\` (${renderInterval(entry.producer)}) and the ` +
        `Host accepts only ${renderInterval(entry.consumer)}`,
    );
  assert.deepEqual(
    undeclared,
    [],
    "a producer publishes a value the consumer's validator rejects, and because the Host refuses the WHOLE snapshot " +
      "one such field closes the bridge on a real farm - that is `c66ad0eb` (tree health `=== 1`) and `def2fb07` " +
      "(rock health `=== 1`), and eight live runs died one field at a time. Either widen the Host bound to the " +
      "producer's real range, or declare the narrowing here with the engine fact that makes it correct:\n" +
      undeclared.join("\n"),
  );
});

test("every declared signature still narrows exactly the number of fields it recorded", () => {
  const counts = new Map<string, string[]>();
  for (const entry of narrowings()) {
    const signature = signatureOf(entry.declaredType, entry.consumer);
    const members = counts.get(signature) ?? [];
    members.push(entry.field);
    counts.set(signature, members);
  }

  const problems: string[] = [];
  for (const declared of DECLARED_NARROWINGS) {
    const signature = signatureOf(declared.declaredType, parseInterval(declared.accepts));
    const actual = (counts.get(signature) ?? []).sort();
    // A declared entry that matches nothing is a reason nobody can check, and a reason that outlives its fields is
    // exactly how "the validator is looser than the record" becomes invisible.
    if (actual.length === 0)
      problems.push(
        `${signature}: declared with ${declared.count} field(s), and the Host no longer narrows any - the consumer ` +
          "widened or the family is gone. Remove the entry, because a reason that outlives its field is a claim " +
          "nobody can falsify.",
      );
    else if (actual.length !== declared.count)
      problems.push(
        `${signature}: declared ${declared.count} field(s), found ${actual.length} [${actual.join(", ")}] - a field ` +
          "joined or left this signature. A new one needs its engine fact written down; a departure means the Host " +
          "widened and the count should fall with it.",
      );
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("the census is printed, so the count is a reading and not a claim", () => {
  const found = narrowings();
  const bySignature = new Map<string, readonly string[]>();
  for (const entry of found) {
    const signature = signatureOf(entry.declaredType, entry.consumer);
    bySignature.set(signature, [...(bySignature.get(signature) ?? []), entry.field]);
  }
  console.log(
    `protocol-target-facts-domain: ${found.length} numeric fields narrowed by the Host, in ${bySignature.size} ` +
      `distinct (declared type -> accepted interval) signatures`,
  );
  for (const [signature, members] of [...bySignature].sort((left, right) => right[1].length - left[1].length))
    console.log(`  [${members.length}] ${signature}: ${[...members].sort().join(", ")}`);

  // The ratchet: this number may fall, and a fall is a declaration above that must be removed with it. It may not rise.
  assert.ok(
    found.length <= NARROWING_CEILING,
    `the census rose to ${found.length}, above the recorded ${NARROWING_CEILING}. A new narrowing is a new place the ` +
      "producer can publish what the consumer refuses - declare it with its engine fact, and raise this ceiling in " +
      "the same commit so the increase is a reviewed decision rather than a quiet one",
  );
});

/** Read a declared `accepts` interval back into the shape the comparison uses. */
function parseInterval(text: string): Interval {
  const match = /^([[(])\s*(-?\d+|int\.MaxValue\+|-inf)\s*,\s*(-?\d+|int\.MaxValue\+|-inf)\s*([\])])$/u.exec(text);
  if (match === null) throw new Error(`a declared interval this reader cannot parse: "${text}"`);
  const endpoint = (raw: string): number => {
    if (raw === "int.MaxValue+") return Number.POSITIVE_INFINITY;
    if (raw === "-inf") return Number.NEGATIVE_INFINITY;
    return Number(raw);
  };
  return {
    low: {
      value: endpoint(captured(match, 2, "a declared lower endpoint")),
      inclusive: captured(match, 1, "a declared lower bracket") === "[",
    },
    high: {
      value: endpoint(captured(match, 3, "a declared upper endpoint")),
      inclusive: captured(match, 4, "a declared upper bracket") === "]",
    },
  };
}

/**
 * The recorded census at the commit this gate landed.
 *
 * A ratchet, not a target: the number may fall as bounds are corrected, and every entry that disappears must be
 * deleted from `DECLARED_NARROWINGS` in the same change (the count test above enforces that half).
 *
 * RAISED FROM 166 TO 169 by `farmAnimalPetTargets`, whose three numeric fields (a tile `x`/`y` pair and the animal's
 * `friendship`) are declared above with the engine fact that makes each legitimate.
 */
const NARROWING_CEILING = 169;
