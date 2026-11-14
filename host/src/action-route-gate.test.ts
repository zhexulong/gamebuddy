import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { before } from "node:test";
import { fileURLToPath } from "node:url";

import { EXPRESSION_ONLY_ACTION_IDS, visibleActionsFromModCatalog } from "./action-registry.js";
import { PLAN_ACTION_LIFECYCLES, planActionsFromRegistrations } from "./body-program-script.js";
import type { GameConnection } from "./game-connection.js";
import { createStardewActionTools, createStardewObservationTools, type MoveCapableIntegration } from "./game-tools.js";
import { createMaterializedGameCompanionRuntime } from "./game-runtime-fixed-tools.internal.js";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import type { ActionRegistration, ActionRegistrationDescriptor, Scope, Snapshot } from "./protocol.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

/**
 * EVERY ACTION THE PLAYER CAN REACH MUST HAVE EXACTLY ONE ROUTE, AND IT MUST BE THE ROUTE ITS KIND REQUIRES.
 *
 * <p>
 * The defect this file exists for: `runtime-core.internal.ts` drops every per-action tool an adapter publishes when the
 * composition declares `planActionSurface`, and the live Game materializer declares it. That rule is right about WORK -
 * a one-step tool beside the plan builder only invites one-step runs - and it was silently also applied to expression.
 * `express_emote` and `face_direction` are one step by nature, so the drop left body language with a work-shaped route:
 * a plan step that queues behind the work in front of it. Measured `round46b` (2026-11-11, 68 tool calls) and `round47`
 * (2026-11-12, 64 assistant turns, 188 planned nodes): zero emotes in both, and in `round47` the tool was not in the
 * request at all.
 * </p>
 *
 * <p>
 * WHY THE POPULATION IS THE ASSEMBLED TOOL SET AND NOT `actionIdForToolName`. The mapping answers "does this action have
 * a per-action tool", and it answered YES for `express_emote` the whole time - it was the mount filter, one layer below,
 * that removed it. A gate that read the mapping would have been green through both runs. So the tool side of this file
 * is the tools that actually SURVIVE the real composition: `createStardewActionTools` over the Mod's published surface,
 * handed to `createMaterializedGameCompanionRuntime` with `planActionSurface`, read back off the session's own
 * `agent.state.tools`. The plan side is `planActionsFromRegistrations`, which is the function the live materializer's own
 * `readPlanActions` calls on the same registrations (`continuity-semantic-game-runtime-materializer.ts`).
 * </p>
 *
 * <p>
 * WHERE THE EXPRESSION SET COMES FROM: `EXPRESSION_ONLY_ACTION_IDS` in `action-registry.ts`, the one table that already
 * owns the action ids. Nothing here lists a tool name or an action id; the two routes are derived and the expectation is
 * derived from that declaration.
 * </p>
 */

before(async () => {
  // The compiled test artifact is deliberately not a production artifact, so path-lock's default resolver rejects
  // repository helpers. Every runtime bootstrap writes an identity profile through the durable path lock, so mint the
  // build-only reclaimer capability once before this file constructs a runtime.
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

function repositoryRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, "integrations", "stardew", "action-development"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repository_root_not_found:${start}`);
    directory = parent;
  }
}

const ROOT = repositoryRoot(dirname(fileURLToPath(import.meta.url)));
const SURFACE_ARTIFACT = join(
  ROOT,
  "integrations",
  "stardew",
  "action-development",
  "contracts",
  "generated",
  "action-surface.v1.json",
);

type SurfaceAction = Readonly<{
  actionId: string;
  identityVersion: number;
  lifecycle: string;
  kind: string;
  argumentSchema?: Readonly<Record<string, Readonly<{ type: string; enum?: readonly string[] }>>>;
  resourceTemplate?: Readonly<{ claims: readonly Readonly<{ key: string; value: string }>[] }>;
  effect?: "read" | "write";
  postcondition?: Readonly<{ name?: string }>;
  nativeBinding?: string;
}>;

async function publishedSurface(): Promise<readonly SurfaceAction[]> {
  const parsed = JSON.parse(await readFile(SURFACE_ARTIFACT, "utf8")) as Readonly<{
    schema?: unknown;
    actions?: readonly SurfaceAction[];
  }>;
  if (parsed.schema !== "gamebuddy-action-descriptors/v1" || !Array.isArray(parsed.actions))
    throw new Error("stardew_action_surface_artifact_invalid_shape");
  return parsed.actions;
}

/** The descriptor a `hello_ack` publishes for one artifact action. */
function publishedDescriptor(action: SurfaceAction): ActionRegistrationDescriptor {
  return {
    arguments: Object.entries(action.argumentSchema ?? {}).map(([name, schema]) => ({
      name,
      type: schema.type,
      ...(schema.enum === undefined ? {} : { enum: schema.enum }),
    })),
    ...(action.effect === undefined ? {} : { effect: action.effect }),
    ...(action.postcondition?.name === undefined ? {} : { postcondition: { name: action.postcondition.name } }),
    ...(action.nativeBinding === undefined ? {} : { nativeBinding: action.nativeBinding }),
  };
}

/**
 * The registrations a live `hello_ack` advertises for the artifact, which is the shape both routes are read from.
 *
 * `familyId` is the one registration field the artifact does not publish. The plan vocabulary groups by it and this file
 * asks only about membership, so the action's own id stands in for the family it belongs to.
 */
function registrationsFrom(published: readonly SurfaceAction[]): readonly ActionRegistration[] {
  return published.map((action) =>
    Object.freeze({
      actionId: action.actionId,
      familyId: action.actionId,
      identityVersion: action.identityVersion,
      lifecycle: action.lifecycle as ActionRegistration["lifecycle"],
      kind: action.kind as ActionRegistration["kind"],
      descriptor: publishedDescriptor(action),
    }),
  );
}

/** The one route each action has, as the gate measures them. */
type Routes = Readonly<{
  /** action id -> the mounted tool that reaches it, taken from the assembled set. */
  tools: ReadonlyMap<string, string>;
  /** The action ids the plan builder admits. */
  plan: ReadonlySet<string>;
}>;

/**
 * Which of the two routes an action MUST have, and the registry's own word for why the plan is not that route.
 *
 * `toolOnly` is a declaration, never a list of ids written here: the expression set (`EXPRESSION_ONLY_ACTION_IDS`, one step
 * by nature) plus every action whose lifecycle the Mod's program-node admission excludes, read from the same
 * `PLAN_ACTION_LIFECYCLES` the Mod's own projection is bound to by `body-program-script.test.ts`.
 *
 * `cannotCarry` speaks the lifecycle the Mod publishes for the action, because that one word decides both sides today: the
 * plan vocabulary applies it, and the mount filter is that vocabulary's complement. A route-less action whose lifecycle IS
 * admitted points the reader at the plan vocabulary's argument-type filter instead, and the word still says so by naming
 * the lifecycle it is not explained by.
 */
type RouteExpectation = Readonly<{
  toolOnly: ReadonlySet<string>;
  cannotCarry: (actionId: string) => string;
}>;

type RouteReading = Readonly<{
  findings: readonly string[];
  examined: number;
  throughTool: number;
  throughPlan: number;
  neither: number;
}>;

/**
 * The judgment, as one function over three inputs, so both red directions can be driven on purpose.
 *
 * <p>
 * `admitted_action_has_no_route` is the direction a surface loses a capability: an action the live policy admits that is
 * neither mounted nor plannable cannot be called at all. `action_has_two_routes` is the direction a surface offers two
 * spellings of the same act - today that is what a plan surface's per-action tools would be, which is why the mount rule
 * exists. The third code is the one this file was written for: exactly one route, and NOT the one that action's kind
 * requires, which is how expression became a work-shaped plan step while both counts above still looked healthy.
 * </p>
 */
function routeReading(actionIds: readonly string[], routes: Routes, expectation: RouteExpectation): RouteReading {
  const findings: string[] = [];
  let throughTool = 0;
  let throughPlan = 0;
  let neither = 0;
  for (const actionId of actionIds) {
    const tool = routes.tools.get(actionId);
    const planned = routes.plan.has(actionId);
    if (tool !== undefined) throughTool += 1;
    if (planned) throughPlan += 1;
    if (tool === undefined && !planned) {
      neither += 1;
      findings.push(`admitted_action_has_no_route:${actionId}:${expectation.cannotCarry(actionId)}`);
      continue;
    }
    if (tool !== undefined && planned) {
      findings.push(`action_has_two_routes:${actionId}:tool:plan`);
      continue;
    }
    const expected = expectation.toolOnly.has(actionId) ? "tool" : "plan";
    const actual = tool === undefined ? "plan" : "tool";
    if (actual !== expected)
      findings.push(`action_has_the_wrong_only_route:${actionId}:${actual}:expected_${expected}`);
  }
  return Object.freeze({
    findings: Object.freeze(findings),
    examined: actionIds.length,
    throughTool,
    throughPlan,
    neither,
  });
}

function populationLine(reading: RouteReading): string {
  return (
    `actions examined ${String(reading.examined)} · through the plan ${String(reading.throughPlan)} · ` +
    `through a tool ${String(reading.throughTool)} · through neither ${String(reading.neither)}`
  );
}

const IDENTITY = Object.freeze({
  playerId: "player_action_route_gate",
  saveId: "save_action_route_gate",
  worldId: "world_action_route_gate",
  companionId: "companion_action_route_gate",
});

const SCOPE: Scope = Object.freeze({
  integrationId: "stardew",
  saveId: IDENTITY.saveId,
  worldId: IDENTITY.worldId,
  playerId: IDENTITY.playerId,
  companionId: IDENTITY.companionId,
});

async function canonicalTemporaryRoot(): Promise<string> {
  const root = process.platform === "win32" ? process.env.LOCALAPPDATA : tmpdir();
  if (typeof root !== "string" || root.length === 0) throw new Error("test_local_app_data_unavailable");
  return realpath(root);
}

/**
 * The tools a Game session is actually handed, for a composition that declares the plan action surface.
 *
 * The per-action tools are the product's own (`createStardewActionTools` over the artifact's registrations), the adapter
 * that classifies them is the product's own, and the composition is the product's own. Nothing here re-implements the
 * drop rule: this file asks the runtime what it mounted and judges the answer.
 */
async function assembledGameToolNames(integration: MoveCapableIntegration): Promise<readonly string[]> {
  const perActionTools = createStardewActionTools(integration, undefined, () => {
    throw new Error("action_route_gate_never_dispatches");
  });
  const observationTools = createStardewObservationTools(integration, undefined);
  assert.ok(
    perActionTools.length > 0,
    "blocked: the Mod's own surface assembles no per-action tool, so this gate would judge an empty route set",
  );
  const connection = {
    scope: SCOPE,
    executionGate: { executable: true },
    state: integration.state,
    module: {
      ...STARDEW_GAME_INTEGRATION_ADAPTER,
      createToolSet: () =>
        Object.freeze({ observation: observationTools, actions: perActionTools, knowledge: [] as const }),
    },
  } as unknown as GameConnection;
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-action-route-gate-"));
  const runtime = await createMaterializedGameCompanionRuntime(
    IDENTITY,
    join(root, "plan"),
    connection,
    "game_action_route_gate",
    undefined,
    undefined,
    { gameplaySubagentEnabled: false, disableMagicContextMemory: true, hostBindingFactory: () => undefined },
    Object.freeze({
      fixedTools: Object.freeze([]),
      resolvedPolicy: Object.freeze({ policyVersion: 1 as const, deniedActions: [], deniedFamilies: [] }),
      planActionSurface: true as const,
    }),
  );
  try {
    return runtime.session.agent.state.tools.map((tool) => tool.name);
  } finally {
    runtime.session.dispose();
  }
}

/** The mounted tool that reaches each action, read off the assembled set by the action's own id. */
function toolRoutes(assembled: readonly string[], actionIds: readonly string[]): ReadonlyMap<string, string> {
  const known = new Set(actionIds);
  const routes = new Map<string, string>();
  for (const name of assembled) {
    if (!name.startsWith("stardew_")) continue;
    const actionId = name.slice("stardew_".length);
    // Only an id the Mod publishes is an action route: `stardew_observe`, `stardew_stop_action` and the program readers
    // are named like tools and are not actions, so a prefix rule alone would count them.
    if (known.has(actionId) && !routes.has(actionId)) routes.set(actionId, name);
  }
  return routes;
}

/**
 * The actions this gate judges: every execution action the Host's live policy ADMITS.
 *
 * ADMISSION IS THE POPULATION, and it did not used to be. The gate took its population from `PLAN_ACTION_LIFECYCLES` - the
 * very rule the plan vocabulary applies - so the seven actions that rule excludes sat outside the boundary of the gate that
 * exists to find an action with no route. Measured 2026-11-14 on the surface the Mod publishes: `sweep_scythe`,
 * `rotate_furniture`, `remove_fence`, `put_item_in_fish_tank`, `place_item_on_pedestal`, `break_resource_clump` and
 * `open_geode` were all admitted by `visibleActionsFromModCatalog` (the call `game-tools.ts` makes to mount their tools),
 * were carried by neither route, and this file could not name one of them - it printed `actions examined 96 · through a
 * tool 2 · through the plan 94 · through neither 0` and passed.
 *
 * That is the same shape as `tools/check-action-surface-parity.mjs`'s lifecycle exemption, which is how the seven stayed
 * invisible for a week: every gate that could have named them took its population from the declaration that excluded them.
 * Admission is the authority here because it is the fact the product answers "may this be called at all" with.
 */
function admittedActionIds(registrations: readonly ActionRegistration[]): readonly string[] {
  const capabilities = registrations
    .filter((registration) => registration.kind === "execution")
    .map((registration) => registration.actionId);
  return visibleActionsFromModCatalog(registrations, capabilities)
    .filter((action) => action.kind === "execution")
    .map((action) => action.actionId)
    .sort();
}

/** The lifecycle the Mod publishes for each action, as the why-word a route-less action is reported with. */
function publishedLifecycles(registrations: readonly ActionRegistration[]): ReadonlyMap<string, string> {
  return new Map(registrations.map((registration) => [registration.actionId, registration.lifecycle]));
}

/**
 * Which admitted actions the plan may NOT carry, in the registry's own words.
 *
 * An action whose route must be its own tool is declared in one of two places, and neither is a list here: expression
 * (`EXPRESSION_ONLY_ACTION_IDS` - one step by nature) or a lifecycle the Mod's Body Program catalog refuses a node for
 * (`PLAN_ACTION_LIFECYCLES`, bound to that Mod source by `body-program-script.test.ts`).
 */
function routeExpectation(actionIds: readonly string[], lifecycles: ReadonlyMap<string, string>): RouteExpectation {
  const expressionOnly = new Set<string>(EXPRESSION_ONLY_ACTION_IDS);
  const plannableLifecycles = new Set<string>(PLAN_ACTION_LIFECYCLES);
  const lifecycleOf = (actionId: string): string => lifecycles.get(actionId) ?? "unpublished";
  return Object.freeze({
    toolOnly: new Set(
      actionIds.filter((actionId) => expressionOnly.has(actionId) || !plannableLifecycles.has(lifecycleOf(actionId))),
    ),
    cannotCarry: (actionId: string) => `lifecycle=${lifecycleOf(actionId)}`,
  });
}

function integrationFor(published: readonly SurfaceAction[]): MoveCapableIntegration {
  const registrations = registrationsFrom(published);
  const capabilities = registrations.filter((registration) => registration.kind === "execution").map((r) => r.actionId);
  const snapshot: Snapshot = {
    revision: 1,
    location: "Farm",
    tile: { x: 10, y: 15 },
    stamina: 100,
    exhausted: false,
    health: 100,
    actionable: true,
    capabilities,
    catalogRevision: 1,
    enabledActionIds: capabilities,
    presentationLocale: "en-US",
    timeOfDay: 600,
    dayOfMonth: 1,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    activeExecution: null,
  };
  return {
    scope: SCOPE,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    state: {
      connected: true,
      sessionId: "session_action_route_gate",
      capabilities,
      catalogRevision: 1,
      enabledActionIds: capabilities,
      snapshot,
      latestReceipt: null,
      latestReasonCode: null,
      catalogRegistrations: registrations,
    },
    async execute() {
      throw new Error("action_route_gate_never_executes");
    },
    async cancel() {
      throw new Error("action_route_gate_never_cancels");
    },
  };
}

test("every action the live policy admits has exactly one reachable route, and it is the one its kind requires", async (t) => {
  const published = await publishedSurface();
  const registrations = registrationsFrom(published);
  const actionIds = admittedActionIds(registrations);
  // Zero population is BLOCKED, never green: a filter that admitted nothing would make every count below agree.
  assert.ok(
    actionIds.length >= 50,
    `blocked: only ${String(actionIds.length)} actions were admitted by the live policy, so no route set could be judged`,
  );

  const integration = integrationFor(published);
  const assembled = await assembledGameToolNames(integration);
  const routes: Routes = Object.freeze({
    tools: toolRoutes(assembled, actionIds),
    plan: new Set<string>(planActionsFromRegistrations(registrations).map((action) => action.actionId)),
  });
  assert.ok(routes.plan.size > 0, "blocked: the plan builder admits no action, so no route could be a plan step");

  const expectation = routeExpectation(actionIds, publishedLifecycles(registrations));
  const expressionOnly = new Set<string>(EXPRESSION_ONLY_ACTION_IDS);
  const reading = routeReading(actionIds, routes, expectation);
  t.diagnostic(populationLine(reading));

  // The declaration may not name an action this surface does not publish: an exception that exempts nothing is a rule
  // nobody reads, and the two counts above would then be quietly about a smaller population than the declaration says.
  const unexaminedDeclared = [...expressionOnly]
    .filter((actionId) => !actionIds.includes(actionId))
    .map((actionId) => `expression_action_not_examined:${actionId}`);
  assert.deepEqual(
    unexaminedDeclared,
    [],
    "the expression declaration names an action the live policy does not admit, so its exception exempts nothing",
  );

  assert.deepEqual(
    reading.findings,
    [],
    [
      `${populationLine(reading)}:`,
      ...reading.findings,
      "An expression action reaches the actor through its own mounted tool, and so does an action the plan cannot carry; " +
        "every other admitted action reaches it as a plan step.",
    ].join("\n"),
  );
  // The count is asserted beside the list, because a finding list is only empty on a population it covered.
  assert.equal(
    reading.neither,
    0,
    "an admitted action with neither route cannot be called at all, which is a capability the product lost",
  );
});

/**
 * The two directions that must make the gate red on purpose.
 *
 * A guard whose only red is the defect it was written for is a guard that has been read once. Each case below is the
 * shape a future change takes, driven through the SAME judgment the gate above uses.
 */
test("the route gate is red on purpose when an action has two routes, or none", () => {
  const expectation = Object.freeze({
    toolOnly: new Set<string>(["express_emote"]),
    cannotCarry: (actionId: string) =>
      actionId === "face_direction" ? "lifecycle=experimental" : "lifecycle=published",
  });
  const both = routeReading(
    ["express_emote"],
    { tools: new Map([["express_emote", "stardew_express_emote"]]), plan: new Set(["express_emote"]) },
    expectation,
  );
  assert.deepEqual(
    both.findings,
    ["action_has_two_routes:express_emote:tool:plan"],
    "an action reachable through a tool AND through the plan is two spellings of one act",
  );
  const neither = routeReading(["face_direction"], { tools: new Map(), plan: new Set() }, expectation);
  assert.deepEqual(
    neither.findings,
    ["admitted_action_has_no_route:face_direction:lifecycle=experimental"],
    "an action the live policy admits with no mounted tool and no plan step cannot be called at all, and the name says why",
  );
  assert.equal(neither.neither, 1, "the population line must count the unreachable action");
});

test("the route gate is red on purpose when the one route an expression action has is a work-shaped plan step", () => {
  // This is the tree's own state before the fix: the plan vocabulary admitted both expression actions and the mount
  // filter removed both tools, so each had exactly one route - the wrong one. Neither of the two counts above can see
  // that, which is why this third code exists.
  const reading = routeReading(
    ["express_emote", "face_direction", "till_soil"],
    {
      tools: new Map(),
      plan: new Set(["express_emote", "face_direction", "till_soil"]),
    },
    Object.freeze({
      toolOnly: new Set(["express_emote", "face_direction"]),
      cannotCarry: () => "lifecycle=experimental",
    }),
  );
  assert.deepEqual(reading.findings, [
    "action_has_the_wrong_only_route:express_emote:plan:expected_tool",
    "action_has_the_wrong_only_route:face_direction:plan:expected_tool",
  ]);
  assert.equal(reading.throughPlan, 3, "every examined action is counted where it was found");
});
