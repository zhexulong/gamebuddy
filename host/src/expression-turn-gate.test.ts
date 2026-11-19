import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXPRESSION_ONLY_ACTION_IDS,
  isExpressionOnlyAction,
  STARDEW_ACTION_TOOL_NAMES,
  type StardewActionId,
} from "./action-registry.js";
import { createExpressionTurnGate, EXPRESSION_ONLY_TOOL_NAMES } from "./expression-turn-gate.js";
import type { StardewBridgeConnection } from "./game-connection.js";
import { createStardewActionTools, type MoveCapableIntegration } from "./game-tools.js";
import { ExecutionCorrelationLedger } from "./execution-correlation-ledger.js";
import type { ActionRegistration, ActionRegistrationDescriptor, Scope } from "./protocol.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";

/**
 * THE HINT THAT ENDS A TURN RIDES THE EXPRESSION RESULT, and nothing else.
 *
 * <p>
 * Pi's own interface for it is `AgentToolResult.terminate` - "Hint that the agent should stop after the current tool
 * batch. Early termination only happens when every finalized tool result in the batch sets this to true" - so the tool
 * result is the ONLY place a turn can end without another model round. `round78` measured why that matters: `tool rounds
 * 62 · with text 0` and every line she wrote in a separate no-tool round after the last result (25 of 26 rounds, 322
 * chars, 21 of the 25 narration).
 * </p>
 * <p>
 * THE POPULATION IS THE DECLARATION: every action `EXPRESSION_ONLY_ACTION_IDS` names is driven through the real tool the
 * Host mounts, over the Mod's own published descriptor, with the gate open and closed. The work action and the refusal are
 * the two negative cases, and they are the ones that keep the rule honest - a gesture that FAILED is news she has to be
 * able to read, so its result carries no hint.
 * </p>
 */

const SCOPE: Scope = Object.freeze({
  integrationId: "stardew",
  saveId: "save_silent_terminator",
  worldId: "world_silent_terminator",
  playerId: "player_silent_terminator",
  companionId: "companion_silent_terminator",
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

const SURFACE_ARTIFACT = join(
  repositoryRoot(dirname(fileURLToPath(import.meta.url))),
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
  effect?: "read" | "write";
  postcondition?: Readonly<{ name?: string }>;
  nativeBinding?: string;
}>;

/** The registrations a live `hello_ack` advertises, for exactly the actions this file drives. */
async function publishedSurface(): Promise<readonly SurfaceAction[]> {
  const parsed = JSON.parse(await readFile(SURFACE_ARTIFACT, "utf8")) as Readonly<{
    schema?: unknown;
    actions?: readonly SurfaceAction[];
  }>;
  if (parsed.schema !== "gamebuddy-action-descriptors/v1" || !Array.isArray(parsed.actions))
    throw new Error("stardew_action_surface_artifact_invalid_shape");
  return parsed.actions;
}

function registrationOf(action: SurfaceAction): ActionRegistration {
  return Object.freeze({
    actionId: action.actionId,
    familyId: action.actionId,
    identityVersion: action.identityVersion,
    lifecycle: action.lifecycle as ActionRegistration["lifecycle"],
    kind: action.kind as ActionRegistration["kind"],
    descriptor: Object.freeze({
      arguments: Object.keys(action.argumentSchema ?? {}).map((name) => {
        const schema = (action.argumentSchema ?? {})[name]!;
        return {
          name,
          type: schema.type,
          ...(schema.enum === undefined ? {} : { enum: schema.enum }),
        };
      }),
      ...(action.effect === undefined ? {} : { effect: action.effect }),
      ...(action.postcondition?.name === undefined ? {} : { postcondition: { name: action.postcondition.name } }),
      ...(action.nativeBinding === undefined ? {} : { nativeBinding: action.nativeBinding }),
    }) as ActionRegistrationDescriptor,
  });
}

/** The first argument each expression action declares, read from the published descriptor rather than written here. */
function declaredArgs(registration: ActionRegistration): Readonly<Record<string, unknown>> {
  const declared = registration.descriptor?.arguments?.[0];
  assert.ok(
    declared !== undefined && declared.enum !== undefined && declared.enum.length > 0,
    `blocked: ${registration.actionId} publishes no closed argument, so this file cannot call its tool`,
  );
  return Object.freeze({ [declared.name]: declared.enum[0] });
}

type Live = Readonly<{ integration: MoveCapableIntegration; dispatched: string[] }>;

/** A live connection whose bridge answers every write with a receipt - the shape a real emote returns. */
function liveIntegration(registrations: readonly ActionRegistration[], capabilities: readonly string[]): Live {
  const dispatched: string[] = [];
  const integration: MoveCapableIntegration = {
    scope: SCOPE,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    state: {
      connected: true,
      sessionId: "session_silent_terminator",
      capabilities: [...capabilities],
      catalogRevision: 1,
      enabledActionIds: [...capabilities],
      snapshot: {
        revision: 7,
        location: "Farm",
        tile: { x: 64, y: 15 },
        stamina: 270,
        exhausted: false,
        health: 100,
        actionable: true,
        capabilities: [...capabilities],
        catalogRevision: 1,
        enabledActionIds: [...capabilities],
        presentationLocale: "zh-CN",
        timeOfDay: 620,
        dayOfMonth: 5,
        seasonIndex: 0,
        year: 1,
        weather: "sunny",
        activeExecution: null,
      },
      latestReceipt: null,
      latestReasonCode: null,
      catalogRegistrations: registrations,
    },
    async execute(request) {
      dispatched.push(request.action);
      return {
        executionId: "execution_silent_terminator",
        actionId: request.action,
        requestId: request.requestId,
        state: "succeeded",
        reasonCode: "settled",
        revision: 8,
        evidence: { detail: "settled" },
      };
    },
    async cancel() {
      throw new Error("silent_terminator_never_cancels");
    },
  };
  return Object.freeze({ integration, dispatched });
}

function admission(integration: MoveCapableIntegration) {
  const ledger = new ExecutionCorrelationLedger((requestId, executionId, reasonCode) =>
    integration.cancel(requestId, executionId, reasonCode),
  );
  const owner = Object.freeze({ ownerId: "test_owner", epoch: 1 });
  return Object.freeze({
    observer: ledger,
    owner,
    cancelExact: (requestId: string, executionId: string, reasonCode: string) =>
      ledger.requestCancelExact(owner, requestId, executionId, reasonCode),
  });
}

type Ran = Readonly<{ terminate: boolean | undefined; result: unknown }>;

/**
 * Run one mounted action tool over the real bridge seam.
 *
 * The gate is the factory's own parameter - the object the turn boundary writes - so this drives the same wiring the
 * runtime composes rather than a predicate restated beside it.
 */
async function runToolWithGate(
  live: Live,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  gate: { worldOpened: boolean },
): Promise<Ran> {
  const tool = createStardewActionTools(
    live.integration as unknown as StardewBridgeConnection,
    undefined,
    () => admission(live.integration),
    undefined,
    gate,
  ).find((candidate) => candidate.name === toolName);
  assert.ok(tool, `the Host must mount ${toolName} over the Mod's published descriptor`);
  const result = (await tool!.execute("call_01", args as never, new AbortController().signal, () => {}, {} as never)) as {
    terminate?: boolean;
  };
  return Object.freeze({ terminate: result.terminate, result });
}

test("the expression result carries the early-termination hint exactly when the turn's gate is open", async () => {
  const expressionIds = [...EXPRESSION_ONLY_ACTION_IDS] as readonly StardewActionId[];
  // A GATE WITH NO POPULATION AGREES WITH ITSELF.
  assert.ok(expressionIds.length > 0, "the expression declaration names no action, so this gate would examine nothing");
  const surface = await publishedSurface();
  // THE NEGATIVE CASE IS DERIVED TOO: a published action that is not expression, whose tool the Host mounts, and whose
  // first argument is a closed set - so this file can call it without inventing a coordinate or an id.
  const workAction = surface.find(
    (action) =>
      !isExpressionOnlyAction(action.actionId) &&
      STARDEW_ACTION_TOOL_NAMES[action.actionId as StardewActionId] !== undefined &&
      Object.values(action.argumentSchema ?? {}).some((schema) => (schema.enum ?? []).length > 0),
  );
  assert.ok(workAction, "blocked: the Mod's surface publishes no callable work action, so the negative case cannot run");
  const registrations = Object.freeze([
    ...surface.filter((action) => expressionIds.includes(action.actionId as StardewActionId)).map(registrationOf),
    registrationOf(workAction!),
  ]);
  const findings: string[] = [];
  let examined = 0;
  let terminated = 0;
  for (const actionId of expressionIds) {
    const registration = registrations.find((entry) => entry.actionId === actionId);
    if (registration === undefined) {
      findings.push(`expression_action_not_published:${actionId}:the Mod's surface publishes no descriptor`);
      continue;
    }
    const live = liveIntegration(registrations, [...expressionIds, workAction!.actionId]);
    const toolName = STARDEW_ACTION_TOOL_NAMES[actionId];
    assert.ok(EXPRESSION_ONLY_TOOL_NAMES.has(toolName), `${actionId} must be reachable through the derived tool set`);
    const args = declaredArgs(registration);

    // OPEN: a turn the world opened ends at the gesture.
    const gate = createExpressionTurnGate();
    gate.worldOpened = true;
    const opened = await runToolWithGate(live, toolName, args, gate);
    examined += 1;
    if (opened.terminate === true) terminated += 1;
    else findings.push(`expression_result_did_not_end_a_world_opened_turn:${actionId}`);

    // CLOSED: a turn the person opened is owed an answer, so the result carries no hint.
    const closed = await runToolWithGate(live, toolName, args, createExpressionTurnGate());
    examined += 1;
    if (closed.terminate !== undefined) findings.push(`expression_result_ended_a_player_opened_turn:${actionId}`);

    // REFUSED: an expression that never reached the world is news, so the turn keeps running.
    const refused = await runToolWithGate(
      liveIntegration(registrations, []),
      toolName,
      args,
      Object.freeze({ worldOpened: true }),
    );
    examined += 1;
    if (refused.terminate !== undefined)
      findings.push(`refused_expression_ended_the_turn:${actionId}:the model never gets to read the refusal`);
  }
  // THE WORK ACTION IS NEVER A TERMINATOR, whatever the gate says: Pi needs EVERY result in the batch to carry the hint.
  const workLive = liveIntegration(registrations, [workAction!.actionId]);
  const work = await runToolWithGate(
    workLive,
    STARDEW_ACTION_TOOL_NAMES[workAction!.actionId as StardewActionId],
    declaredArgs(registrationOf(workAction!)),
    Object.freeze({ worldOpened: true }),
  );
  examined += 1;
  if (work.terminate !== undefined) findings.push(`work_action_carried_the_termination_hint:${workAction!.actionId}`);
  const line = `results examined ${String(examined)} · expression ended the turn ${String(terminated)} · expression ids ${String(expressionIds.length)}`;
  assert.deepEqual(findings, [], `${line}\n${findings.join("\n")}`);
  assert.equal(terminated, expressionIds.length, `${line}: every expression action must end a world-opened turn`);
});
