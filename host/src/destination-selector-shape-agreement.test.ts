import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compilePlanScript, type PublishedPlanAction, planActionsFromRegistrations } from "./body-program-script.js";
import {
  type ActionRegistration,
  EXECUTION_REQUEST_ARGUMENT_RULES,
  newEnvelope,
  type Scope,
  type Snapshot,
  validateBodyProgramCandidateRequest,
  validateBridgeMessage,
  validateExecutionRequest,
} from "./protocol.js";

/**
 * ONE DESTINATION SELECTOR, ONE SHAPE, ONE READER - the Host half of the Mod's `DestinationSelectorShapeAgreementTests`
 * (commit 6d6fde60, same gate name, same property).
 *
 * <p>
 * THE DEFECT THIS EXISTS FOR. `find_destination` answers with a selector whose unused arm is on the wire as `null`
 * (`BridgeNavigationDestinationSelector` serializes both arms, `JsonIgnoreCondition.Never`), and the companion copies that
 * object straight back into the next call. The Host read the closed shape in three places with two different arities: the
 * result door demanded `kind` + `label` + `ref`, the argument doors demanded exactly the two keys of the arm that is
 * present. So the bytes a tool had just handed the model were refused by the Host's own reader -
 * `invalid_navigation_destination` on `execution_request`, `invalid_body_program_request` on the program door - and the
 * plan script minted a third spelling of its own (`canonicalDestinationSelector` accepted a 256-character label, a label
 * with a trailing space, an `nr1_` node handle and silently dropped an unknown key), which the Mod then refused at its
 * authoring door.
 * </p>
 * <p>
 * THE POPULATION IS DERIVED, NOT LISTED. The producer instances come from the wire's own declaration of the selector
 * (`$defs.navigationSelector`: each arm's `required` keys, and the run handle's grammar read out of the canonical-value
 * arm's `pattern`); the argument doors come from the action surface's own `argumentSchema` (`destination_selector`) and
 * from `EXECUTION_REQUEST_ARGUMENT_RULES`, so an action that grows a selector is driven without an edit here; the
 * structural half is a scan of the two source files for the functions and key lists that spell the shape.
 * </p>
 */

const hostRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCHEMA_PATH = resolve(hostRoot, "../protocol/bridge-v1.schema.json");
const SURFACE_PATH = resolve(
  hostRoot,
  "../integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
);
const PROTOCOL_PATH = resolve(hostRoot, "src/protocol.ts");
const SCRIPT_PATH = resolve(hostRoot, "src/body-program-script.ts");

const SCOPE: Scope = {
  integrationId: "stardew",
  saveId: "save_selector_gate",
  worldId: "world_selector_gate",
  playerId: "player_selector_gate",
  companionId: "companion_selector_gate",
};
const NOW = 1_700_000_000_000;

type Json = Record<string, unknown>;

function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}

/** The label a fixture may use: it is what `find_destination` matches and what the Mod's authoring door admits. */
const LABEL = "Mine";

/**
 * The run handle the wire admits, minted from the wire's OWN pattern rather than from a copy of it.
 *
 * A handle is `dr1_` plus 22 base64url characters whose last one is `AQgw` (`BridgeProtocol.IsNavigationHandle`), and the
 * canonical-value arm of a destination selector states that grammar as a JSON-schema `pattern`. Walking the schema for it
 * means the day the grammar moves, this value moves with it instead of quietly testing the old one.
 */
function wireRunHandle(): string {
  const patterns: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node as Json)) {
      if (key === "pattern" && typeof value === "string" && value.startsWith("^dr1_")) patterns.push(value);
      else walk(value);
    }
  };
  walk(readJson(SCHEMA_PATH));
  assert.ok(patterns.length > 0, "the wire declares the run handle's grammar as a pattern; none was found");
  for (const pattern of patterns) {
    const guard = new RegExp(pattern, "u");
    for (let length = 22; length <= 26; length += 1) {
      const candidate = `dr1_${"A".repeat(length)}`;
      if (guard.test(candidate)) return candidate;
    }
  }
  assert.fail(`the wire's run-handle patterns admit no candidate this gate can mint: ${patterns.join(" | ")}`);
}

const RUN_HANDLE = wireRunHandle();

/**
 * The selector shapes a PRODUCER can write, from the wire's own declaration of them.
 *
 * `kind` and the arm it names always carry a value. The arm it does not name is written exactly as the wire says that arm
 * is written for the result door (present, `null`), and the same selector is also offered with that arm absent, because
 * that is the spelling the argument wire uses and the two are one fact.
 */
type SelectorShape = Readonly<{
  /** What the shape is called in a failure message: the arm, and how the unused arm is spelled. */
  name: string;
  value: Json;
  /** Whether this shape NAMES a destination an actor can be sent to (a handleless ref describes one and cannot name it). */
  names: boolean;
}>;

function producerShapes(): readonly SelectorShape[] {
  const schema = readJson(SCHEMA_PATH);
  const defs = schema.$defs as Json;
  const selector = defs.navigationSelector as Json;
  const arms = selector.oneOf as readonly Json[];
  assert.ok(Array.isArray(arms) && arms.length === 2, "the wire declares exactly two arms for a result selector");
  const shapes: SelectorShape[] = [];
  for (const arm of arms) {
    const properties = arm.properties as Json;
    const kind = (properties.kind as Json).const as string;
    const required = arm.required as readonly string[];
    // The value each arm's own key carries: the arm's named key is the one that names the destination.
    const named: Json = kind === "label" ? { label: LABEL } : { ref: RUN_HANDLE };
    const unused: Json = kind === "label" ? { ref: null } : { label: null };
    // The arm's `required` list is the wire's own answer to "how many keys", so the two spellings are built from it.
    assert.ok(
      required.includes("kind") && required.includes(kind),
      `the ${kind} arm requires its own key: ${required.join(",")}`,
    );
    const present: Json = { kind, ...named, ...unused };
    shapes.push({ name: `${kind} (unused arm written out as null)`, value: present, names: true });
    const absent: Json = { kind, ...named };
    shapes.push({ name: `${kind} (unused arm absent)`, value: absent, names: true });
    if (kind === "ref") {
      // A result may describe a ref selector whose run handle the Mod has not published: the wire admits `ref: null`
      // (`$defs/navigationSelector`) and the Mod's own result door admits it. It therefore DESCRIBES a destination
      // without naming one an actor can be sent to.
      const handleless: Json = { kind, label: null, ref: null };
      const refSchema = properties.ref as Json;
      assert.ok(
        JSON.stringify(refSchema).includes('"null"'),
        "the wire admits a handleless ref in a result; the gate's handleless shape assumes it",
      );
      shapes.push({ name: "ref (handle not published, written as null)", value: handleless, names: false });
    }
  }
  return shapes;
}

const SHAPES = producerShapes();

/** Every action the Mod's own surface declares an argument of type `destination_selector` for, with that argument's name. */
type SelectorArgument = Readonly<{
  actionId: string;
  argument: string;
  /** The action's whole argument list, as the surface declares it, so a request is built without inventing fields. */
  arguments: readonly Readonly<{ name: string; type: string; enum?: readonly string[] }>[];
}>;

function publishedSurface(): readonly Json[] {
  const parsed = readJson(SURFACE_PATH);
  assert.equal(parsed.schema, "gamebuddy-action-descriptors/v1");
  const actions = parsed.actions as readonly Json[];
  assert.ok(
    actions.length > 0,
    "examined 0 actions: the published surface is empty, so this gate would agree with itself",
  );
  return actions;
}

const SELECTOR_ARGUMENTS: readonly SelectorArgument[] = publishedSurface().flatMap((action) => {
  const declared = (action.argumentSchema ?? {}) as Record<string, Json>;
  const arguments_ = Object.entries(declared).map(([name, schema]) => ({
    name,
    type: typeof schema.type === "string" ? schema.type : "string",
    ...(Array.isArray(schema.enum) ? { enum: schema.enum as readonly string[] } : {}),
  }));
  const selector = arguments_.filter((argument) => argument.type === "destination_selector");
  return selector.length === 0
    ? []
    : [{ actionId: action.actionId as string, argument: selector[0]!.name, arguments: arguments_ }];
});

/** A legal value for an argument the request needs beside the selector, read off the surface's own declaration. */
function argumentValue(declared: Readonly<{ name: string; type: string; enum?: readonly string[] }>): unknown {
  if (declared.enum !== undefined) return declared.enum[0];
  if (declared.type === "integer") return 10;
  if (declared.type === "boolean") return true;
  if (declared.type === "destination_selector") return null;
  return "selector_gate";
}

function snapshotFor(actionId: string): Snapshot {
  return {
    revision: 4,
    location: "Farm",
    tile: { x: 10, y: 11 },
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

const REGISTRATIONS: readonly ActionRegistration[] = publishedSurface().map((action) => {
  const declared = (action.argumentSchema ?? {}) as Record<string, Json>;
  const arguments_ = Object.entries(declared).map(([name, schema]) => ({
    name,
    type: typeof schema.type === "string" ? schema.type : "string",
    ...(Array.isArray(schema.enum) ? { enum: schema.enum as readonly string[] } : {}),
  }));
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

/**
 * Every door that ADMITS a selector, each driven for real and each answering with the fact it refused.
 *
 * The argument doors are derived from the published surface (an action declaring a `destination_selector` argument) and
 * from the Host's own declaration table, so the population follows the product rather than a list in this file.
 */
type Door = Readonly<{
  name: string;
  position: "argument" | "result";
  /** `null` when the door admits the value, otherwise the fact the door refused (and the field its rule is about). */
  verdict: (selector: Json, shape: SelectorShape) => Readonly<{ refusal: string; field: string }> | null;
}>;

function argumentDoors(): readonly Door[] {
  const doors: Door[] = [];
  for (const selector of SELECTOR_ARGUMENTS) {
    const args = Object.fromEntries(selector.arguments.map((declared) => [declared.name, argumentValue(declared)]));
    const declaredRows = EXECUTION_REQUEST_ARGUMENT_RULES[
      selector.actionId as keyof typeof EXECUTION_REQUEST_ARGUMENT_RULES
    ] as readonly { field: string }[];
    assert.ok(
      declaredRows !== undefined &&
        declaredRows.some((row) => row.field === `args.${selector.argument}` || row.field === selector.argument),
      `${selector.actionId} declares a ${selector.argument} of type destination_selector on the surface, so the Host's ` +
        `request declaration must carry a row for it`,
    );
    doors.push({
      name: `execution_request:${selector.actionId}`,
      position: "argument",
      verdict: (value) => {
        const answer = validateExecutionRequest(
          {
            requestId: "request_selector_gate",
            idempotencyKey: "idempotency_selector_gate",
            action: selector.actionId,
            args: { ...args, [selector.argument]: value },
            expectedRevision: 4,
            deadlineMs: NOW + 60_000,
          },
          snapshotFor(selector.actionId),
          NOW,
        );
        return answer === null ? null : { refusal: answer, field: selector.argument };
      },
    });
    doors.push({
      name: `submit_action_program:${selector.actionId}`,
      position: "argument",
      verdict: (value) => {
        const answer = validateBodyProgramCandidateRequest({
          programId: `bp1_${"a".repeat(22)}`,
          nodes: [
            {
              nodeId: "n01",
              actionId: selector.actionId,
              arguments: { [selector.argument]: { type: "destination_selector", destination: value } },
              dependsOn: [],
              bindings: {},
            },
          ],
        });
        return answer === null ? null : { refusal: answer, field: `${selector.argument}.destination` };
      },
    });
    doors.push({
      name: `plan_script:${selector.actionId}`,
      position: "argument",
      verdict: (value) => {
        const compiled = compilePlanScript(
          {
            script: `builder.${selector.actionId}({ ${selector.argument}: ${JSON.stringify(value)} });`,
          },
          { snapshot: snapshotFor(selector.actionId), actions: PLAN_ACTIONS },
        );
        return compiled.status === "refused" ? { refusal: compiled.reasonCode, field: selector.argument } : null;
      },
    });
  }
  return doors;
}

function resultDoor(): Door {
  return {
    name: "navigation_read_result",
    position: "result",
    verdict: (value) => {
      const answer = validateBridgeMessage(
        newEnvelope(
          "navigation_read_result",
          SCOPE,
          {
            status: "resolved",
            reason: "exact_current_locale",
            entries: null,
            nextCursor: null,
            candidates: null,
            destination: value,
            unlockState: "unknown",
          },
          "correlation_selector_gate",
          NOW,
        ),
        SCOPE,
        NOW,
      );
      return answer === null ? null : { refusal: answer, field: "payload.destination" };
    },
  };
}

test("a_producer_object_is_refused_by_its_own_selector:the companion copies what a tool just handed it", () => {
  const doors = [...argumentDoors(), resultDoor()];
  assert.ok(SELECTOR_ARGUMENTS.length > 0, "examined 0 selector arguments: the surface declares none");
  const examined: string[] = [];
  let agreements = 0;
  for (const shape of SHAPES) {
    for (const door of doors) {
      // A result describes a selector; an argument must NAME the destination the actor is sent to. The one shape that
      // describes without naming (`ref: null`) is checked in its own direction below, by the same doors.
      if (shape.names !== (door.position === "argument") && door.position === "argument" && !shape.names) {
        const refusal = door.verdict(shape.value, shape);
        assert.ok(
          refusal !== null,
          `${door.name} accepted a ${shape.name}, which names no destination to send an actor to`,
        );
        examined.push(`${door.name} refused ${shape.name}: ${refusal.refusal} (field ${refusal.field})`);
        continue;
      }
      examined.push(`${door.name} read ${shape.name}`);
      const refusal = door.verdict(shape.value, shape);
      assert.equal(
        refusal,
        null,
        `${door.name} refused ${JSON.stringify(shape.value)} - the ${shape.name} a producer writes - naming ` +
          `${refusal?.field}: ${refusal?.refusal}. A reader that refuses the object a tool has just handed the model is ` +
          `the defect this gate exists for; the shape is read once, in readDestinationSelector.`,
      );
      agreements += 1;
    }
  }
  // The result door must also admit the handleless ref a world map entry publishes, and the argument doors must refuse it:
  // one direction there, one here, so the pair is the whole rule.
  const handleless = SHAPES.find((shape) => !shape.names);
  assert.ok(handleless !== undefined, "the wire admits a handleless ref, so the gate must exercise one");
  assert.equal(
    resultDoor().verdict(handleless.value, handleless),
    null,
    "a navigation read result that describes a destination without a run handle is admitted by the Mod; the Host must read it",
  );
  console.log(
    `readers examined ${doors.length} (${doors.map((door) => door.name).join(", ")}) · shapes ${SHAPES.length} · agree ${agreements} · narrowed by hand 0`,
  );
});

test("a_producer_object_is_refused_by_its_own_selector:the plan compiler mints only what the readers admit", () => {
  // The twin direction is this gate's other half: a PRODUCER that mints a shape no reader admits is the same disagreement
  // seen from the other end, and it is the one the Mod answered first (`invalid_envelope` on a plan the companion wrote).
  const producerReads: string[] = [];
  for (const shape of SHAPES) {
    for (const selector of SELECTOR_ARGUMENTS) {
      const compiled = compilePlanScript(
        { script: `builder.${selector.actionId}({ ${selector.argument}: ${JSON.stringify(shape.value)} });` },
        { snapshot: snapshotFor(selector.actionId), actions: PLAN_ACTIONS },
      );
      if (shape.names) {
        if (compiled.status === "refused")
          throw new Error(
            `the plan compiler refused ${JSON.stringify(shape.value)} (${shape.name}) with ${compiled.reasonCode}; ` +
              `it is the shape the Mod's authoring door admits`,
          );
        const canonical = compiled.program.nodes[0]?.arguments[selector.argument];
        assert.deepEqual(
          validateBodyProgramCandidateRequest({
            programId: `bp1_${"a".repeat(22)}`,
            nodes: [
              {
                nodeId: "n01",
                actionId: selector.actionId,
                arguments: { [selector.argument]: canonical },
                dependsOn: [],
                bindings: {},
              },
            ],
          }),
          null,
          `the compiler minted ${JSON.stringify(canonical)} for ${shape.name}, and the program door refuses what its own compiler wrote`,
        );
        producerReads.push(`${selector.actionId} <- ${shape.name}`);
      } else {
        assert.equal(
          compiled.status,
          "refused",
          `the plan compiler minted a program from ${JSON.stringify(shape.value)} (${shape.name}), which names no run ` +
            `handle: the Mod's IsValidSelector refuses it, so the Host must refuse it while the author can still fix it`,
        );
      }
    }
  }
  // A label the Mod's authoring door refuses must not be minted here either: the bound and the text are one rule.
  for (const label of [" Mine", "Mine ", "M".repeat(200)]) {
    const compiled = compilePlanScript(
      {
        script: `builder.${SELECTOR_ARGUMENTS[0]!.actionId}({ ${SELECTOR_ARGUMENTS[0]!.argument}: ${JSON.stringify({ kind: "label", label })} });`,
      },
      { snapshot: snapshotFor(SELECTOR_ARGUMENTS[0]!.actionId), actions: PLAN_ACTIONS },
    );
    assert.equal(
      compiled.status,
      "refused",
      `the plan compiler minted a label the Mod refuses at its authoring door (${JSON.stringify(label)}): the label rule ` +
        `is readDestinationSelector's, not a second copy with its own bound`,
    );
  }
  // An unknown key is not part of the closed shape, and the compiler must not silently drop it.
  const withStrayKey = compilePlanScript(
    {
      script: `builder.${SELECTOR_ARGUMENTS[0]!.actionId}({ ${SELECTOR_ARGUMENTS[0]!.argument}: ${JSON.stringify({ kind: "label", label: LABEL, tile: "10,11" })} });`,
    },
    { snapshot: snapshotFor(SELECTOR_ARGUMENTS[0]!.actionId), actions: PLAN_ACTIONS },
  );
  assert.equal(
    withStrayKey.status,
    "refused",
    "the plan compiler accepted a selector with a key the closed shape does not carry, so the refusal the author sees is the Mod's, a round trip later",
  );
  console.log(
    `producers examined ${producerReads.length} (${producerReads.join(", ")}) · all admitted by the program door`,
  );
});

/**
 * The structural half: the shape's arity is stated ONCE.
 *
 * Two populations, both read out of the source rather than listed here: the functions whose name says they read a
 * destination selector, and the statements that spell its key list. A second reader is a second spelling of one fact, and
 * it is exactly how this defect arrived - so the gate names the file and line of anything that stops delegating. A
 * function named for a DIFFERENT selector (the tool category, a minecart ride) is not in this population: the name must
 * say which value it reads.
 */
type Site = Readonly<{ file: string; line: number; name: string; delegates: boolean; spellsKeys: boolean }>;

function selectorSites(): readonly Site[] {
  const sites: Site[] = [];
  for (const file of [PROTOCOL_PATH, SCRIPT_PATH]) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    const short = file.slice(hostRoot.length + 1).replace(/\\/g, "/");
    // One entry per NAME, because an overloaded function declares the same reader more than once.
    const byName = new Map<string, { line: number; body: string[] }>();
    for (let index = 0; index < lines.length; index += 1) {
      const declared = /^\s*(?:export )?function (\w*(?:Destination|Navigation)\w*Selector\w*)\s*(?:<[^>]*>)?\(/.exec(
        lines[index]!,
      );
      if (declared === null) continue;
      // The body of a top-level function in these files ends at the first `}` in column 0.
      const body: string[] = [];
      for (let cursor = index; cursor < lines.length; cursor += 1) {
        body.push(lines[cursor]!);
        if (cursor > index && /^\}/.test(lines[cursor]!)) break;
      }
      const existing = byName.get(declared[1]!);
      if (existing === undefined) byName.set(declared[1]!, { line: index + 1, body });
      else existing.body.push(...body);
    }
    for (const [name, found] of byName) {
      const text = found.body.join("\n");
      sites.push({
        file: short,
        line: found.line,
        name,
        delegates: /readDestinationSelector\s*\(/.test(text),
        spellsKeys: /"kind"/.test(text) && (/"label"/.test(text) || /"ref"/.test(text)),
      });
    }
  }
  return sites;
}

test("one_selector_one_reader:the arity of a destination selector is stated once", () => {
  const sites = selectorSites();
  assert.ok(sites.length > 0, "examined 0 selector sites: the scan found no reader or producer to hold to this rule");
  const reader = sites.filter((site) => site.name === "readDestinationSelector");
  assert.equal(
    reader.length,
    1,
    `the shape has one reader (protocol.ts readDestinationSelector); examined ${sites.length} sites: ` +
      sites.map((site) => `${site.file}:${site.line} ${site.name}`).join(", "),
  );
  assert.ok(
    reader[0]!.spellsKeys,
    "readDestinationSelector must be the place that spells the key list, or the rule lives elsewhere",
  );
  const delegating = sites.filter((site) => site !== reader[0] && site.delegates);
  const ownRule = sites.filter((site) => site !== reader[0] && (site.spellsKeys || !site.delegates));
  assert.deepEqual(
    ownRule.map((site) => `${site.file}:${site.line} ${site.name}`),
    [],
    "a site states the destination selector's shape without delegating to readDestinationSelector",
  );
  // Every door that admits a selector reads it through the one reader: the call sites are the population, and a door that
  // stops calling it has stopped asking the question.
  const protocolSource = readFileSync(PROTOCOL_PATH, "utf8");
  const callSites = protocolSource.match(/readDestinationSelector\s*\(/gu)?.length ?? 0;
  assert.ok(
    callSites >= 5,
    `examined ${callSites} call sites in protocol.ts (the reader plus its definition): the result door, the execution ` +
      `request, the body-program runtime value and the canonical admission all read a selector, plus any action the ` +
      `surface declares`,
  );
  console.log(
    `sites examined ${sites.length} · delegating ${delegating.length} · own-rule ${ownRule.length} · ` +
      `call sites ${callSites} (${sites.map((site) => `${site.file}:${site.line} ${site.name}`).join(", ") || "none"})`,
  );
});
