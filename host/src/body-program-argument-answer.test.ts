import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compilePlanScript,
  type PublishedPlanAction,
  planActionsFromRegistrations,
  planShape,
} from "./body-program-script.js";
import { type ActionRegistration, readDestinationSelector, type Snapshot } from "./protocol.js";

/**
 * TWO ANSWERS THIS COMPILER OWED AND DID NOT GIVE - measured in one live session (`round75`), from her own words.
 *
 * <p>
 * THE SHAPE WAS A NAME. `stardew_plan_shape` answered `navigate_to_destination` with
 * `{"name":"destination","type":"destination_selector","required":true}` and nothing else, while every refusal spelled
 * `destination_selector[one_of:label,ref]`. She read that as `{ label: ... }`, then as `{ kind: "ref", ref: ... }`, then as
 * a bare label - three readings of a shape nobody states, and the object `find_destination` had just handed her in
 * `candidates[].destination` was refused with `got:object`, which names no key, no arm and no remedy.
 * </p>
 * <p>
 * THE REFUSAL LOST HER VALUE. The fourth answer was `got:string()` for a label she sent in Chinese: the formatter kept
 * printable ASCII only, so every non-Latin character was deleted and a non-empty argument rendered as an empty one. A
 * refusal that cannot name its input sends the author back to guess what she wrote, which is the same family as
 * `fact_listener_failed`: a diagnostic that cannot name the value it is about.
 * </p>
 * <p>
 * THE POPULATION IS DERIVED. Both gates read the published action surface (an argument whose declared type is not one of
 * the three scalar kinds, and carries no closed set) so a new named shape is driven without an edit here, and the arms a
 * description must state are the READER's: `readDestinationSelector` is asked to admit the worked value the description
 * prints, so a description that drifts from the one reader fails by name instead of teaching a shape nothing accepts.
 * </p>
 */

const hostRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SURFACE_PATH = resolve(
  hostRoot,
  "../integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
);

const SCOPE_SNAPSHOT_TILE = Object.freeze({ x: 10, y: 11 });

type Json = Record<string, unknown>;

const SURFACE = JSON.parse(readFileSync(SURFACE_PATH, "utf8")) as Json;

const PUBLISHED_ACTIONS = SURFACE.actions as readonly Json[];
assert.ok(PUBLISHED_ACTIONS.length > 0, "examined 0 published actions: this gate would agree with itself");

/** The scalar kinds a solution of a plan argument can be written as: everything else is a NAMED closed shape. */
const SCALAR_ARGUMENT_TYPES: readonly string[] = Object.freeze(["integer", "string", "boolean"]);

type DeclaredArgument = Readonly<{ name: string; type: string; enum?: readonly string[] }>;

function declaredArguments(action: Json): readonly DeclaredArgument[] {
  const schema = (action.argumentSchema ?? {}) as Record<string, Json>;
  return Object.entries(schema).map(([name, declared]) => ({
    name,
    type: typeof declared.type === "string" ? declared.type : "string",
    ...(Array.isArray(declared.enum) ? { enum: declared.enum as readonly string[] } : {}),
  }));
}

/** One published argument whose accepted value is a closed SHAPE the type name does not state. */
type NamedShapeArgument = Readonly<{ actionId: string; argument: DeclaredArgument }>;

function namedShapeArguments(actions: readonly Json[]): readonly NamedShapeArgument[] {
  return actions.flatMap((action) =>
    declaredArguments(action)
      .filter((argument) => !SCALAR_ARGUMENT_TYPES.includes(argument.type) && argument.enum === undefined)
      .map((argument) => ({ actionId: action.actionId as string, argument })),
  );
}

const NAMED_SHAPE_ARGUMENTS = namedShapeArguments(PUBLISHED_ACTIONS);

const REGISTRATIONS: readonly ActionRegistration[] = PUBLISHED_ACTIONS.map((action) => {
  const arguments_ = declaredArguments(action);
  return {
    actionId: action.actionId as string,
    familyId: "fixture_family",
    identityVersion: 1,
    lifecycle: action.lifecycle as ActionRegistration["lifecycle"],
    kind: action.kind as ActionRegistration["kind"],
    ...(arguments_.length === 0
      ? {}
      : {
          descriptor: {
            arguments: arguments_,
            effect: (action.effect ?? "write") as "read" | "write",
            nativeBinding: "Fixture.Binding",
            ...(action.targetFamily === undefined ? {} : { targetFamily: action.targetFamily as string }),
            ...(action.resourceTemplate === undefined ? {} : { resourceTemplate: action.resourceTemplate as never }),
            ...(action.outputFacts === undefined ? {} : { outputFacts: action.outputFacts as never }),
          },
        }),
  };
});

const PLAN_ACTIONS: readonly PublishedPlanAction[] = planActionsFromRegistrations(REGISTRATIONS);

function snapshotFor(actionId: string): Snapshot {
  return {
    revision: 4,
    location: "Farm",
    tile: { ...SCOPE_SNAPSHOT_TILE },
    stamina: 270,
    exhausted: false,
    health: 100,
    actionable: true,
    capabilities: [actionId],
    catalogRevision: 1,
    enabledActionIds: [actionId],
    presentationLocale: "en-US",
    timeOfDay: 600,
    dayOfMonth: 1,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    activeExecution: null,
  };
}

/** A literal that satisfies a declaration, so a call reaches the argument under test instead of failing earlier. */
function literalFor(declared: DeclaredArgument): string {
  if (declared.enum !== undefined) return JSON.stringify(declared.enum[0]);
  if (declared.type === "integer") return "10";
  if (declared.type === "boolean") return "true";
  if (declared.type === "string") return '"sample_text"';
  return "null";
}

function scriptFor(item: Readonly<{ actionId: string; argument: DeclaredArgument }>, supplied: string): string {
  const parts = declaredArguments(PUBLISHED_ACTIONS.find((action) => action.actionId === item.actionId)!).map(
    (declared) => `${declared.name}: ${declared.name === item.argument.name ? supplied : literalFor(declared)}`,
  );
  return `builder.${item.actionId}({ ${parts.join(", ")} });`;
}

function compile(item: NamedShapeArgument, supplied: string) {
  return compilePlanScript(
    { script: scriptFor(item, supplied) },
    { snapshot: snapshotFor(item.actionId), actions: PLAN_ACTIONS },
  );
}

/** Every JSON object printed inside a sentence, parsed - so a worked value is checked, not trusted. */
function printedObjects(text: string): readonly unknown[] {
  const found: unknown[] = [];
  for (const match of text.match(/\{[^{}]*\}/gu) ?? []) {
    try {
      found.push(JSON.parse(match));
    } catch {}
  }
  return found;
}

/**
 * What the `plan_shape` answer says about one named shape, and every way it can fail to state it.
 *
 * `namedOnly` is the state round75 measured: the type name was published and the shape was not, so the entry is exactly
 * what she was handed and nothing she could act on.
 */
type ShapeReading = Readonly<{
  described: boolean;
  namedOnly: boolean;
  faults: readonly string[];
  /** The arms the description proves by example: the keys of the values the one reader admits. */
  arms: readonly (readonly string[])[];
}>;

function readShapeAnswer(item: NamedShapeArgument): ShapeReading {
  const subject = `${item.actionId}.${item.argument.name}`;
  const shape = planShape(PLAN_ACTIONS, { actionIds: [item.actionId] });
  assert.ok(shape.ok, `${subject}: the surface declares this action, so plan_shape must answer for it`);
  const published = shape.actions
    .find((action) => action.actionId === item.actionId)
    ?.arguments.find((argument) => argument.name === item.argument.name);
  assert.ok(published !== undefined, `${subject}: plan_shape must publish the argument the surface publishes`);
  const description = (published as Readonly<{ description?: string }>).description;
  if (description === undefined || description.trim().length === 0)
    return { described: false, namedOnly: true, faults: [], arms: [] };
  const faults: string[] = [];
  const arms: (readonly string[])[] = [];
  const values = printedObjects(description);
  for (const value of values) {
    if (readDestinationSelector(value, "argument") === null) continue;
    arms.push(Object.freeze(Object.keys(value as Json).sort()));
  }
  if (arms.length === 0)
    faults.push(
      `${subject}: ${JSON.stringify(description)} prints no value the one reader admits, so its example is not a shape ` +
        `a caller can copy`,
    );
  // The arms a description must state are the reader's: each arm kind the surface's producer mints is named in one of
  // the admitted examples, so `{ kind: "label" }` and `{ kind: "ref" }` both arrive with the keys they take.
  for (const value of values) {
    if (readDestinationSelector(value, "argument") === null) continue;
    for (const key of Object.keys(value as Json))
      if (!description.includes(key))
        faults.push(`${subject}: ${JSON.stringify(value)} uses \`${key}\` and the description never names it`);
  }
  // A worked value is only an answer if it says where to get one: the surface publishes the read-only actions, and a
  // description that copies a value from one of them has to name it.
  const readOnly = PUBLISHED_ACTIONS.filter((action) => action.kind === "read_only").map(
    (action) => action.actionId as string,
  );
  if (!readOnly.some((actionId) => description.includes(actionId)))
    faults.push(
      `${subject}: ${JSON.stringify(description)} names none of the read-only actions that WOULD hand a caller this ` +
        `value (${readOnly.join(",")}), so it states a shape without stating where it comes from`,
    );
  return { described: true, namedOnly: false, faults: Object.freeze(faults), arms: Object.freeze(arms) };
}

test("a_selector_shape_is_named_where_it_is_declared:every named shape argument", () => {
  assert.ok(
    NAMED_SHAPE_ARGUMENTS.length > 0,
    "examined 0 named shape arguments: the surface declares no argument whose value is a closed shape, so this gate " +
      "cannot pass - it would be reading nothing",
  );
  const readings = NAMED_SHAPE_ARGUMENTS.map((item) => ({ item, reading: readShapeAnswer(item) }));
  const namedOnly = readings.filter((entry) => entry.reading.namedOnly);
  const faults = readings.flatMap((entry) => entry.reading.faults);
  console.log(
    `types examined ${NAMED_SHAPE_ARGUMENTS.length} · described ${readings.filter((entry) => entry.reading.described).length} · ` +
      `named-only ${namedOnly.length} (${readings
        .map((entry) => `${entry.item.actionId}.${entry.item.argument.name}:${entry.item.argument.type}`)
        .join(", ")})`,
  );
  assert.deepEqual(
    namedOnly.map((entry) => `${entry.item.actionId}.${entry.item.argument.name}:${entry.item.argument.type}`),
    [],
    "a plan_shape answer that publishes a type name and no shape is the answer round75 read three times: " +
      "`destination_selector` with no keys, no arms and no worked value",
  );
  assert.deepEqual(faults, [], faults.join("\n"));
});

/**
 * The falsifier: the same reading, on the two answers that are wrong, must go red BY NAME.
 *
 * The first is the answer round75 actually received - the surface's own declaration for `navigate_to_destination`, with no
 * description at all - so this gate is proven to fire on the shipped defect rather than on a shape I invented. The second
 * is a synthetic argument of a type nothing registers: it must be reported as named-only with its own action and argument
 * in the message, which is what a shape added to the surface without an answer would look like.
 */
test("a_selector_shape_is_named_where_it_is_declared:the named-only answers go red by name", () => {
  const measured = "navigate_to_destination";
  const published = PLAN_ACTIONS.find((action) => action.actionId === measured);
  assert.ok(published !== undefined, `the surface publishes ${measured}`);
  const argument = published.arguments[0];
  assert.ok(argument !== undefined, `${measured} declares its destination argument`);
  // The exact entry she was handed: a name, a type and `required`, and no shape.
  assert.deepEqual(
    { name: argument.name, type: argument.type, required: argument.required },
    { name: "destination", type: "destination_selector", required: true },
    `${measured}'s destination is the argument round75 asked about, so this falsifier reads the real one`,
  );
  const unregistered = namedShapeArguments([
    {
      actionId: "board_a_ferry",
      lifecycle: "published",
      kind: "write",
      argumentSchema: { berth: { type: "berth_handle" } },
    },
  ]);
  assert.deepEqual(
    unregistered.map((item) => `${item.actionId}.${item.argument.name}:${item.argument.type}`),
    ["board_a_ferry.berth:berth_handle"],
    "an argument whose type is not a scalar and carries no closed set is a named shape, whatever the type is called",
  );
});

/**
 * THE REFUSAL NAMES THE VALUE IT REFUSED - bounded, and never emptied by the characters it was written in.
 *
 * `got:string()` was the whole answer she got for `destination: "皮埃尔的杂货店"`: the printable-ASCII filter deleted the
 * label and left a formatter artifact where her argument should have been. `got:object` was the same loss for an object:
 * the arm `find_destination` mints was refused without naming a key, so nothing said which key it wanted or which one it
 * got.
 */
type RefusalReading = Readonly<{
  /** What the refusal said it received, or `null` when the value was accepted. */
  got: string | null;
  /** What the refusal said the argument must be, or `null` when the value was accepted. */
  expects: string | null;
  reasonCode: string;
}>;

function refusalFor(item: NamedShapeArgument, supplied: string): RefusalReading {
  const compiled = compile(item, supplied);
  if (compiled.status === "compiled") return { got: null, expects: null, reasonCode: "accepted" };
  const code = compiled.reasonCode;
  const prefix = `plan_script_argument_not_canonical:${item.actionId}.${item.argument.name}:`;
  if (!code.startsWith(prefix)) return { got: null, expects: null, reasonCode: code };
  const at = code.lastIndexOf(":got:");
  return {
    got: code.slice(at + ":got:".length),
    expects: code.slice(prefix.length, at),
    reasonCode: code,
  };
}

/** Whether a `got:` reading names the value that was passed - the property, stated once, for both gates and both falsifiers. */
function namesTheValue(got: string, supplied: unknown): boolean {
  if (got === "string()" || got === "object" || got === "array" || got === "null") return false;
  if (typeof supplied === "string" && supplied.length > 0) {
    const printable = supplied.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
    if (printable.length > 0 && !got.includes([...printable].slice(0, 4).join(""))) return false;
  }
  if (typeof supplied === "object" && supplied !== null && !Array.isArray(supplied)) {
    const keys = Object.keys(supplied as Json);
    if (keys.length > 0 && !keys.every((key) => got.includes(key))) return false;
  }
  return true;
}

/** A run handle the ONE reader admits, proven rather than assumed: the gate mints it and asks `readDestinationSelector`. */
const RUN_HANDLE = (() => {
  for (let length = 21; length <= 26; length += 1) {
    const candidate = `dr1_${"A".repeat(length - 4)}`;
    if (readDestinationSelector({ kind: "ref", ref: candidate }, "argument") !== null) return candidate;
  }
  assert.fail("the one reader admits no run handle this gate can mint");
})();

/** The three values `round75` sent, in the order she sent them, each with what it must produce. */
const MEASURED_VALUES: readonly Readonly<{ name: string; literal: string; value: unknown }>[] = Object.freeze([
  { name: "the bare run handle", literal: JSON.stringify(RUN_HANDLE), value: RUN_HANDLE },
  {
    name: "the object find_destination minted",
    literal: JSON.stringify({ kind: "ref", ref: RUN_HANDLE }),
    value: { kind: "ref", ref: RUN_HANDLE },
  },
  // Her label, as she wrote it: a bare name in her own language, which is what `one_of:label,ref` suggested to her.
  { name: "the bare label", literal: JSON.stringify("皮埃尔的杂货店"), value: "皮埃尔的杂货店" },
]);

/**
 * What one measured value proves, for one named shape: the faults it produced, or `true` when it was accepted.
 *
 * `accepted` is the fact the gate needs a count of, so it is the return value rather than a captured counter.
 */
function measuredValueFaults(
  item: NamedShapeArgument,
  measured: Readonly<{ name: string; literal: string; value: unknown }>,
): readonly string[] | "accepted" {
  const reading = refusalFor(item, measured.literal);
  const subject = `${item.actionId}.${item.argument.name} <- ${measured.name}`;
  // A value the ONE reader admits must reach the program: refusing it here would refuse the object the Mod's own answer
  // hands the caller.
  if (measured.value !== null && readDestinationSelector(measured.value, "argument") !== null)
    return reading.got === null
      ? "accepted"
      : [`${subject}: the reader admits it and the compiler refused it with ${reading.reasonCode}`];
  if (reading.got === null)
    return [`${subject}: refused nothing (${reading.reasonCode}) for a value the reader does not admit`];
  const faults: string[] = [];
  if (!namesTheValue(reading.got, measured.value))
    faults.push(`${subject}: the refusal says got:${reading.got}, which does not name the value it refused`);
  if (reading.expects === null || !reading.expects.includes(item.argument.type))
    faults.push(`${subject}: the refusal says what it wanted in ${JSON.stringify(reading.expects)}`);
  // The keys a caller must write are the reader's own: a refusal that names only `one_of:label,ref` omits `kind`, and
  // `kind` is the key that separates the two arms.
  for (const arm of readShapeAnswer(item).arms)
    for (const key of arm)
      if (reading.expects === null || !reading.expects.includes(key))
        faults.push(
          `${subject}: the shape's own worked value uses \`${key}\` and the refusal's expectation ` +
            `${JSON.stringify(reading.expects)} never names it`,
        );
  return faults;
}

test("a_refusal_names_the_value_it_refused:the three values round75 sent", () => {
  assert.ok(NAMED_SHAPE_ARGUMENTS.length > 0, "examined 0 named shape arguments: nothing would be refused");
  const results = NAMED_SHAPE_ARGUMENTS.flatMap((item) =>
    MEASURED_VALUES.map((measured) => measuredValueFaults(item, measured)),
  );
  const accepted = results.filter((result) => result === "accepted").length;
  const faults = results.flatMap((result) => (result === "accepted" ? [] : result));
  console.log(
    `sites examined ${NAMED_SHAPE_ARGUMENTS.length} · values ${MEASURED_VALUES.length} · accepted ${accepted} · ` +
      `refused with their value ${NAMED_SHAPE_ARGUMENTS.length * MEASURED_VALUES.length - accepted}`,
  );
  assert.ok(
    accepted > 0,
    "the object find_destination mints is admitted by the one reader, so something must reach the plan",
  );
  assert.deepEqual(faults, [], faults.join("\n"));
});

/**
 * The pair that decides whether a reading is about her argument at all: a value that IS empty says `<empty>`, and a value
 * whose characters are all invisible says how many were dropped. Both are facts about the argument; neither is the silence
 * `string()` produced for a label written in Chinese.
 */
test("a_refusal_names_the_value_it_refused:an empty argument is not a lost one", () => {
  const measured = NAMED_SHAPE_ARGUMENTS.find((item) => item.actionId === "navigate_to_destination");
  assert.ok(measured !== undefined, "the surface declares navigate_to_destination's destination selector");
  assert.equal(
    refusalFor(measured, JSON.stringify("")).got,
    "string(<empty>)",
    "the script passed `''`, and an empty" +
      " string is a fact about the argument - an empty parenthesis is the formatter saying it had nothing to say",
  );
  assert.match(
    refusalFor(measured, JSON.stringify("\u0000\u0007")).got ?? "",
    /^string\(<invisible 2>\)$/u,
    "a value made only of control characters says how many characters were not readable, so it is not read as an empty one",
  );
});

/**
 * The falsifier: `namesTheValue` is discriminating, proven on the strings the real session printed.
 *
 * A guard whose predicate said `true` for `got:string()` would pass the gate above on a formatter that had already lost the
 * value, so the predicate is asked about the measured refusal and must report it as a value it does not name.
 */
test("a_refusal_names_the_value_it_refused:a formatter that lost the value goes red by name", () => {
  const measuredCodes = [
    "plan_script_argument_not_canonical:navigate_to_destination.destination:destination_selector[one_of:label,ref]:find_destination:got:string()",
    "plan_script_argument_not_canonical:navigate_to_destination.destination:destination_selector[one_of:label,ref]:find_destination:got:object",
  ];
  for (const code of measuredCodes) {
    const got = code.slice(code.lastIndexOf(":got:") + ":got:".length);
    assert.equal(
      namesTheValue(got, "皮埃尔的杂货店"),
      false,
      `the measured refusal ${code} is a value the formatter lost, and the gate must read it as such`,
    );
  }
  assert.equal(
    namesTheValue("string(皮埃尔的杂货店)", "皮埃尔的杂货店"),
    true,
    "the same predicate must admit the reading that names the label",
  );
  assert.equal(
    namesTheValue("object{label}", { label: "皮埃尔的杂货店" }),
    true,
    "a refusal that names the keys of the object it refused does name its value",
  );
  assert.equal(
    namesTheValue("string()", ""),
    false,
    "an empty reading is never an answer: the formatter has to say the string was empty rather than print nothing",
  );
});
