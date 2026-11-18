import assert from "node:assert/strict";
import test from "node:test";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { GameConnection } from "./game-connection.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";
import { createWorldBookTools, validateWorldBook, worldBookMetadata } from "./worldbook.js";

/**
 * A PARAMETER THE DESCRIPTION DOES NOT NAME IS A PARAMETER THE MODEL CANNOT DISCOVER.
 *
 * <p>
 * The defect this file exists for: `stardew_observe` gained `select`, `tiles` and `limit` (`e1002a2c`), and the only
 * other place the tool is described for a model - `stardew_plan_work`'s description - still told it that "stardew_observe
 * shows only a square window", so the one route that could answer a 3x20 strip was denied in prose while it existed in
 * the schema. A model cannot call what it cannot see, and it will not call what a description tells it cannot help.
 * Nothing in this repository compared a tool's declared parameters against the description the model is handed, so the
 * schema and the prose could disagree for as long as nobody read both.
 * </p>
 *
 * <p>
 * THE POPULATION IS EACH TOOL'S OWN SCHEMA, never a list of parameter names written here: the names come from the
 * `Type.Object({...})` the `defineTool` call itself carries (`parameters.properties`), and the description is that same
 * definition's `description`. A parameter added to a schema without a sentence is therefore red without anyone editing
 * this frame, which is the whole difference between a gate and a test. The key it reports is
 * `tool_parameter_not_described:<tool>:<parameter>`.
 * </p>
 *
 * <p>
 * WHAT IT EXAMINES, AND WHAT IT DOES NOT. The population is the tools the Game surface mounts that are declared by this
 * Host with a static schema: the adapter's observation and knowledge sets, built by the same
 * `STARDEW_GAME_INTEGRATION_ADAPTER.createToolSet` the composition calls (`runtime-core.internal.ts`), plus the world
 * book's own tools (`worldbook.ts`). The connection publishes no catalog, so no descriptor-derived per-action tool
 * exists in it - those schemas are built from the Mod's published descriptors (`buildCandidateToolSchema`), not declared
 * here, and they carry the Host's transport identity envelope. The program tools (`stardew_plan_work`,
 * `stardew_action_program_status`, `stardew_action_program_shape` - composed by the materializer's module-private
 * `createBodyProgramTools`) and `companion_status` are outside this population for the same reason: this frame reads
 * what it can build without a live journal. The evidence line prints the counts it examined, so the gap is stated rather
 * than implied.
 * </p>
 *
 * <p>
 * A STATED EXCEPTION IS DEBT WITH AN EXPIRY. Six parameters below are genuinely undescribed today. They are named here
 * rather than silently fixed with the tool this gate was written for, and each entry goes red the moment it stops being
 * needed - the exemption must still excuse a real omission, or the gate says which entry to delete. That is what keeps the
 * register from becoming a second, hand-maintained copy of the property.
 * </p>
 */
const STATED_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({
  "stardew_look_up:subject":
    "the description lists the subjects and what each answers (`Subjects: my_work (...)`, `crops (...)`) but never names the key that carries one, so the call shape has to be guessed",
  "stardew_look_up:query":
    "the description never says a subject is asked with words of its own, so a caller does not know `query` exists",
  "stardew_search_interactions:query":
    "the whole description is one sentence about what the search covers and says nothing about the words it takes",
  "stardew_inspect_world_map:nodeRef":
    "the navigation read is described in one sentence (`without changing the game`) and neither argument is named",
  "stardew_inspect_world_map:cursor":
    "the navigation read is described in one sentence (`without changing the game`) and neither argument is named",
  "companion_worldbook_query:entryId":
    "the description says 'by catalog ID' and never the key that carries one, so `entryId` is not discoverable",
});

type UndescribedParameter = Readonly<{ tool: string; parameter: string }>;

type ParameterCoverage = Readonly<{
  /** Every tool the population actually contained, in the order it was assembled. */
  examined: readonly string[];
  /** Every parameter those tools declare between them. */
  parameters: number;
  /** Parameters no description names, EXCEPT the stated exceptions above. */
  undescribed: readonly UndescribedParameter[];
  /** Parameters the descriptions do not name, all of them - the number the exceptions are drawn from. */
  omitted: readonly UndescribedParameter[];
  /** Stated exceptions that no longer excuse an omission, so the register has outlived its entry. */
  expiredExceptions: readonly string[];
}>;

/**
 * The declared parameter names a tool's own schema carries.
 *
 * The schema is the authority: `properties` is what the provider is told the call accepts, so it is what a description
 * has to answer for. A tool that declares no parameter (`Type.Object({})`) contributes nothing and cannot be excused
 * into the population.
 */
function declaredParameters(tool: ToolDefinition): readonly string[] {
  const schema = tool.parameters as { readonly properties?: Readonly<Record<string, unknown>> } | undefined;
  return Object.keys(schema?.properties ?? {});
}

const parameterKey = (entry: UndescribedParameter): string => `${entry.tool}:${entry.parameter}`;

/**
 * One population's coverage: which declared parameters its descriptions never name, and which exceptions have expired.
 *
 * Kept as a function over `(tools, exceptions)` rather than over the real tool set so the property can be driven with a
 * tool whose schema or description was changed by hand - the falsifier this gate is worth nothing without.
 */
function parameterCoverage(
  tools: readonly ToolDefinition[],
  exceptions: Readonly<Record<string, string>>,
): ParameterCoverage {
  const omitted: UndescribedParameter[] = [];
  let parameters = 0;
  for (const tool of tools)
    for (const parameter of declaredParameters(tool)) {
      parameters += 1;
      if (tool.description.includes(parameter)) continue;
      omitted.push({ tool: tool.name, parameter });
    }
  const named = new Set(omitted.map(parameterKey));
  return Object.freeze({
    examined: Object.freeze(tools.map((tool) => tool.name)),
    parameters,
    undescribed: Object.freeze(omitted.filter((entry) => !Object.hasOwn(exceptions, parameterKey(entry)))),
    omitted: Object.freeze(omitted),
    expiredExceptions: Object.freeze(
      Object.keys(exceptions)
        .filter((entry) => !named.has(entry))
        .sort(),
    ),
  });
}

/** The wire the gate is stated over: `tool_parameter_not_described:<tool>:<parameter>`. */
const offenceCode = (entry: UndescribedParameter): string =>
  `tool_parameter_not_described:${entry.tool}:${entry.parameter}`;

/**
 * A connection that is live enough to materialize tools and publishes no catalog.
 *
 * `createToolSet` refuses a connection that is not connected and builds action tools only from published registrations,
 * so this is the shape that answers "which tools exist by this Host's own declaration" with nothing from the Mod.
 */
function connectionWithoutCatalog(): GameConnection {
  return {
    scope: {
      integrationId: "stardew",
      saveId: "save_tool_parameter_gate",
      worldId: "world_tool_parameter_gate",
      playerId: "player_tool_parameter_gate",
      companionId: "companion_tool_parameter_gate",
    },
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    // `requireLiveConnection` reads liveness from this gate alone (`stardew-integration-launcher-body-program.internal.ts`),
    // so a stub without it is refused before any tool is materialized.
    executionGate: { executable: true },
    state: {
      connected: true,
      sessionId: "session_tool_parameter_gate",
      capabilities: [],
      catalogRevision: 1,
      enabledActionIds: [],
      snapshot: null,
      latestReceipt: null,
      latestReasonCode: null,
      catalogRegistrations: [],
    },
    async execute() {
      throw new Error("tool_parameter_gate_never_executes");
    },
    async cancel() {
      throw new Error("tool_parameter_gate_never_cancels");
    },
  } as unknown as GameConnection;
}

/** The empty reviewed world book: its tools are mounted on this surface whatever the book holds. */
function emptyWorldBookTools(): readonly ToolDefinition[] {
  const book = validateWorldBook({
    schemaVersion: 1,
    worldBookId: "worldbook_tool_parameter_gate",
    revision: 1,
    alwaysOnPremise: "",
    entries: [],
  });
  return createWorldBookTools(Object.freeze({ metadata: worldBookMetadata(book), book }), undefined, { char: null });
}

/** Every tool this gate examines, assembled by the factories the composition itself calls. */
function gameSurfaceDeclaredTools(): readonly ToolDefinition[] {
  const set = STARDEW_GAME_INTEGRATION_ADAPTER.createToolSet({
    connection: connectionWithoutCatalog(),
    policy: STARDEW_GAME_INTEGRATION_ADAPTER.defaultPolicy,
    dispatchAdmissionFactory: () => {
      throw new Error("tool_parameter_gate_never_dispatches");
    },
  });
  // The boundary is asserted rather than assumed: with nothing published the adapter has no action tool, so every
  // tool below is one this Host declares. A per-action tool arriving here would mean its schema is no longer derived
  // from the Mod's descriptor, and the sentence above about what this gate covers would be wrong.
  assert.deepEqual(
    [...set.actions],
    [],
    "the connection publishes no catalog, so the descriptor-derived action tools are not part of this population",
  );
  return [...set.observation, ...set.knowledge, ...emptyWorldBookTools()];
}

test("every parameter a mounted tool declares is named by that tool's own description", () => {
  const coverage = parameterCoverage(gameSurfaceDeclaredTools(), STATED_EXCEPTIONS);
  const excepted = coverage.omitted.length - coverage.undescribed.length;
  const evidence = `tools examined ${String(coverage.examined.length)} · parameters ${String(
    coverage.parameters,
  )} · undescribed ${String(coverage.undescribed.length)} · stated exceptions ${String(excepted)}`;

  // Zero population is blocked, never green: a gate that examined nothing agrees with itself.
  assert.ok(coverage.examined.length > 0, `blocked: no tool was materialized, so nothing was checked (${evidence})`);
  assert.ok(coverage.parameters > 0, `blocked: the tools declare no parameter, so nothing was checked (${evidence})`);
  console.error(evidence);

  assert.deepEqual(
    coverage.undescribed.map(offenceCode),
    [],
    `a parameter the description never names is a parameter the model cannot discover (${evidence})`,
  );
  assert.deepEqual(
    coverage.expiredExceptions,
    [],
    `these stated exceptions no longer excuse an omission - the parameter is now described or gone, so delete the entry (${evidence})`,
  );
});

test("a description that stops naming one of its parameters is red by name", () => {
  // The falsifier for the property, on the REAL tool: the description is the one this repository ships, with the
  // parameter's name taken out of it. If the gate read anything other than the definition, this would stay green.
  const shipObserve = gameSurfaceDeclaredTools().find((tool) => tool.name === "stardew_observe");
  assert.ok(shipObserve !== undefined, "blocked: stardew_observe is not in the population this gate examines");
  // Both spellings of the name are struck out - the parameter and the prose that reuses it - so the removal is real
  // rather than a substring surviving inside another word.
  const forgetfulDescription = shipObserve.description
    .replaceAll("`select`", "`filter`")
    .replaceAll("the selection", "the filter");
  assert.ok(
    shipObserve.description.includes("select") && !forgetfulDescription.includes("select"),
    "blocked: the shipped description does not name `select` in a form this case can remove",
  );
  const forgetful: ToolDefinition = Object.freeze({ ...shipObserve, description: forgetfulDescription });

  const coverage = parameterCoverage([forgetful], STATED_EXCEPTIONS);
  assert.deepEqual(coverage.undescribed.map(offenceCode), ["tool_parameter_not_described:stardew_observe:select"]);
});

test("a parameter added to a tool's schema without a description is red by name", () => {
  // The other half, and the one a hand-written list of names cannot satisfy: the schema gains a parameter, no
  // description changes anywhere, and the gate must name it.
  const shipObserve = gameSurfaceDeclaredTools().find((tool) => tool.name === "stardew_observe");
  assert.ok(shipObserve !== undefined, "blocked: stardew_observe is not in the population this gate examines");
  const schema = shipObserve.parameters as { readonly properties?: Readonly<Record<string, unknown>> };
  const widened: ToolDefinition = Object.freeze({
    ...shipObserve,
    parameters: Object.freeze({
      ...schema,
      properties: Object.freeze({ ...schema.properties, radius: Object.freeze({ type: "integer" }) }),
    }) as ToolDefinition["parameters"],
  });

  const coverage = parameterCoverage([widened], STATED_EXCEPTIONS);
  assert.deepEqual(coverage.undescribed.map(offenceCode), ["tool_parameter_not_described:stardew_observe:radius"]);
});

test("a stated exception that has outlived its omission is red, so the register cannot rot", () => {
  // Every entry is debt against a real omission. Describing the parameter without deleting the entry must fail, and
  // the message must name the entry - an exemption nobody has to remove is one that hides the next defect.
  const lookUp = gameSurfaceDeclaredTools().find((tool) => tool.name === "stardew_look_up");
  assert.ok(lookUp !== undefined, "blocked: stardew_look_up is not in the population this gate examines");
  const described: ToolDefinition = Object.freeze({
    ...lookUp,
    description: `${lookUp.description} \`subject\` names one of them, \`query\` is the words it is asked with.`,
  });

  const coverage = parameterCoverage([described], STATED_EXCEPTIONS);
  assert.deepEqual(coverage.undescribed.map(offenceCode), []);
  assert.deepEqual(coverage.expiredExceptions, ["stardew_look_up:query", "stardew_look_up:subject"]);
});
