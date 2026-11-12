import { hasOnlyKeys, isNonNegativeSafeInteger, isOpaqueId, isRecord } from "./protocol-target-facts.js";

/**
 * The `for_each` loop form, in one place, so the compiler that WRITES it and the wire validator that READS it back can
 * never disagree about its grammar.
 *
 * <p>
 * WHY THE FORM EXISTS. Measured from the plan scripts themselves: a "clear and plant a 3x20 patch" task ran 54 plan
 * batches and produced `till_soil` on 22 distinct tiles inside a 10x8 box (28% density), `plant_seed` on 13 tiles inside
 * 18x5 (14%), and no `water_crop` at all. The cause is the vocabulary rather than the planning: every node names ONE
 * published `targetId`, and published soil/crop targets are bounded to Chebyshev 6, so a 20-tile row never fits one
 * observation and the only behaviour left is reacting to the few tiles in view.
 * </p>
 * <p>
 * WHAT THIS FILE DOES NOT DO. It does not expand anything. Expansion happens on the game thread against live state, and
 * `FarmhandForEachRules` (Mod) is the authority for "does this row belong to this loop, and what happens to it". This
 * file only decides whether a caller's declaration is a loop this product could ever run, and it answers WHY when it is
 * not - a loop silently narrowed to the tiles in view is the defect the form was built to remove.
 * </p>
 * <p>
 * THE AREA IS A SOURCE, NOT A PRIVILEGED FORM. "Every dry crop on the farm" is a family source and "every tree with
 * health left" is a family source with a field predicate; neither is a rectangle. One loop semantic covers all three.
 * </p>
 */

/** One scalar a `where` predicate or a `do` argument may carry. */
type PlanForEachScalar = string | number | boolean;

/** A repeating position guard: `every: 3, offset: 1` claims local index 1, 4, 7 ... */
type PlanForEachStride = Readonly<{ every: number; offset: number }>;

/**
 * One predicate over a row. THREE SPELLINGS: a FIELD test, a POSITION guard on `col`/`row`, or the OCCUPANT of the tile.
 *
 * Position is the operator the whole form exists for. Trellis crops grow into impassable tiles, so a real farm leaves a
 * walkable column between trellis columns and plants a filler crop between trellis rows; those decisions depend on the
 * row's POSITION, never on what the tile contains, so a dispatch keyed on the row's kind cannot represent them.
 *
 * THE OCCUPANT SPELLING IS NOT A SECOND VOCABULARY. `{ occupant: "weed" }` is the field test on the field the Mod's
 * clearing join reads (`FarmhandForEachHealing.OccupantField`), whose words are the engine's own what-stands-here names -
 * exactly the words a `Clears` declaration is written in - so the two spellings mean one test and cannot come to disagree.
 * It exists because `kind` answers a different question: a mixed patch filtered by kind says "work whatever the Mod would
 * clear with a scythe", and one filtered by occupant says "work the weeds and leave the stones".
 */
type PlanForEachPredicate = Readonly<{
  col?: PlanForEachStride;
  row?: PlanForEachStride;
  field?: string;
  occupant?: string;
  eq?: PlanForEachScalar;
  ne?: PlanForEachScalar;
  lt?: PlanForEachScalar;
  lte?: PlanForEachScalar;
  gt?: PlanForEachScalar;
  gte?: PlanForEachScalar;
  in?: readonly PlanForEachScalar[];
}>;

type PlanForEachArea = Readonly<{ x: number; y: number; w: number; h: number }>;

/** Where a loop reads its rows from: one rectangle, one published family, or one subject the Mod classifies. */
type PlanForEachSource =
  | Readonly<{ area: PlanForEachArea }>
  | Readonly<{ family: string }>
  | Readonly<{ query: Readonly<{ subject: string; only?: string }> }>;

/**
 * One step of a row's chain: a published action with its own arguments.
 *
 * The SHAPE is exactly the object a lone `do` has always been - `{ action, <argument>: <scalar> }` - so a chain is that
 * object written several times and never a second argument spelling beside it.
 */
type PlanForEachStep = Readonly<{ action: string }> & Readonly<Record<string, PlanForEachScalar>>;

/**
 * What a matching row gets: an ORDERED CHAIN of steps worked on one tile in one pass, or `null` for "leave this row alone".
 *
 * <p>
 * WHY A CHAIN. Farm work is a chain per tile - clear, till, water, sow - and a form that could name only ONE action per row
 * needed one pass per action: four passes of waking, ordering and receipts over the same sixty tiles, each pass reporting
 * the tiles the previous one had just prepared by the action the next one wanted. One row is one tile's work, in the order
 * the caller wrote it, at most `MAX_FOR_EACH_STEPS` steps of it.
 * </p>
 * <p>
 * THE SINGLE FORM IS THE CHAIN OF LENGTH ONE, as it is in `FarmhandForEachEffect`: `do: { action }` and
 * `do: [{ action }]` read as the same value, so the reader that validates has one shape to answer and the Mod's expansion
 * has one shape to run.
 * </p>
 */
type PlanForEachEffect = readonly PlanForEachStep[];

/**
 * One more rule of the same pass: an optional predicate list and what a matching row gets.
 *
 * WHY A PASS HAS MORE THAN ONE RULE. A 3x20 intercropped patch is ONE intent and not three: hops on columns 0, 3, 6...,
 * coffee on 1, 4, 7..., and column 2, 5, 8... deliberately a path. Three separate passes would report every tile a pass
 * did not claim as `no_rule_matched` twice over, and a tile two rules claim would be worked twice; one pass with ordered
 * rules decides each row exactly once, by the FIRST rule that claims it.
 */
export type PlanForEachRule = Readonly<{ where?: readonly PlanForEachPredicate[]; do: PlanForEachEffect | null }>;

export type PlanForEachLoop = Readonly<{
  source: PlanForEachSource;
  where?: readonly PlanForEachPredicate[];
  do: PlanForEachEffect | null;
  /** The rules tried after this one, in the order the caller wrote them. */
  then?: readonly PlanForEachRule[];
}>;

/** The three row sources. */
export const PLAN_FOR_EACH_SOURCES: readonly string[] = Object.freeze(["area", "family", "query"]);

/** The two axes a repeating position guard claims. */
const PLAN_FOR_EACH_AXES: readonly string[] = Object.freeze(["col", "row"]);

/**
 * The spellings a `where` predicate may be written with: the keys that say WHAT one predicate tests.
 *
 * ONE DECLARATION, and every refusal for a word this form does not have is generated from it - a second hand-written copy
 * of these words beside the message is how a caller ends up told `for_each_where_unrecognised:in` and left to guess what
 * `where` does accept. Mirrors `FarmhandForEachPredicate.Selectors`, and `body-program-for-each.test.ts` reads that array
 * out of the Mod and asserts the two are equal, so a spelling added on either side is red on both.
 */
export const PLAN_FOR_EACH_PREDICATE_SPELLINGS: readonly string[] = Object.freeze([
  "field",
  ...PLAN_FOR_EACH_AXES,
  "occupant",
]);

/** The two keys a repeating position guard is written with, declared once for the same reason the spellings are. */
const PLAN_FOR_EACH_STRIDE_SPELLINGS: readonly string[] = Object.freeze(["every", "offset"]);

/**
 * The word both sides answer when a declaration names something the `where` grammar does not have.
 *
 * ONE WORD ON BOTH SIDES: the compiler refuses such a declaration before submission and the Mod refuses it again on the
 * game thread (`FarmhandForEachArguments.WhereUnrecognised`), and the answer is
 * `<this>:<given>;allowed=<a>,<b>` - the word that was written, then the words that may be written instead.
 */
export const FOR_EACH_WHERE_UNRECOGNISED = "for_each_where_unrecognised";

/** `<given>;allowed=<a>,<b>`, with the alternatives taken from the declaration that owns them. */
function forEachWhereUnrecognised(given: string, allowed: readonly string[]): string {
  return `${given};allowed=${allowed.join(",")}`;
}

/** The comparisons a field predicate offers. `in` is the only one that takes a list. */
const PLAN_FOR_EACH_COMPARISONS: readonly string[] = Object.freeze(["eq", "ne", "lt", "lte", "gt", "gte", "in"]);

/**
 * The token that means "whatever action the Mod's own classifier names for this row's kind".
 *
 * It is a REFERENCE and not a mapping the caller supplies: the classifier that names a kind is the only thing that can
 * say which action clears it, so the table lives beside the classifier and a caller may not restate it. Mirrors
 * `FarmhandForEachEffect.ByKindAction`; it is accepted here because the Host cannot resolve a Mod-classified action
 * against its own vocabulary.
 */
export const PLAN_FOR_EACH_BY_KIND_ACTION = "by_kind";

/**
 * The one `do` argument the MOD fills per row, and a caller may never declare.
 *
 * A row's target identity is minted from the LIVE tile by the family the action's own descriptor declares
 * (`FarmhandActionDescriptor.TargetFamily`), which is the whole reason a loop can address a patch it never observed. A
 * caller that wrote one would be stating an id for a tile it cannot see - true only until the world differs - so it is
 * refused rather than silently overridden. Mirrors `FarmhandForEachArguments.ExpectedTargetIdArgument`.
 */
export const PLAN_FOR_EACH_ROW_IDENTITY_ARGUMENT = "expectedTargetId";

/**
 * Why a `do` that names the row's own target identity is refused.
 *
 * Mirrors `FarmhandForEachArguments.RowIdentityIsNotTheCallers`; the Mod is the side that answers it on the game thread,
 * and the compiler answers the same word so the caller cannot be told one code and refused with another.
 */
export const PLAN_FOR_EACH_ROW_IDENTITY_REFUSAL = "for_each_row_identity_is_not_the_callers";
/**
 * How many rows one loop may address.
 *
 * A per-INTENT bound, not a view radius: the point of the form is that a 3x20 row is bigger than the 13x13 an
 * observation carries. Over the bound the answer names the count and the rectangle it covered - never a truncated table
 * that reads as a finished pass. Mirrors `FarmhandForEachSource.MaximumRows`, and the two numbers are asserted equal
 * against the Mod's own constant rather than restated silently.
 */
export const MAX_FOR_EACH_ROWS = 64;

/** How many predicates one loop may carry: a conjunction long enough to be a rule, short enough to be read. */
const MAX_FOR_EACH_PREDICATES = 8;

/** How many rules one pass may carry, this loop's own included. */
export const MAX_FOR_EACH_RULES = 8;

/**
 * How many characters one loop DOCUMENT may occupy once it is a canonical string on the wire.
 *
 * THE NUMBER IS THE MOD'S, NOT THIS FILE'S. A `type: "loop"` argument is turned into the string its argument declares at
 * the one boundary that knows the tag (`integrations/stardew/src/Core/Protocol/BridgeProtocol.cs`
 * `TryReadRuntimeArguments` -> `FarmhandForEachArguments.TryCanonicalize`), which refuses a document longer than
 * `FarmhandForEachArguments.MaximumDocumentChars` and so fails the whole candidate read. A document over it can never
 * cross, and the pipe's answer (`invalid_body_program_candidate`) names nothing a caller can fix, so the COMPILER refuses
 * it first with its own length. `body-program-for-each.test.ts` reads that Mod constant and asserts the two are equal, so
 * this is a mirror of a published bound rather than a second opinion; the scalar-argument cap is the same number on both
 * sides (`host/src/protocol.ts` `isBodyCanonicalValue`, `BodyProgramValidation.TryDecodeRuntimeValue`).
 *
 * WHAT FITS, MEASURED through `forEachDocumentLength` on the loop this reader produces: a 20x3 strip with one `then` rule
 * (`till_soil` on columns 0,3,6..., `plant_seed` on 1,4,7...) is 198 characters, and a 3x20 three-rule pass (`till_soil`,
 * `plant_seed`, `do: null` on the path column) is 251 - both comfortably inside. Eight rules of long field names do NOT
 * fit, and no bound chosen here would make them: the Mod's 512 is the smaller authority, so the length check IS the
 * document's limit and the description prints it. The rule/predicate/value bounds above remain validation bounds, not
 * length arithmetic.
 */
export const MAX_FOR_EACH_LOOP_DOCUMENT_CHARS = 512;

/** The document a node carries, as the canonical string the Mod reads: the loop itself, with no wire tag. */
export function forEachDocumentLength(loop: PlanForEachLoop): number {
  return JSON.stringify(loop).length;
}

/** How many values one `in` list may carry. */
const MAX_FOR_EACH_VALUES = 8;

/**
 * How long the word `where: { occupant }` names may be.
 *
 * The wire's own bound on the SAME fact: a tile row's `occupant` is a string of at most this many characters
 * (`host/src/protocol.ts` `isBoundedNonEmptyString(value.occupant, 64)`), so a longer one could never match a row the Mod
 * publishes and is refused where the caller can still see what it wrote.
 */
export const MAX_FOR_EACH_OCCUPANT_CHARS = 64;

/** How many arguments one `do` effect may name. */
const MAX_FOR_EACH_EFFECT_ARGUMENTS = 16;

/**
 * How many steps one row may chain: long enough to be the clear-till-water-sow chain a farm tile really needs, short enough
 * that a row is still one tile's work and not a plan. Mirrors `FarmhandForEachEffect.MaximumSteps`.
 */
export const MAX_FOR_EACH_STEPS = 4;

/**
 * Why a declaration is not a loop this product could run, or the loop itself.
 *
 * `code` is the grammar's own name for the mistake and `detail` says WHICH row of the declaration broke it, so the
 * caller's refusal names the thing to fix instead of the whole document it already wrote.
 */
type PlanForEachRejection = Readonly<{ ok: false; code: string; detail: string }>;

export type PlanForEachReading = Readonly<{ ok: true; loop: PlanForEachLoop }> | PlanForEachRejection;

function rejected(code: string, detail = ""): PlanForEachRejection {
  return Object.freeze({ ok: false as const, code, detail });
}

/**
 * Reads one `builder.for_each({ source, where, do })` argument.
 *
 * `actionIds` is the plannable vocabulary the `do` action is checked against, or `null` when the caller cannot supply
 * one (the wire validator reads the same document back without a catalogue and must not invent the check).
 */
export function readForEachLoop(value: unknown, actionIds: readonly string[] | null): PlanForEachReading {
  if (!isRecord(value)) return rejected("loop_invalid", "not_an_object");
  // ONE LEVEL IS WHAT THIS BUYS, and nesting is refused BY NAME rather than flattened: a loop inside a loop would either
  // multiply the row bound silently or expand against the outer row's tile, and both are a plan nobody wrote.
  if (namesNestedLoop(value, new Set<object>())) return rejected("nested_loop_unsupported");
  const unknownKey = Object.keys(value).find((key) => !["source", "where", "do", "then"].includes(key));
  if (unknownKey !== undefined) return rejected("loop_invalid", `unknown:${unknownKey}`);
  const source = readSource(value.source);
  if (!source.ok) return source;
  const where = readWhere(value.where);
  if (!where.ok) return where;
  const effect = readEffect(value.do, actionIds);
  if (!effect.ok) return effect;
  const alternates = readAlternates(value.then, actionIds);
  if (!alternates.ok) return alternates;
  const loop: PlanForEachLoop = Object.freeze({
    source: source.source,
    ...(where.predicates === undefined ? {} : { where: where.predicates }),
    do: effect.effect,
    ...(alternates.rules === undefined ? {} : { then: alternates.rules }),
  });
  return Object.freeze({ ok: true as const, loop });
}

type AlternatesReading = Readonly<{ ok: true; rules: readonly PlanForEachRule[] | undefined }> | PlanForEachRejection;

/** The rules a pass tries after its own, in the order the caller wrote them. */
function readAlternates(value: unknown, actionIds: readonly string[] | null): AlternatesReading {
  if (value === undefined) return Object.freeze({ ok: true as const, rules: undefined });
  if (!Array.isArray(value)) return rejected("loop_then_invalid", "not_an_array");
  if (value.length + 1 > MAX_FOR_EACH_RULES)
    return rejected("loop_then_invalid", `too_many:${String(value.length + 1)}`);
  const rules: PlanForEachRule[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) return rejected("loop_then_invalid", `rule[${String(index)}]:not_an_object`);
    const unknownKey = Object.keys(entry).find((key) => !["where", "do"].includes(key));
    if (unknownKey !== undefined) return rejected("loop_then_invalid", `rule[${String(index)}]:unknown:${unknownKey}`);
    if (!Object.hasOwn(entry, "do")) return rejected("loop_then_invalid", `rule[${String(index)}]:missing_do`);
    const where = readWhere(entry.where);
    if (!where.ok) return where;
    const effect = readEffect(entry.do, actionIds);
    if (!effect.ok) return effect;
    rules.push(
      Object.freeze({
        ...(where.predicates === undefined ? {} : { where: where.predicates }),
        do: effect.effect,
      }),
    );
  }
  return Object.freeze({ ok: true as const, rules: Object.freeze(rules) });
}

/**
 * Whether the declaration names the same form again anywhere inside it.
 *
 * EVERY OBJECT IS VISITED ONCE, which is the whole guard: a declaration that reaches itself - `then: [itself]`, built in
 * the script rather than written as a literal - terminates instead of recursing, and no depth anywhere is cut short, so
 * a `for_each` buried in a declaration this shape has no rule for is still named as what it is.
 */
function namesNestedLoop(value: unknown, visited: Set<object>): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (visited.has(value)) return false;
  visited.add(value);
  if (Array.isArray(value)) return value.some((entry) => namesNestedLoop(entry, visited));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) => key === "for_each" || namesNestedLoop(entry, visited));
}

type SourceReading = Readonly<{ ok: true; source: PlanForEachSource }> | PlanForEachRejection;

function readSource(value: unknown): SourceReading {
  // A loop with no source is refused rather than defaulting to the actor's own tile: "the tile I am standing on" is not
  // a rectangle, and a plan that quietly ran over one tile while the caller meant a patch is the measured defect.
  if (value === undefined || value === null) return rejected("loop_source_invalid", "missing");
  if (!isRecord(value)) return rejected("loop_source_invalid", "not_an_object");
  const kinds = PLAN_FOR_EACH_SOURCES.filter((kind) => Object.hasOwn(value, kind));
  if (kinds.length === 0) return rejected("loop_source_invalid", "missing");
  if (kinds.length > 1) return rejected("loop_source_invalid", `ambiguous:${kinds.join(",")}`);
  const unknownKey = Object.keys(value).find((key) => !PLAN_FOR_EACH_SOURCES.includes(key));
  if (unknownKey !== undefined) return rejected("loop_source_invalid", `unknown:${unknownKey}`);
  const kind = kinds[0]!;
  if (kind === "area") return readArea(value.area);
  if (kind === "family") {
    const family = value.family;
    if (typeof family !== "string" || family.length < 1 || family.length > 64)
      return rejected("loop_source_invalid", "family");
    return Object.freeze({ ok: true as const, source: Object.freeze({ family }) });
  }
  return readQuery(value.query);
}

function readArea(value: unknown): SourceReading {
  if (!isRecord(value)) return rejected("loop_source_invalid", "area");
  const { x, y, w, h } = value;
  if (
    !isNonNegativeSafeInteger(x) ||
    !isNonNegativeSafeInteger(y) ||
    !isNonNegativeSafeInteger(w) ||
    !isNonNegativeSafeInteger(h) ||
    !hasOnlyKeys(value, ["x", "y", "w", "h"])
  )
    return rejected("loop_source_invalid", "area");
  // An extent of zero addresses no row, which is a loop that can never do anything - refused rather than run.
  if (w < 1 || h < 1) return rejected("loop_source_invalid", "area");
  const rows = w * h;
  if (rows > MAX_FOR_EACH_ROWS) return rejected("loop_too_large", `${String(rows)}:${String(MAX_FOR_EACH_ROWS)}`);
  return Object.freeze({
    ok: true as const,
    source: Object.freeze({ area: Object.freeze({ x, y, w, h }) }),
  });
}

function readQuery(value: unknown): SourceReading {
  if (!isRecord(value)) return rejected("loop_source_invalid", "query");
  const subject = value.subject;
  const only = value.only;
  if (typeof subject !== "string" || subject.length < 1 || subject.length > 64)
    return rejected("loop_source_invalid", "query");
  if (only !== undefined && (typeof only !== "string" || only.length < 1 || only.length > 64))
    return rejected("loop_source_invalid", "query");
  if (!hasOnlyKeys(value, only === undefined ? ["subject"] : ["subject", "only"]))
    return rejected("loop_source_invalid", "query");
  return Object.freeze({
    ok: true as const,
    source: Object.freeze({
      query: Object.freeze({ subject, ...(only === undefined ? {} : { only }) }),
    }),
  });
}

type WhereReading =
  | Readonly<{ ok: true; predicates: readonly PlanForEachPredicate[] | undefined }>
  | PlanForEachRejection;

function readWhere(value: unknown): WhereReading {
  // An absent predicate list is not an error: the caller may genuinely mean "every row of this source".
  if (value === undefined) return Object.freeze({ ok: true as const, predicates: undefined });
  if (!Array.isArray(value)) return rejected("loop_where_invalid", "not_an_array");
  if (value.length > MAX_FOR_EACH_PREDICATES) return rejected("loop_where_invalid", `too_many:${String(value.length)}`);
  const predicates: PlanForEachPredicate[] = [];
  for (const [index, entry] of value.entries()) {
    const predicate = readPredicate(entry, `predicate[${String(index)}]`);
    if (!predicate.ok) return predicate;
    predicates.push(predicate.predicate);
  }
  return Object.freeze({ ok: true as const, predicates: Object.freeze(predicates) });
}

type PredicateReading = Readonly<{ ok: true; predicate: PlanForEachPredicate }> | PlanForEachRejection;

function readPredicate(value: unknown, at: string): PredicateReading {
  if (!isRecord(value)) return rejected("loop_where_invalid", `${at}:not_an_object`);
  // A PREDICATE IS ONE SPELLING OF `PLAN_FOR_EACH_PREDICATE_SPELLINGS`. Zero or two is answered with the list rather than
  // with the caller's own word back, which is the difference between a refusal and a shrug: `{ in: ["weed"] }` used to be
  // told `missing_field`, naming neither what it wrote nor what it may write.
  const spellings = PLAN_FOR_EACH_PREDICATE_SPELLINGS.filter((spelling) => Object.hasOwn(value, spelling));
  if (spellings.length !== 1) {
    const given = spellings.length === 0 ? Object.keys(value).join(",") || "empty" : spellings.join(",");
    return rejected(
      FOR_EACH_WHERE_UNRECOGNISED,
      forEachWhereUnrecognised(`${at}:${given}`, PLAN_FOR_EACH_PREDICATE_SPELLINGS),
    );
  }
  const spelling = spellings[0]!;
  // Anything else beside the one spelling is a second test, and a second test is a second predicate: the caller should
  // write two, and the alternatives this answer names are the ones the spelling it wrote accepts beside itself.
  const others = Object.keys(value).filter((key) => key !== spelling);
  if (spelling === "col" || spelling === "row") {
    if (others.length > 0)
      return rejected(
        FOR_EACH_WHERE_UNRECOGNISED,
        forEachWhereUnrecognised(`${at}:${others[0]!}`, PLAN_FOR_EACH_PREDICATE_SPELLINGS),
      );
    const stride = readStride(value[spelling], `${at}.${spelling}`);
    if (!stride.ok) return stride;
    return Object.freeze({
      ok: true as const,
      predicate: spelling === "col" ? Object.freeze({ col: stride.stride }) : Object.freeze({ row: stride.stride }),
    });
  }
  if (spelling === "occupant") {
    if (others.length > 0)
      return rejected(
        FOR_EACH_WHERE_UNRECOGNISED,
        forEachWhereUnrecognised(`${at}:${others[0]!}`, PLAN_FOR_EACH_PREDICATE_SPELLINGS),
      );
    const occupant = value.occupant;
    // THE WORD IS THE MOD'S TO KNOW: `weed`, `stone`, `crop` are the engine's own names for what stands on a tile, and a
    // list of them here would be a second vocabulary a new occupant would have to be added to. Only the LENGTH is this
    // side's fact, and it is the length the wire already bounds that field by.
    if (typeof occupant !== "string" || occupant.length < 1 || occupant.length > MAX_FOR_EACH_OCCUPANT_CHARS)
      return rejected("loop_where_invalid", `${at}:occupant`);
    return Object.freeze({ ok: true as const, predicate: Object.freeze({ occupant }) });
  }
  const field = value.field;
  if (typeof field !== "string" || field.length < 1 || field.length > 64)
    return rejected("loop_where_invalid", `${at}:field`);
  // A WORD THAT IS NOT A COMPARISON IS ANSWERED BEFORE THE COUNT, because naming it is the more useful answer: `equals`
  // beside `field` says the caller spelled a comparison wrongly, not that a comparison is missing.
  const unknown = others.find((key) => !PLAN_FOR_EACH_COMPARISONS.includes(key));
  if (unknown !== undefined)
    return rejected(
      FOR_EACH_WHERE_UNRECOGNISED,
      forEachWhereUnrecognised(`${at}:${unknown}`, PLAN_FOR_EACH_COMPARISONS),
    );
  if (others.length !== 1)
    return rejected("loop_where_invalid", `${at}:${field}:one_of:${PLAN_FOR_EACH_COMPARISONS.join(",")}`);
  const comparison = others[0]!;
  if (comparison === "in") {
    const list = value.in;
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_FOR_EACH_VALUES)
      return rejected("loop_where_invalid", `${at}:${field}:in`);
    const values: PlanForEachScalar[] = [];
    for (const [index, entry] of list.entries()) {
      const scalar = readScalar(entry, `${at}.${field}.in[${String(index)}]`);
      if (!scalar.ok) return scalar;
      values.push(scalar.value);
    }
    return Object.freeze({
      ok: true as const,
      predicate: Object.freeze({ field, in: Object.freeze(values) }),
    });
  }
  const scalar = readScalar(value[comparison], `${at}.${field}.${comparison}`);
  if (!scalar.ok) return scalar;
  switch (comparison) {
    case "eq":
      return Object.freeze({ ok: true as const, predicate: Object.freeze({ field, eq: scalar.value }) });
    case "ne":
      return Object.freeze({ ok: true as const, predicate: Object.freeze({ field, ne: scalar.value }) });
    case "lt":
      return Object.freeze({ ok: true as const, predicate: Object.freeze({ field, lt: scalar.value }) });
    case "lte":
      return Object.freeze({ ok: true as const, predicate: Object.freeze({ field, lte: scalar.value }) });
    case "gt":
      return Object.freeze({ ok: true as const, predicate: Object.freeze({ field, gt: scalar.value }) });
    default:
      return Object.freeze({ ok: true as const, predicate: Object.freeze({ field, gte: scalar.value }) });
  }
}

type StrideReading = Readonly<{ ok: true; stride: PlanForEachStride }> | PlanForEachRejection;

function readStride(value: unknown, at: string): StrideReading {
  if (!isRecord(value))
    return rejected("loop_where_invalid", `${at}:expected:${PLAN_FOR_EACH_STRIDE_SPELLINGS.join(",")}`);
  const unknownKey = Object.keys(value).find((key) => !PLAN_FOR_EACH_STRIDE_SPELLINGS.includes(key));
  if (unknownKey !== undefined)
    return rejected(
      FOR_EACH_WHERE_UNRECOGNISED,
      forEachWhereUnrecognised(`${at}:${unknownKey}`, PLAN_FOR_EACH_STRIDE_SPELLINGS),
    );
  const every = value.every;
  const offset = value.offset;
  // An offset at or past the stride claims no index at all, and a guard that can never match is indistinguishable from a
  // tile nobody thought about - so it is refused rather than silently dead.
  if (!isNonNegativeSafeInteger(every) || !isNonNegativeSafeInteger(offset) || every < 1 || offset >= every)
    return rejected("loop_where_invalid", `${at}:never_claims`);
  return Object.freeze({ ok: true as const, stride: Object.freeze({ every, offset }) });
}

type ScalarReading = Readonly<{ ok: true; value: PlanForEachScalar }> | PlanForEachRejection;

function readScalar(value: unknown, at: string): ScalarReading {
  if (typeof value === "string")
    return value.length >= 1 && value.length <= 128
      ? Object.freeze({ ok: true as const, value })
      : rejected("loop_value_invalid", at);
  if (typeof value === "boolean") return Object.freeze({ ok: true as const, value });
  // A non-integral number would reach the Mod as a `float` on a wire whose every argument is an integer, a string or a
  // flag, so it is refused where the caller can still see what it wrote.
  if (typeof value === "number" && Number.isSafeInteger(value)) return Object.freeze({ ok: true as const, value });
  return rejected("loop_value_invalid", at);
}

type EffectReading = Readonly<{ ok: true; effect: PlanForEachEffect | null }> | PlanForEachRejection;

/**
 * One row's chain, or `null` for a deliberate path.
 *
 * ONE SHAPE INTERNALLY: a single object is the chain of length one, so the step reader below has one caller shape and a
 * chain of four is the same grammar written four times rather than a second form beside it.
 */
function readEffect(value: unknown, actionIds: readonly string[] | null): EffectReading {
  // An absent `do` is not a decision (the Mod requires it), but a caller's own `undefined` reads as `null` here exactly as
  // it always has: this reader decides whether a declaration is a loop, not whether the caller wrote the word `do`.
  if (value === undefined || value === null) return Object.freeze({ ok: true as const, effect: null });
  if (Array.isArray(value)) return readStepChain(value, actionIds);
  const only = readStep(value, 0, actionIds);
  return only.ok ? Object.freeze({ ok: true as const, effect: Object.freeze([only.step]) as PlanForEachEffect }) : only;
}

/**
 * A chain, read in the order the caller wrote it, bounded by the model's own step count.
 *
 * AN EMPTY CHAIN AND AN OVERLONG ONE ARE TWO FACTS, and each names what to fix: `do: []` claims nothing about a row it
 * matched (`do: null` is the spelling for "leave this row alone"), and a chain past the bound answers its own length beside
 * the bound rather than being silently trimmed - a row that lost its fourth step would report the tile as worked.
 */
function readStepChain(value: readonly unknown[], actionIds: readonly string[] | null): EffectReading {
  if (value.length === 0) return rejected("loop_do_empty", "expected_at_least_one_step");
  if (value.length > MAX_FOR_EACH_STEPS)
    return rejected("loop_do_too_many_steps", `${String(value.length)}:${String(MAX_FOR_EACH_STEPS)}`);
  const steps: PlanForEachStep[] = [];
  for (const [index, entry] of value.entries()) {
    const step = readStep(entry, index, actionIds);
    if (!step.ok) return step;
    steps.push(step.step);
  }
  return Object.freeze({ ok: true as const, effect: Object.freeze(steps) });
}

type StepReading = Readonly<{ ok: true; step: PlanForEachStep }> | PlanForEachRejection;

/**
 * One step: `{ action, <argument>: <scalar> }`.
 *
 * EVERY REFUSAL NAMES THE STEP IT IS ABOUT, because a chain is read by position and "a step is wrong" is not actionable.
 * The detail says WHICH step and, when it is the step's shape that is wrong, what a step looks like - the word this used to
 * answer (`loop_do_invalid:not_an_object`) named nothing a caller could act on.
 */
function readStep(value: unknown, index: number, actionIds: readonly string[] | null): StepReading {
  const at = `step[${String(index)}]`;
  if (!isRecord(value)) return rejected("loop_do_step_unrecognised", `${at}:expected:{action,<argument>:scalar}`);
  const action = value.action;
  if (typeof action !== "string" || action.length === 0)
    return rejected("loop_do_step_unrecognised", `${at}:missing_action`);
  if (action !== PLAN_FOR_EACH_BY_KIND_ACTION && actionIds !== null && !actionIds.includes(action))
    return rejected("unknown_action", action);
  const arguments_: Record<string, PlanForEachScalar> = { action };
  let named = 0;
  for (const [name, entry] of Object.entries(value)) {
    if (name === "action") continue;
    // THE ROW'S IDENTITY IS THE MOD'S, minted per row from the live tile by the family the action declares. A caller that
    // wrote one has declared an id for a tile it has not seen: true only until the world differs, which is exactly the
    // lie `expectedTargetId` exists to catch. Refused by name rather than silently overridden.
    if (name === PLAN_FOR_EACH_ROW_IDENTITY_ARGUMENT) return rejected(PLAN_FOR_EACH_ROW_IDENTITY_REFUSAL, action);
    named += 1;
    if (named > MAX_FOR_EACH_EFFECT_ARGUMENTS)
      return rejected("loop_do_too_many_arguments", `${at}:${action}:${String(MAX_FOR_EACH_EFFECT_ARGUMENTS)}`);
    if (!isOpaqueId(name)) return rejected("loop_do_step_unrecognised", `${at}:${action}.${name}`);
    const scalar = readScalar(entry, `${at}.${action}.${name}`);
    if (!scalar.ok) return scalar;
    arguments_[name] = scalar.value;
  }
  return Object.freeze({ ok: true as const, step: Object.freeze(arguments_) as PlanForEachStep });
}

/**
 * The code that names a plan form the attached Mod cannot execute, derived from the form's own action id.
 *
 * One spelling: the answer that refuses the submission and the description the companion reads both take it from here, so
 * a caller cannot be told one word and be refused with another.
 */
export function planFormExecutionUnavailableReason(actionId: string): string {
  return `${actionId}_execution_unavailable`;
}

/**
 * The ordered rules of one pass: this loop's own predicate and effect first, then the alternates in order.
 *
 * FIRST MATCH WINS, and this is the ONE spelling of "what a pass tries": the writer that composes several `for_each` calls
 * over one source and the reader that expands the pass enumerate the rules through it, so they cannot disagree.
 */
export function forEachRules(loop: PlanForEachLoop): readonly PlanForEachRule[] {
  return Object.freeze([
    Object.freeze({ ...(loop.where === undefined ? {} : { where: loop.where }), do: loop.do }),
    ...(loop.then ?? []),
  ]);
}

/** This pass with one more rule at the end, in the order the caller wrote it. */
export function withForEachRule(loop: PlanForEachLoop, rule: PlanForEachRule): PlanForEachLoop {
  return Object.freeze({ ...loop, then: Object.freeze([...(loop.then ?? []), rule]) });
}

/**
 * Whether two loops read their rows from the same source - which is what makes them rules of ONE pass rather than two.
 *
 * Compared on the canonical source document both loops were read into, so two spellings of the same rectangle can never
 * be read as two passes over it.
 */
export function sameForEachSource(left: PlanForEachLoop, right: PlanForEachLoop): boolean {
  return JSON.stringify(left.source) === JSON.stringify(right.source);
}

/**
 * Whether a value read off the wire is a well-formed loop document.
 *
 * The wire tags the argument `type: "loop"` like every other runtime value; the tag is a WIRE fact and not part of the
 * loop's own grammar, so it is removed before the one reader runs and the caller's `builder.for_each({...})` argument and
 * the wire value are read by the same code.
 */
export function isForEachLoopDocument(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "loop") return false;
  const { type, ...document } = value;
  void type;
  return readForEachLoop(document, null).ok;
}
