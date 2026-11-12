import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  createGameRuntimeBindingFromReceiptBackedLaunch,
  type GameRuntimeBinding,
} from "./continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import {
  type GameRuntimeBindingExecution,
  reserveGameRuntimeMaterialization,
  withConsumedBindingExecution,
} from "./continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.internal.js";
import {
  materializeExactEnter,
  type OpaqueS4cMaterializationAdmission,
} from "./continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.internal.js";
import { loadHostDeploymentManifest } from "./deployment-manifest.js";
import { readSourceShape } from "./test-support/source-shape.test-support.js";
import {
  PLAN_TOOL_SLOT_MEANING,
  planActionsFromRegistrations,
  planProgramId,
  planSettlementNote,
} from "./body-program-script.js";
import { createHostGameRuntimeMaterializer } from "./continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.js";
import { observeMaterializedProductionRuntimeForTest } from "./continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.test-support.js";
import { assertReceiptBackedLaunch } from "./integration-launcher.js";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";
import { LocalStardewBridgeClient } from "./local-stardew-bridge.js";
import {
  validateBodyProgramCandidateRequest,
  type ActionRegistration,
  type BridgeMessage,
  type ExecutionReceipt,
  type Scope,
  type Snapshot,
} from "./protocol.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";

const testAdapter = STARDEW_GAME_INTEGRATION_ADAPTER;
import {
  createStardewIntegrationLaunchHandleFromAuthenticatedBridge,
  getAuthenticatedStardewPresentationPortForPreview,
  STARDEW_INTEGRATION_LAUNCHER,
} from "./stardew-integration-launcher.js";
import {
  requireLiveConnection,
  materializeAuthenticatedStardewLaunchPorts,
} from "./stardew-integration-launcher-body-program.internal.js";

const scope: Scope = Object.freeze({
  integrationId: "stardew",
  saveId: "save_attestation",
  worldId: "world_attestation",
  playerId: "farmhand_attestation",
  companionId: "companion_attestation",
});
const token = "farmhand_bridge_token_0123456789";
const generation = "ai-generation-attestation";
const continuityId = "continuity_attestation";

/**
 * What the shared pipe's Mod publishes: one published execution whose descriptor declares no arguments. A plan
 * script therefore has no method for it, which is what the refusal cases below exercise; a test that needs a plan the
 * builder can actually write passes its own catalog to `withHelloAck`.
 */
const DEFAULT_HELLO_REGISTRATIONS: readonly unknown[] = Object.freeze([
  {
    actionId: "move_to_tile",
    familyId: "movement_navigation",
    identityVersion: 1,
    lifecycle: "published",
    kind: "execution",
  },
]);

/** One action as the Mod's own published surface artifact declares it. */
type PublishedSurfaceAction = Readonly<{
  actionId: string;
  lifecycle: string;
  kind: string;
  argumentSchema?: Readonly<Record<string, { type: string; enum?: readonly string[] }>>;
  outputFacts?: Readonly<Record<string, string>>;
  resourceTemplate?: Readonly<{ claims: readonly Readonly<{ key: string; value: string }>[] }>;
}>;

/**
 * The registrations a live Farmhand advertises on hello_ack, rebuilt from the Mod-owned surface artifact
 * (`integrations/stardew/action-development/contracts/generated/action-surface.v1.json`) rather than hand-written
 * here: a surface assertion has to be made over the catalog the product actually publishes.
 */
function publishedSurfaceRegistrations(): readonly ActionRegistration[] {
  const path = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "integrations",
    "stardew",
    "action-development",
    "contracts",
    "generated",
    "action-surface.v1.json",
  );
  const surface = JSON.parse(readFileSync(path, "utf8")) as { actions: readonly PublishedSurfaceAction[] };
  return Object.freeze(
    surface.actions.map((action) =>
      Object.freeze({
        actionId: action.actionId,
        familyId: "fixture_family",
        identityVersion: 1,
        lifecycle: action.lifecycle as ActionRegistration["lifecycle"],
        kind: action.kind as ActionRegistration["kind"],
        ...(action.argumentSchema === undefined
          ? {}
          : {
              descriptor: {
                argumentSchema: action.argumentSchema,
                outputFacts: action.outputFacts ?? {},
                ...(action.resourceTemplate === undefined ? {} : { resourceTemplate: action.resourceTemplate }),
              },
            }),
      }),
    ),
  );
}

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

async function receiptBackedBinding(
  launch: import("./integration-launcher.js").IntegrationLaunchHandle,
): Promise<GameRuntimeBinding> {
  const root = await mkdtemp(join(tmpdir(), "stardew-s4c-admission-"));
  const runtimeRoot = join(root, "runtime");
  await mkdir(runtimeRoot);
  const manifestPath = join(root, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot,
      principal: Object.freeze({
        continuityId: "continuity_attestation",
        companionId: scope.companionId,
        playerId: "player_attestation",
      }),
      bootstrapOperationId: "bootstrap_attestation",
      authorityGeneration: 1,
    }),
  );
  return createGameRuntimeBindingFromReceiptBackedLaunch(
    Object.freeze({
      manifest: await loadHostDeploymentManifest(manifestPath),
      launcher: STARDEW_INTEGRATION_LAUNCHER,
      launch,
      expectedWorld: Object.freeze({ saveId: scope.saveId, worldId: scope.worldId }),
    }),
  );
}

function enterPermit(execution: GameRuntimeBindingExecution) {
  return Object.freeze({
    principal: execution.principal,
    operationId: "operation_attestation",
    requestId: "request_attestation",
    kind: "enter" as const,
    gameSessionId: "game_session_attestation",
    world: execution.world,
    bindingDigest: execution.bindingFacts.bindingDigest,
    owner: execution.bindingFacts.owner,
    deadlineAtMs: Date.now() + 30_000,
    expected: Object.freeze({ partitionRevision: 1, gameRevision: 0, leaseRevision: 0, fenceEpoch: 1 }),
    payloadDigest: "a".repeat(64),
    fenceToken: "fence_attestation",
    prepared: Object.freeze({ partitionRevision: 2, gameRevision: 0, leaseRevision: 1, fenceEpoch: 2 }),
  });
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

async function withHelloAck<T>(
  runtimeRole: "farmhand_client" | "native_local_fixture" | "unattested",
  launchGeneration: string | null,
  operation: (pipeName: string, peerClosed: Promise<void>) => Promise<T>,
  onRequest?: (request: BridgeMessage, socket: Socket) => boolean | void,
  helloAck?: Readonly<{ registrations: readonly unknown[]; capabilities?: readonly string[] }>,
): Promise<T> {
  // The fixture Mod publishes one published execution unless a test supplies the catalog it wants the surface built
  // over: the figures a surface assertion makes have to come from the Mod's own hello_ack, not from the test's list.
  const capabilities = helloAck?.capabilities ?? ["move_to_tile"];
  const pipeName = `gamebuddy_farmhand_attestation_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let peer: Socket | undefined;
  let resolvePeerClosed!: () => void;
  const peerClosed = new Promise<void>((resolve) => {
    resolvePeerClosed = resolve;
  });
  const server = createServer((socket) => {
    peer = socket;
    socket.once("close", resolvePeerClosed);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.byteLength < 4 + length) return;
        const request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")) as BridgeMessage;
        buffer = buffer.subarray(4 + length);
        if (onRequest?.(request, socket) === true) continue;
        if (request.type === "hello")
          socket.write(
            frame({
              ...request,
              messageId: "mod_hello_attestation",
              type: "hello_ack",
              payload: {
                sessionId: "session_attestation",
                capabilities,
                catalogRevision: 1,
                policyIdentity: { value: "0123456789abcdef0123456789abcdef", capabilityRevision: 1 },
                enabledActionIds: capabilities,
                presentationLocale: "en-US",
                registrations: helloAck?.registrations ?? DEFAULT_HELLO_REGISTRATIONS,
                runtimeRole,
                launchGeneration,
              },
            }),
          );
        else if (request.type === "observe_request")
          socket.write(
            frame({
              ...request,
              messageId: "mod_snapshot_attestation",
              type: "snapshot",
              payload: {
                revision: 1,
                location: "Farm",
                tile: { x: 5, y: 8 },
                stamina: 250,
                exhausted: false,
                health: 100,
                actionable: true,
                capabilities,
                catalogRevision: 1,
                enabledActionIds: capabilities,
                presentationLocale: "en-US",
                weather: "sunny",
                timeOfDay: 600,
                dayOfMonth: 1,
                seasonIndex: 0,
                year: 1,
                activeExecution: null,
              },
            }),
          );
        else if (request.type === "program_submit")
          socket.write(
            frame({
              ...request,
              messageId: "mod_program_submit_attestation",
              type: "program_submit_result",
              payload: {
                code: "rejected",
                verification: {
                  accepted: false,
                  catalogRevision: 1,
                  diagnostics: [
                    {
                      severity: "error",
                      code: "policy_denied",
                      nodeId: null,
                      path: "program",
                      message: "policy_denied",
                    },
                  ],
                },
                snapshot: null,
              },
            }),
          );
        else if (request.type === "program_status")
          socket.write(
            frame({
              ...request,
              messageId: "mod_program_status_attestation",
              type: "program_status_result",
              payload: {
                code: "found",
                snapshot: {
                  programId: request.payload.programId ?? "program_01",
                  state: "active",
                  catalogRevision: 1,
                  stopEpoch: 0,
                  eventHighWater: 0,
                  nodes: [],
                },
                programs: null,
                programCount: 1,
              },
            }),
          );
        else if (request.type === "program_events")
          socket.write(
            frame({
              ...request,
              messageId: "mod_program_events_attestation",
              type: "program_events_result",
              payload: {
                programId: request.payload.programId,
                code: "found",
                nextCursor: request.payload.cursor + 1,
                highWater: request.payload.cursor + 1,
                events: [
                  {
                    cursor: request.payload.cursor + 1,
                    programId: request.payload.programId,
                    kind: "accepted",
                    catalogRevision: 1,
                    nodeId: null,
                    nodeAttempt: null,
                  },
                ],
              },
            }),
          );
      }
    });
  });
  await new Promise<void>((resolve, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, resolve).once("error", reject),
  );
  try {
    return await operation(pipeName, peerClosed);
  } finally {
    peer?.destroy();
    await closeServer(server);
  }
}

test("formal Farmhand bridge produces the existing receipt-backed Stardew launch handle", async () => {
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(
      scope,
      pipeName,
      token,
      generation,
      Date.now() + 5_000,
      testAdapter,
    );
    const identity = Object.freeze({
      playerId: "browser_player_01",
      companionId: scope.companionId,
      continuityId: "continuity_attestation_01",
      saveId: scope.saveId,
      worldId: scope.worldId,
    });
    const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(client, identity, {
      module: STARDEW_GAME_INTEGRATION_ADAPTER,
    });
    assertReceiptBackedLaunch(STARDEW_INTEGRATION_LAUNCHER, launch, identity);
    assert.equal(launch.connection.module.actorId(launch.connection), scope.playerId);
    assert.notEqual(launch.connection.module.actorId(launch.connection), identity.playerId);
    assert.equal(Object.hasOwn(launch, "presentationBridge"), false);
    assert.equal(Object.hasOwn(launch, "bodyProgram"), false);
    assert.equal(Object.hasOwn(launch, "materializeAuthenticatedStardewLaunchPorts"), false);
    assert.equal(Object.hasOwn(launch, "authenticatedStardewLaunchRecords"), false);
    assert.equal(Object.hasOwn(launch, "associateAuthenticatedStardewLaunch"), false);
    assert.deepEqual(launch.receiptRecovery?.scope, {
      product: "stardew",
      continuityId: "continuity_attestation_01",
      integrationId: "stardew",
      saveId: scope.saveId,
      worldId: scope.worldId,
    });
    assert.deepEqual(launch.receiptRecovery?.bindingIdentity, launch.receiptRecovery?.scope);
    assert.equal(Object.isFrozen(launch.receiptRecovery), true);
    assert.equal(Object.hasOwn(launch, ["program", "Verify"].join("")), false);
    assert.equal(Object.hasOwn(launch, "programSubmit"), false);
    const presentation = getAuthenticatedStardewPresentationPortForPreview(launch);
    assert.deepEqual(Object.keys(presentation).sort(), ["presentCompanionText", "presentSystemNotice", "state"]);
    assert.equal(["program", "Verify"].join("") in presentation, false);
    launch.close();
    assert.throws(
      () => getAuthenticatedStardewPresentationPortForPreview(launch),
      /authenticated_stardew_presentation_port_required/,
    );
  });
});

test("S4c body-program admission expires with its factory callback and rejects forgery", async () => {
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(
      scope,
      pipeName,
      token,
      generation,
      Date.now() + 5_000,
      testAdapter,
    );
    const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
      client,
      Object.freeze({
        playerId: "player_attestation",
        companionId: scope.companionId,
        continuityId,
        saveId: scope.saveId,
        worldId: scope.worldId,
      }),
      { module: STARDEW_GAME_INTEGRATION_ADAPTER },
    );
    const binding = await receiptBackedBinding(launch);
    let retainedExecution!: GameRuntimeBindingExecution;
    let retainedAdmission!: OpaqueS4cMaterializationAdmission;
    try {
      await binding.executeWithBinding((token) =>
        withConsumedBindingExecution(token, (execution) =>
          materializeExactEnter(
            reserveGameRuntimeMaterialization(execution),
            enterPermit(execution),
            async (current, admission) => {
              retainedExecution = current;
              retainedAdmission = admission;
              assert.throws(
                () =>
                  materializeAuthenticatedStardewLaunchPorts(
                    current,
                    Object.freeze({}) as OpaqueS4cMaterializationAdmission,
                  ),
                /s4c_materialization_admission_rejected/,
              );
              const ports = materializeAuthenticatedStardewLaunchPorts(current, admission);
              assert.deepEqual(Object.keys(ports).sort(), ["bodyProgram", "presentation"]);
              assert.deepEqual(await ports.bodyProgram.status({ programId: "program_01" }), {
                code: "found",
                snapshot: {
                  programId: "program_01",
                  state: "active",
                  catalogRevision: 1,
                  stopEpoch: 0,
                  eventHighWater: 0,
                  nodes: [],
                },
                // An addressed query answers one program and no page: the two paths are distinguishable, not one of them
                // being an empty list.
                programs: null,
                programCount: 1,
              });
              return Object.freeze({ session: Object.freeze({ dispose: () => undefined }) });
            },
          ),
        ),
      );
      assert.throws(
        () => materializeAuthenticatedStardewLaunchPorts(retainedExecution, retainedAdmission),
        /s4c_materialization_admission_rejected/,
      );
    } finally {
      await binding.close();
    }
  });
});

test("actual attested pipe mounts only the program submit tool until a submission is recorded, and its copy example is an accepted-shape plan", async () => {
  const requests: BridgeMessage[] = [];
  await withHelloAck(
    "farmhand_client",
    generation,
    async (pipeName) => {
      const client = await LocalStardewBridgeClient.connectFarmhand(
        scope,
        pipeName,
        token,
        generation,
        Date.now() + 5_000,
        testAdapter,
      );
      const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
        client,
        Object.freeze({
          playerId: "player_attestation",
          companionId: scope.companionId,
          continuityId,
          saveId: scope.saveId,
          worldId: scope.worldId,
        }),
        { module: STARDEW_GAME_INTEGRATION_ADAPTER },
      );
      const binding = await receiptBackedBinding(launch);
      let materialized:
        | Awaited<ReturnType<ReturnType<typeof createHostGameRuntimeMaterializer>["materializeEnter"]>>
        | undefined;
      try {
        materialized = await binding.executeWithBinding((bindingToken) =>
          withConsumedBindingExecution(bindingToken, (execution) =>
            createHostGameRuntimeMaterializer().materializeEnter(
              reserveGameRuntimeMaterialization(execution),
              enterPermit(execution),
            ),
          ),
        );
        const tools = observeMaterializedProductionRuntimeForTest(materialized).session.agent.state.tools;
        const fixedToolNames = tools
          .map((tool) => tool.name)
          .filter((name) =>
            [
              "stardew_submit_action_program",
              "stardew_plan_work",
              "stardew_plan_shape",
              "stardew_action_program_status",
              "stardew_action_program_events",
            ].includes(name),
          )
          .sort();
        // The two readers answer only for a program that exists, so nothing is mounted for them yet; the raw submit
        // tool, the plan tool that compiles into the same submission, and the read-only shape of one action are offered.
        assert.deepEqual(fixedToolNames, ["stardew_plan_shape", "stardew_plan_work", "stardew_submit_action_program"]);
        const execute = async (name: string, params: Record<string, unknown>) => {
          const tool = tools.find((current) => current.name === name);
          assert.ok(tool, `missing ${name}`);
          return await tool.execute("body-program-test", params, new AbortController().signal, () => undefined);
        };
        // The copyable example is read off the mounted tool, so the description cannot drift from the accepted shape.
        const submit = tools.find((current) => current.name === "stardew_submit_action_program");
        assert.ok(submit);
        const example = JSON.parse(submit.description.slice(submit.description.lastIndexOf('{"programId"')));
        assert.equal(
          validateBodyProgramCandidateRequest(example),
          null,
          "the example must be a plan the validator accepts",
        );
        type ExampleNode = {
          nodeId: string;
          actionId: string;
          arguments: Record<string, Record<string, string>>;
          dependsOn: readonly string[];
          bindings: Record<string, Record<string, string>>;
        };
        const exampleNodes = example.nodes as readonly ExampleNode[];
        assert.deepEqual(
          exampleNodes.map((node) => node.actionId),
          ["move_to_tile", "machine_inspect", "machine_load"],
        );
        assert.deepEqual(
          exampleNodes.map((node) => Object.keys(node).sort()),
          exampleNodes.map(() => ["actionId", "arguments", "bindings", "dependsOn", "nodeId"]),
          "isBodyProgramNode names exactly these five fields on every node",
        );
        const [move, inspect, load] = exampleNodes;
        assert.deepEqual(Object.keys(move!.arguments).sort(), ["x", "y"], "move_to_tile declares x and y");
        for (const argument of Object.values(move!.arguments))
          assert.deepEqual(
            Object.keys(argument).sort(),
            ["canonicalValue", "type"],
            "a scalar argument is {type, canonicalValue}",
          );
        assert.deepEqual(
          Object.keys(load!.arguments).sort(),
          ["expectedQualifiedItemId", "expectedTargetId", "slot", "x", "y"],
          "machine_load declares exactly these five arguments",
        );
        assert.deepEqual(load!.dependsOn, [inspect!.nodeId], "the load waits for the inspection it binds");
        assert.deepEqual(load!.bindings, {
          expectedTargetId: { nodeId: inspect!.nodeId, factName: "machine_target_id" },
        });
        const candidate = Object.freeze({
          programId: "program_01",
          nodes: [
            {
              nodeId: "node_01",
              actionId: "move_to_tile",
              arguments: {},
              dependsOn: [],
              bindings: {},
            },
          ],
        });
        const submitted = await execute("stardew_submit_action_program", candidate);
        assert.deepEqual(JSON.parse((submitted.content[0] as { text: string }).text), submitted.details);
        assert.deepEqual(submitted.details, {
          code: "rejected",
          verification: {
            accepted: false,
            catalogRevision: 1,
            diagnostics: [
              { severity: "error", code: "policy_denied", nodeId: null, path: "program", message: "policy_denied" },
            ],
          },
          snapshot: null,
        });
        assert.deepEqual(
          requests.filter((request) => request.type.startsWith("program_")).map((request) => request.type),
          ["program_submit"],
        );
        await assert.rejects(
          () => execute("stardew_submit_action_program", { programId: "bad id", nodes: [] }),
          /invalid_body_program_tool_arguments/,
        );
        assert.equal(requests.filter((request) => request.type === "program_submit").length, 1);
        // The plan tool compiles from the LIVE snapshot this bridge published and the LIVE vocabulary hello_ack
        // carried. A script over an empty family produces no nodes and names that; a script naming an action this
        // bridge did not publish for programs is told so by name - and neither reaches the Mod as a program, which
        // the same request recorder would show.
        const emptyPlan = await execute("stardew_plan_work", {
          script: "for (const crop of snapshot.cropTargets ?? []) builder.move_to_tile({ x: crop.x, y: crop.y });",
        });
        assert.deepEqual(emptyPlan.details, {
          accepted: false,
          nodeCount: 0,
          reasonCode: "plan_script_empty_no_builder_call",
        });
        const unpublishedPlan = await execute("stardew_plan_work", {
          script: "builder.move_to_tile({ x: 5, y: 8 });",
        });
        assert.deepEqual(unpublishedPlan.details, {
          accepted: false,
          nodeCount: 0,
          reasonCode: "plan_script_unknown_action:move_to_tile",
          // Nothing was published for programs on this bridge, so the refusal lists no legal id - but it always
          // answers with the list, so a model reading it never has to guess whether an empty answer means "none".
          legalActionIds: [],
        });
        const forbiddenPlan = await execute("stardew_plan_work", { script: 'const fs = require("node:fs");' });
        assert.deepEqual(forbiddenPlan.details, {
          accepted: false,
          nodeCount: 0,
          reasonCode: "plan_script_uses_forbidden:require",
        });
        await assert.rejects(() => execute("stardew_plan_work", {}), /invalid_body_program_tool_arguments/);
        assert.equal(
          requests.filter((request) => request.type === "program_submit").length,
          1,
          "a plan that compiled nothing must not reach the Mod as a program",
        );
      } finally {
        await materialized?.close();
        await binding.close();
      }
    },
    (request) => {
      requests.push(request);
    },
  );
});

test("a plan compiled against the live catalog reaches the Mod by the same submission a hand-written program takes", async () => {
  const requests: BridgeMessage[] = [];
  await withHelloAck(
    "farmhand_client",
    generation,
    async (pipeName) => {
      const client = await LocalStardewBridgeClient.connectFarmhand(
        scope,
        pipeName,
        token,
        generation,
        Date.now() + 5_000,
        testAdapter,
      );
      const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
        client,
        Object.freeze({
          playerId: "player_attestation",
          companionId: scope.companionId,
          continuityId,
          saveId: scope.saveId,
          worldId: scope.worldId,
        }),
        { module: STARDEW_GAME_INTEGRATION_ADAPTER },
      );
      const binding = await receiptBackedBinding(launch);
      let materialized:
        | Awaited<ReturnType<ReturnType<typeof createHostGameRuntimeMaterializer>["materializeEnter"]>>
        | undefined;
      try {
        materialized = await binding.executeWithBinding((bindingToken) =>
          withConsumedBindingExecution(bindingToken, (execution) =>
            createHostGameRuntimeMaterializer().materializeEnter(
              reserveGameRuntimeMaterialization(execution),
              enterPermit(execution),
            ),
          ),
        );
        const tools = observeMaterializedProductionRuntimeForTest(materialized).session.agent.state.tools;
        const execute = async (name: string, params: Record<string, unknown>) => {
          const tool = tools.find((current) => current.name === name);
          assert.ok(tool, `missing ${name}`);
          const result = await tool.execute("plan-work", params, new AbortController().signal, () => undefined);
          return result.details as Record<string, unknown>;
        };
        const submissions = () => requests.filter((request) => request.type === "program_submit");

        const planned = await execute("stardew_plan_work", {
          script: "builder.move_to_tile({ x: snapshot.tile.x + 1, y: snapshot.tile.y });",
        });
        const [submittedByPlan] = submissions();
        assert.ok(submittedByPlan, "an accepted plan reaches the Mod");
        const payload = submittedByPlan.payload as { programId: string; nodes: readonly never[] };
        // The compiled program is one the real Body Program validator accepts.
        assert.equal(validateBodyProgramCandidateRequest(submittedByPlan.payload as Record<string, unknown>), null);
        // The Mod received the program the script compiled: one node, built from the snapshot the tool read.
        assert.deepEqual(payload.nodes, [
          {
            nodeId: "n01",
            actionId: "move_to_tile",
            arguments: { x: { type: "integer", canonicalValue: "6" }, y: { type: "integer", canonicalValue: "8" } },
            dependsOn: [],
            bindings: {},
          },
        ]);
        assert.equal(payload.programId, planProgramId(1, payload.nodes));
        // The accepted answer, as a caller reads it: the batch is NOT settled (the Mod has just recorded it), and the
        // one node the script wrote is answered at its own index with the state the Mod recorded. The clock is asserted
        // separately - it is a reading, not a constant.
        const { nodes: plannedNodes, ...plannedBatch } = planned as {
          nodes: readonly Record<string, unknown>[];
        } & Record<string, unknown>;
        assert.deepEqual(plannedBatch, {
          accepted: true,
          nodeCount: 1,
          programId: payload.programId,
          submitted: "accepted",
          settled: false,
          remaining: 1,
          // WHAT ARRIVES NEXT, on the answer the model re-reads while deciding whether to wait: the population it is
          // waiting on, that the settlement is its own message, and that one more status read before then is the same
          // picture. Measured `round43`: 29 of 96 turns were status polls over this exact decision.
          settlementNote: planSettlementNote(1),
        });
        assert.deepEqual(
          plannedNodes.map(({ elapsedMs: _clock, ...rest }) => rest),
          [{ index: 0, actionId: "move_to_tile", state: "pending", tile: { x: 6, y: 8 } }],
          "one row per node, at the index the caller wrote it, in the Mod's own state vocabulary",
        );
        assert.equal(typeof plannedNodes[0]?.elapsedMs, "number", "and how long this Host has watched it there");
        // A hand-written program with this same body reaches the Mod as the identical frame: the two tools share one
        // submission, so a plan cannot take a route the raw program tool cannot.
        await execute("stardew_submit_action_program", payload);
        assert.deepEqual(
          submissions().map((request) => request.payload),
          [payload, payload],
          "one submission path, two callers",
        );

        // A builder call with a missing argument answers with the action's own declaration, read straight off the
        // catalog this bridge published: the refusal is the only place the shape is taught now.
        assert.deepEqual(await execute("stardew_plan_work", { script: "builder.move_to_tile({ x: 5 });" }), {
          accepted: false,
          nodeCount: 0,
          reasonCode: "plan_script_missing_argument:move_to_tile.y:integer[non_negative]:snapshot.tile.y",
          actionId: "move_to_tile",
          requiredArguments: [
            { name: "x", type: "integer" },
            { name: "y", type: "integer" },
          ],
          resourceClaims: [],
        });
        // ...and the same declaration is reachable without writing a script, for one action or a whole family.
        assert.deepEqual(await execute("stardew_plan_shape", { actionId: "move_to_tile" }), {
          actions: [
            {
              actionId: "move_to_tile",
              familyId: "movement_navigation",
              lifecycle: "published",
              arguments: [
                { name: "x", type: "integer" },
                { name: "y", type: "integer" },
              ],
              outputFacts: [],
              resourceClaims: [],
              // This bridge published no tool claim for the action, so the answer says the surface is silent rather
              // than leaving the field out and letting the companion read silence as "no tool involved".
              toolRequirement: { declared: false, reasonCode: "tool_requirement_undeclared" },
              // The same shape for the other pre-execution precondition: where the body has to stand. `57cd0af0` made
              // it declarable, and an action whose definitions do not declare it says so instead of staying silent.
              approachRequirement: { declared: false, reasonCode: "approach_requirement_undeclared" },
            },
          ],
          // What a `slot` argument holds, answered once per shape rather than left to tool order.
          toolSlotMeaning: PLAN_TOOL_SLOT_MEANING,
        });
        assert.deepEqual(await execute("stardew_plan_shape", { family: "brewing" }), {
          reasonCode: "plan_shape_unknown_family:brewing",
          legalFamilies: ["movement_navigation"],
        });
        assert.equal(submissions().length, 2, "reading a shape submits nothing");

        // A plan of seventeen nodes is refused by name and nothing is submitted.
        const refusedAtCap = await execute("stardew_plan_work", {
          script: "for (let index = 0; index < 17; index++) builder.move_to_tile({ x: 5 + index, y: 8 });",
        });
        assert.deepEqual(refusedAtCap, { accepted: false, nodeCount: 0, reasonCode: "plan_cap_exceeded:17" });
        // A script that awaits is refused by the name of what it reached for, before it runs a single node.
        const refusedAtAwait = await execute("stardew_plan_work", {
          script: "await builder.move_to_tile({ x: 5, y: 8 });",
        });
        assert.deepEqual(refusedAtAwait, {
          accepted: false,
          nodeCount: 0,
          reasonCode: "plan_script_uses_forbidden:await",
        });
        assert.equal(submissions().length, 2, "a refused plan submits nothing");
      } finally {
        await materialized?.close();
        await binding.close();
      }
    },
    (request, socket) => {
      requests.push(request);
      if (request.type !== "program_submit") return;
      socket.write(
        frame({
          ...request,
          messageId: "mod_program_submit_plan_work",
          type: "program_submit_result",
          payload: {
            code: "accepted",
            verification: { accepted: true, catalogRevision: 1, diagnostics: [] },
            snapshot: {
              programId: (request.payload as { programId: string }).programId,
              state: "active",
              catalogRevision: 1,
              stopEpoch: 0,
              eventHighWater: 0,
              // The Mod records the candidate's own nodes as `pending`, which is what a just-accepted program looks
              // like: the answer is read against real journal rows, not against an empty list.
              nodes: (request.payload as { nodes: readonly { nodeId: string }[] }).nodes.map((node) => ({
                nodeId: node.nodeId,
                state: "pending",
                nodeAttempt: 0,
                admissionAttempt: 0,
              })),
            },
          },
        }),
      );
      return true;
    },
    {
      registrations: [
        {
          actionId: "move_to_tile",
          familyId: "movement_navigation",
          identityVersion: 1,
          lifecycle: "published",
          kind: "execution",
          descriptor: { argumentSchema: { x: { type: "integer" }, y: { type: "integer" } } },
        },
      ],
    },
  );
});

/**
 * ONE `plan_work` CALL ANSWERS THE BATCH'S PER-NODE STATE, IN THE ORDER THE CALLER WROTE THE NODES.
 *
 * <p>
 * The gap this pins was reported in the companion's own words, from a forked session: `plan_work` answered
 * `{"accepted":true,"settled":false,"nodeCount":4}`, which says the batch was taken and nothing about what became of
 * each step. The outcome existed, scattered across later `execution_receipt` facts and paired by `executionId`, so a
 * caller whose third step was refused could tell neither "still running" from "never ran" - it re-submitted an
 * identical `sleep({})` three times in twenty seconds, and its average batch fell 8.00 -> 5.04 -> 4.47 over one run.
 * </p>
 *
 * <p>
 * WHAT THE JOIN IS MADE OF: the Mod's status snapshot carries `nodes[].nodeId`, and `OpenBodyProgramJournalAuthority`
 * accepts the candidate's own ids verbatim (`Accept` -> `new VerifiedBodyProgramNode(node.NodeId, ...)`), so the id the
 * Host compiled is the id the journal reports. This test therefore answers the snapshot in REVERSE order: an answer
 * built from array position would number the rows backwards and fail below.
 * </p>
 */
test("a plan answers each node's own state by index, so a refusal cannot be read as a success", async () => {
  const requests: BridgeMessage[] = [];
  /** What the Mod's journal holds at the current stage, stage by stage. */
  let program: { outcome: string; states: readonly Readonly<{ state: string; code?: string }>[] } = {
    outcome: "active",
    states: [],
  };
  let scriptNodes: readonly Readonly<{ nodeId: string; actionId: string }>[] = [];
  let submitCode = "accepted";
  const modSnapshot = (programId: string) => ({
    programId,
    state: program.outcome,
    catalogRevision: 1,
    stopEpoch: 0,
    eventHighWater: 0,
    // REVERSED on purpose: a reader that numbers these rows by position reads `n04` as index 0.
    nodes: [...scriptNodes]
      .map((node, index) => {
        const row = program.states[index] as Readonly<{ state: string; code?: string }>;
        return {
          nodeId: node.nodeId,
          // The wire now names each node's action: it is what lets a reader that lost its `programId` still say what it did.
          actionId: node.actionId,
          state: row.state,
          nodeAttempt: 1,
          admissionAttempt: 1,
          ...(row.code === undefined ? {} : { rejectionCode: row.code }),
        };
      })
      .reverse(),
  });
  await withHelloAck(
    "farmhand_client",
    generation,
    async (pipeName) => {
      const client = await LocalStardewBridgeClient.connectFarmhand(
        scope,
        pipeName,
        token,
        generation,
        Date.now() + 5_000,
        testAdapter,
      );
      const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
        client,
        Object.freeze({
          playerId: "player_attestation",
          companionId: scope.companionId,
          continuityId,
          saveId: scope.saveId,
          worldId: scope.worldId,
        }),
        { module: STARDEW_GAME_INTEGRATION_ADAPTER },
      );
      const binding = await receiptBackedBinding(launch);
      let materialized:
        | Awaited<ReturnType<ReturnType<typeof createHostGameRuntimeMaterializer>["materializeEnter"]>>
        | undefined;
      try {
        materialized = await binding.executeWithBinding((bindingToken) =>
          withConsumedBindingExecution(bindingToken, (execution) =>
            createHostGameRuntimeMaterializer().materializeEnter(
              reserveGameRuntimeMaterialization(execution),
              enterPermit(execution),
            ),
          ),
        );
        const tools = observeMaterializedProductionRuntimeForTest(materialized).session.agent.state.tools;
        const execute = async (name: string, params: Record<string, unknown>) => {
          const tool = tools.find((current) => current.name === name);
          assert.ok(tool, `missing ${name}`);
          const result = await tool.execute("plan-work", params, new AbortController().signal, () => undefined);
          return result.details as Record<string, unknown>;
        };
        // Four steps the caller wrote, and the batch it expects back.
        const script = ["5", "6", "7", "8"].map((x) => `builder.move_to_tile({ x: ${x}, y: 8 });`).join("\n");

        // (1) Accepted, and the THIRD step refused at admission: `actor_held_by_modal` is the code the companion in the
        // measured session only learned from a later fact batch.
        program.outcome = "failed";
        program.states = [
          { state: "succeeded" },
          { state: "succeeded" },
          { state: "rejected", code: "actor_held_by_modal" },
          { state: "succeeded" },
        ];
        const answered = await execute("stardew_plan_work", { script, waitMs: 1_000 });
        assert.deepEqual(
          (answered.nodes as readonly Record<string, unknown>[]).map(({ elapsedMs: _clock, ...rest }) => rest),
          [
            { index: 0, actionId: "move_to_tile", state: "succeeded", tile: { x: 5, y: 8 } },
            { index: 1, actionId: "move_to_tile", state: "succeeded", tile: { x: 6, y: 8 } },
            {
              index: 2,
              actionId: "move_to_tile",
              state: "rejected",
              reasonCode: "actor_held_by_modal",
              tile: { x: 7, y: 8 },
            },
            { index: 3, actionId: "move_to_tile", state: "succeeded", tile: { x: 8, y: 8 } },
          ],
          "every node's own terminal state, at the index the caller wrote it",
        );
        assert.equal(answered.settled, true, "four terminal nodes are a settled batch");
        assert.equal(answered.remaining, 0);
        // A terminal node carries no clock: nothing is still being watched.
        assert.deepEqual(
          (answered.nodes as readonly Record<string, unknown>[]).filter((node) => "elapsedMs" in node),
          [],
          "a node that has stopped is not timed",
        );

        // (2) The same four steps with the second one executing when the bound expires: the answer says HOW MANY are
        // left and how long the running node has been running, and claims no terminal state for any of them.
        program.outcome = "active";
        program.states = [{ state: "succeeded" }, { state: "running" }, { state: "pending" }, { state: "pending" }];
        const running = await execute("stardew_plan_work", { script, waitMs: 250 });
        assert.equal(running.settled, false, "a batch still in the world has not settled");
        assert.equal(running.remaining, 3, "and says how many steps are still to get through");
        const runningNodes = running.nodes as readonly Record<string, unknown>[];
        assert.deepEqual(
          runningNodes.map((node) => node.state),
          ["succeeded", "running", "pending", "pending"],
          "each node keeps its own state: nothing is reported as done that is not",
        );
        const clock = runningNodes[1]?.elapsedMs;
        assert.equal(
          typeof clock,
          "number",
          'the node the plan is on is timed, so "still running" is distinguishable from "stopped moving"',
        );
        assert.ok((clock as number) >= 0);
        assert.equal("elapsedMs" in (runningNodes[0] as object), false, "the finished node carries no clock");

        // (3) An identical resubmission: the Mod answers `idempotent` with the journal it already has, so the refusal
        // comes back as a refusal. A caller that read only `accepted` would submit the same work a fourth time.
        program.outcome = "failed";
        program.states = [
          { state: "succeeded" },
          { state: "succeeded" },
          { state: "rejected", code: "actor_held_by_modal" },
          { state: "succeeded" },
        ];
        submitCode = "idempotent";
        const resubmitted = await execute("stardew_plan_work", { script, waitMs: 1_000 });
        assert.equal(resubmitted.accepted, true, "the Mod did accept the program the first time");
        assert.equal(resubmitted.submitted, "idempotent", "and says the second submission was the same program");
        assert.equal((resubmitted.nodes as readonly Record<string, unknown>[])[2]?.state, "rejected");
        assert.equal((resubmitted.nodes as readonly Record<string, unknown>[])[2]?.reasonCode, "actor_held_by_modal");
        assert.equal(resubmitted.remaining, 0);
      } finally {
        await materialized?.close();
        await binding.close();
      }
    },
    (request, socket) => {
      requests.push(request);
      if (request.type === "program_submit") {
        scriptNodes = (request.payload as { nodes: typeof scriptNodes }).nodes;
        socket.write(
          frame({
            ...request,
            messageId: "mod_plan_answer_submit",
            type: "program_submit_result",
            payload: {
              code: submitCode,
              verification: { accepted: true, catalogRevision: 1, diagnostics: [] },
              snapshot: modSnapshot((request.payload as { programId: string }).programId),
            },
          }),
        );
        return true;
      }
      if (request.type === "program_status") {
        socket.write(
          frame({
            ...request,
            messageId: "mod_plan_answer_status",
            type: "program_status_result",
            payload: {
              code: "found",
              snapshot: modSnapshot(request.payload.programId ?? "program_01"),
              programs: null,
              programCount: 1,
            },
          }),
        );
        return true;
      }
    },
    {
      registrations: [
        {
          actionId: "move_to_tile",
          familyId: "movement_navigation",
          identityVersion: 1,
          lifecycle: "published",
          kind: "execution",
          descriptor: { argumentSchema: { x: { type: "integer" }, y: { type: "integer" } } },
        },
      ],
    },
  );
});

/**
 * The plan example is only better than no example if every name in it exists, so the checks below read the names
 * back out of the sources they were taken from: the `Snapshot` type for the family and its entry fields, the
 * published action surface for the action and its argument names.
 */
function snapshotShape(protocol: string): Readonly<{
  all: readonly string[];
  entryOf(family: string): readonly string[];
}> {
  const start = protocol.indexOf("export type Snapshot = Readonly<{");
  assert.notEqual(start, -1, "the Snapshot type is declared in protocol.ts");
  const body = protocol.slice(start + "export type Snapshot = Readonly<{".length);
  let depth = 1;
  let end = body.length;
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "{") depth += 1;
    else if (body[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  const declared = body.slice(0, end);
  return {
    all: [...declared.matchAll(/^ {2}([A-Za-z0-9_]+)\??:/gmu)].map((match) => match[1] as string),
    entryOf(family: string): readonly string[] {
      const at = declared.indexOf(`  ${family}?:`);
      assert.notEqual(at, -1, `${family} is a field of the Snapshot type`);
      const boundary = declared.slice(at + 1).search(/\n {2}[A-Za-z0-9_]+\??:/u);
      const segment = boundary === -1 ? declared.slice(at) : declared.slice(at, at + 1 + boundary);
      return [...new Set([...segment.matchAll(/([A-Za-z0-9_]+)\??:/gu)].map((match) => match[1] as string))].filter(
        (name) => name !== family,
      );
    },
  };
}

test("the Game surface offers one plan tool instead of the flat per-action tools, and a wrong builder name lists the legal ids", async () => {
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  await withHelloAck(
    "farmhand_client",
    generation,
    async (pipeName) => {
      const client = await LocalStardewBridgeClient.connectFarmhand(
        scope,
        pipeName,
        token,
        generation,
        Date.now() + 5_000,
        testAdapter,
      );
      const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
        client,
        Object.freeze({
          playerId: "player_attestation",
          companionId: scope.companionId,
          continuityId,
          saveId: scope.saveId,
          worldId: scope.worldId,
        }),
        { module: STARDEW_GAME_INTEGRATION_ADAPTER },
      );
      const binding = await receiptBackedBinding(launch);
      let materialized:
        | Awaited<ReturnType<ReturnType<typeof createHostGameRuntimeMaterializer>["materializeEnter"]>>
        | undefined;
      try {
        materialized = await binding.executeWithBinding((bindingToken) =>
          withConsumedBindingExecution(bindingToken, (execution) =>
            createHostGameRuntimeMaterializer().materializeEnter(
              reserveGameRuntimeMaterialization(execution),
              enterPermit(execution),
            ),
          ),
        );
        const tools = observeMaterializedProductionRuntimeForTest(materialized).session.agent.state.tools;
        const mounted = tools.map((tool) => tool.name).sort();
        // Nothing on the surface is a per-action tool, and the plan tool, the observation and the stop tool (which is
        // deliberately NOT an action) are all still there.
        assert.deepEqual(
          mounted.filter((name) => testAdapter.actionIdForToolName(name) !== null),
          [],
          "no mounted tool is a per-action tool",
        );
        assert.ok(mounted.includes("stardew_plan_work"), "the plan tool is mounted");
        assert.ok(mounted.includes("stardew_observe"), "the observation stays");
        assert.ok(mounted.includes("stardew_stop_action"), "the stop tool is not an action and stays");
        const plan = tools.find((tool) => tool.name === "stardew_plan_work");
        assert.ok(plan);

        // The example a model copies, checked name by name against the type and the published surface.
        const protocol = await readFile(join(repositoryRoot, "host", "src", "protocol.ts"), "utf8");
        const shape = snapshotShape(protocol);
        const surface = JSON.parse(
          await readFile(
            join(repositoryRoot, "integrations/stardew/action-development/contracts/generated/action-surface.v1.json"),
            "utf8",
          ),
        ) as { actions: readonly { actionId: string; argumentSchema?: Record<string, { type: string }> }[] };
        const example = plan.description.slice(plan.description.indexOf("for (const"));
        const [loopLine, callLine] = example.split("\n");
        const loop = /for \(const ([A-Za-z0-9_$]+) of snapshot\.([A-Za-z0-9_]+)\) \{/u.exec(loopLine ?? "");
        assert.ok(loop, "the example iterates one target family");
        const variable = loop[1] as string;
        const family = loop[2] as string;
        assert.ok(shape.all.includes(family), `the example iterates ${family}, a field the Snapshot type declares`);
        const call = new RegExp(`builder\\.([a-z0-9_]+)\\(\\{ (.*) \\}\\);`, "u").exec(callLine ?? "");
        assert.ok(call, "the example makes one builder call");
        const action = surface.actions.find((entry) => entry.actionId === call[1]);
        assert.ok(action, `${String(call[1])} is an action the surface publishes`);
        const argumentNames = [...(call[2] as string).matchAll(/([A-Za-z0-9_]+):/gu)].map((match) => match[1]);
        assert.deepEqual(argumentNames, Object.keys(action.argumentSchema ?? {}));
        const targetFields = [
          ...new Set(
            [...(call[2] as string).matchAll(new RegExp(`\\b${variable}\\.([A-Za-z0-9_]+)`, "gu"))].map(
              (match) => match[1],
            ),
          ),
        ];
        assert.ok(targetFields.length > 0, "every argument value in the example comes from the target entry");
        for (const field of targetFields)
          assert.ok(shape.entryOf(family).includes(field as string), `${family} entries carry ${String(field)}`);

        // A name the builder does not have answers with the ids it does have, so a typo teaches.
        const refused = await plan.execute(
          "plan-unknown-action",
          { script: "builder.brew_potion({});" },
          new AbortController().signal,
          () => undefined,
        );
        const details = refused.details as { reasonCode?: string; legalActionIds?: readonly string[] };
        assert.equal(details.reasonCode, "plan_script_unknown_action:brew_potion");
        assert.deepEqual(details.legalActionIds, ["move_to_tile"]);
      } finally {
        await materialized?.close();
        await binding.close();
      }
    },
    undefined,
    {
      registrations: [
        {
          actionId: "move_to_tile",
          familyId: "movement_navigation",
          identityVersion: 1,
          lifecycle: "published",
          kind: "execution",
          descriptor: { argumentSchema: { x: { type: "integer" }, y: { type: "integer" } } },
        },
      ],
    },
  );
});

/**
 * The falsifier for the surface the live run actually mounts. The materializer composes the fixed plan tools and
 * `createRuntimeWithFixedToolsCore` is the one composition that mounts an adapter's tools onto that session, so the
 * assertion is made there, over the Mod's whole published catalog instead of a one-action fixture: no executable
 * action has a per-action tool on the mounted surface, the read-only navigation tools stay as observation, and the
 * plan builder still carries every executable action.
 */
test("over the published catalog the mounted Game surface carries no per-action tool, and the plan builder carries every executable action", async () => {
  const registrations = publishedSurfaceRegistrations();
  const executableActionIds = registrations
    .filter((registration) => registration.kind === "execution")
    .map((registration) => registration.actionId);
  await withHelloAck(
    "farmhand_client",
    generation,
    async (pipeName) => {
      const client = await LocalStardewBridgeClient.connectFarmhand(
        scope,
        pipeName,
        token,
        generation,
        Date.now() + 5_000,
        testAdapter,
      );
      const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
        client,
        Object.freeze({
          playerId: "player_attestation",
          companionId: scope.companionId,
          continuityId,
          saveId: scope.saveId,
          worldId: scope.worldId,
        }),
        { module: STARDEW_GAME_INTEGRATION_ADAPTER },
      );
      const binding = await receiptBackedBinding(launch);
      let materialized:
        | Awaited<ReturnType<ReturnType<typeof createHostGameRuntimeMaterializer>["materializeEnter"]>>
        | undefined;
      try {
        materialized = await binding.executeWithBinding((bindingToken) =>
          withConsumedBindingExecution(bindingToken, (execution) =>
            createHostGameRuntimeMaterializer().materializeEnter(
              reserveGameRuntimeMaterialization(execution),
              enterPermit(execution),
            ),
          ),
        );
        const mounted = observeMaterializedProductionRuntimeForTest(materialized).session.agent.state.tools.map(
          (tool) => tool.name,
        );
        const perActionTools = mounted.filter((name) =>
          executableActionIds.some((actionId) => `stardew_${actionId}` === name),
        );
        assert.deepEqual(perActionTools, [], "no executable action has a per-action tool on the mounted surface");
        assert.ok(mounted.includes("stardew_plan_work"), "the plan tool is mounted");
        assert.ok(mounted.includes("stardew_observe"), "observation is mounted");
        assert.ok(mounted.includes("stardew_stop_action"), "the stop tool is mounted and is not an action");
        // The read-only actions are observation, not dispatch, and they stay: closing the flat surface must not close
        // what the companion reads the world map with.
        for (const name of ["stardew_inspect_world_map", "stardew_find_destination"])
          assert.ok(mounted.includes(name), `${name} stays as observation`);
        // The capability did not leave with the flat tools: every executable action the Mod publishes is a builder
        // method, so the plan tool is the whole action surface rather than one entry point beside it.
        assert.deepEqual(
          planActionsFromRegistrations(registrations)
            .map((action) => action.actionId)
            .sort(),
          [...executableActionIds].sort(),
          "the plan builder carries every executable published action",
        );
      } finally {
        await materialized?.close();
        await binding.close();
      }
    },
    undefined,
    { registrations, capabilities: executableActionIds },
  );
});

test("program readers mount only once a submission is recorded, because before that they can only be read as empty", async () => {
  const requests: BridgeMessage[] = [];
  await withHelloAck(
    "farmhand_client",
    generation,
    async (pipeName) => {
      const client = await LocalStardewBridgeClient.connectFarmhand(
        scope,
        pipeName,
        token,
        generation,
        Date.now() + 5_000,
        testAdapter,
      );
      const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
        client,
        Object.freeze({
          playerId: "player_attestation",
          companionId: scope.companionId,
          continuityId,
          saveId: scope.saveId,
          worldId: scope.worldId,
        }),
        { module: STARDEW_GAME_INTEGRATION_ADAPTER },
      );
      const binding = await receiptBackedBinding(launch);
      let materialized:
        | Awaited<ReturnType<ReturnType<typeof createHostGameRuntimeMaterializer>["materializeEnter"]>>
        | undefined;
      try {
        materialized = await binding.executeWithBinding((bindingToken) =>
          withConsumedBindingExecution(bindingToken, (execution) =>
            createHostGameRuntimeMaterializer().materializeEnter(
              reserveGameRuntimeMaterialization(execution),
              enterPermit(execution),
            ),
          ),
        );
        const mounted = () =>
          observeMaterializedProductionRuntimeForTest(materialized!).session.agent.state.tools.map((tool) => tool.name);
        const execute = async (name: string, params: Record<string, unknown>) => {
          const tool = observeMaterializedProductionRuntimeForTest(materialized!).session.agent.state.tools.find(
            (current) => current.name === name,
          );
          assert.ok(tool, `missing ${name}`);
          const result = await tool.execute("reader-mount", params, new AbortController().signal, () => undefined);
          return result.details as { code?: string };
        };
        assert.ok(mounted().includes("stardew_submit_action_program"));
        assert.equal(mounted().includes("stardew_action_program_status"), false);
        assert.equal(mounted().includes("stardew_action_program_events"), false);
        // A refused candidate records nothing, so it mounts nothing to read.
        const plan = (programId: string) => ({
          programId,
          nodes: [
            {
              nodeId: "node_01",
              actionId: "move_to_tile",
              arguments: {},
              dependsOn: [],
              bindings: {},
            },
          ],
        });
        assert.equal((await execute("stardew_submit_action_program", plan("not_recorded"))).code, "rejected");
        assert.equal(mounted().includes("stardew_action_program_status"), false);
        assert.equal(mounted().includes("stardew_action_program_events"), false);
        assert.equal((await execute("stardew_submit_action_program", plan("farm_morning"))).code, "accepted");
        assert.ok(mounted().includes("stardew_action_program_status"));
        assert.ok(mounted().includes("stardew_action_program_events"));
        assert.equal((await execute("stardew_action_program_status", { programId: "farm_morning" })).code, "found");
        assert.deepEqual(
          requests.filter((request) => request.type.startsWith("program_")).map((request) => request.type),
          ["program_submit", "program_submit", "program_status"],
        );
      } finally {
        await materialized?.close();
        await binding.close();
      }
    },
    (request, socket) => {
      requests.push(request);
      if (request.type !== "program_submit") return;
      const accepted = request.payload.programId === "farm_morning";
      socket.write(
        frame({
          ...request,
          messageId: "mod_program_submit_reader_mount",
          type: "program_submit_result",
          payload: accepted
            ? {
                code: "accepted",
                verification: { accepted: true, catalogRevision: 1, diagnostics: [] },
                snapshot: {
                  programId: request.payload.programId,
                  state: "active",
                  catalogRevision: 1,
                  stopEpoch: 0,
                  eventHighWater: 0,
                  nodes: [],
                },
              }
            : {
                code: "rejected",
                verification: {
                  accepted: false,
                  catalogRevision: 1,
                  diagnostics: [
                    {
                      severity: "error",
                      code: "policy_denied",
                      nodeId: null,
                      path: "program",
                      message: "policy_denied",
                    },
                  ],
                },
                snapshot: null,
              },
        }),
      );
      return true;
    },
  );
});

test("attested fixed body-program closures recheck restrictive live policy without emitting a program frame", async () => {
  const requests: BridgeMessage[] = [];
  let socket!: Socket;
  let catalogUpdatePublished = false;
  let resolveCatalogRefreshRequested!: () => void;
  const catalogRefreshRequested = new Promise<void>((resolve) => {
    resolveCatalogRefreshRequested = resolve;
  });
  await withHelloAck(
    "farmhand_client",
    generation,
    async (pipeName) => {
      const client = await LocalStardewBridgeClient.connectFarmhand(
        scope,
        pipeName,
        token,
        generation,
        Date.now() + 5_000,
        testAdapter,
      );
      const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
        client,
        Object.freeze({
          playerId: "player_attestation",
          companionId: scope.companionId,
          continuityId,
          saveId: scope.saveId,
          worldId: scope.worldId,
        }),
        { module: STARDEW_GAME_INTEGRATION_ADAPTER },
      );
      const binding = await receiptBackedBinding(launch);
      let materialized:
        | Awaited<ReturnType<ReturnType<typeof createHostGameRuntimeMaterializer>["materializeEnter"]>>
        | undefined;
      try {
        materialized = await binding.executeWithBinding((bindingToken) =>
          withConsumedBindingExecution(bindingToken, (execution) =>
            createHostGameRuntimeMaterializer().materializeEnter(
              reserveGameRuntimeMaterialization(execution),
              enterPermit(execution),
            ),
          ),
        );
        const tools = observeMaterializedProductionRuntimeForTest(materialized).session.agent.state.tools;
        const submit = tools.find((current) => current.name === "stardew_submit_action_program");
        const verify = tools.find((current) => current.name === "stardew_verify_action_program");
        assert.ok(submit);
        assert.equal(verify, undefined);
        catalogUpdatePublished = true;
        socket.write(
          frame({
            protocolVersion: 1,
            messageId: "catalog_update_attestation",
            correlationId: "catalog_update_attestation",
            timestampMs: Date.now(),
            scope,
            type: "catalog_update",
            payload: {
              catalogRevision: 1,
              policyIdentity: { value: "abcdef0123456789abcdef0123456789", capabilityRevision: 2 },
              enabledActionIds: ["move_to_tile"],
            },
          } satisfies BridgeMessage),
        );
        await catalogRefreshRequested;
        for (let attempt = 0; attempt < 20 && client.state.snapshot?.revision !== 2; attempt++) await delay(5);
        assert.equal(client.state.catalogRevision, 1);
        assert.deepEqual(client.state.enabledActionIds, ["move_to_tile"]);
        assert.equal(client.state.snapshot?.catalogRevision, 1);
        await until(() => client.state.snapshot?.revision === 2, "successor_snapshot_not_admitted");
        const successorState = STARDEW_GAME_INTEGRATION_ADAPTER.readState(launch.connection);
        assert.equal(successorState.catalogRevision, 1);
        assert.equal(successorState.capabilityRevision, 2);
        assert.deepEqual(successorState.policyIdentity, {
          value: "abcdef0123456789abcdef0123456789",
          capabilityRevision: 2,
        });
        await assert.rejects(
          () =>
            submit.execute(
              "policy_recheck_submit",
              {
                programId: "program_02",
                nodes: [{ nodeId: "node_02", actionId: "move_to_tile", arguments: {}, dependsOn: [], bindings: {} }],
              },
              new AbortController().signal,
              () => undefined,
            ),
          /body_program_preflight_rejected/,
        );
        assert.equal(requests.filter((request) => request.type === "program_submit").length, 0);
      } finally {
        await materialized?.close();
        await binding.close();
      }
    },
    (request, currentSocket) => {
      requests.push(request);
      socket = currentSocket;
      if (catalogUpdatePublished && request.type === "observe_request") {
        currentSocket.write(
          frame({
            ...request,
            messageId: "mod_catalog_refresh_attestation",
            type: "snapshot",
            payload: {
              revision: 2,
              location: "Farm",
              tile: { x: 5, y: 8 },
              stamina: 250,
              exhausted: false,
              health: 100,
              actionable: true,
              capabilities: ["move_to_tile"],
              catalogRevision: 1,
              enabledActionIds: ["move_to_tile"],
              presentationLocale: "en-US",
              timeOfDay: 600,
              dayOfMonth: 1,
              seasonIndex: 0,
              year: 1,
              activeExecution: null,
            },
          }),
        );
        resolveCatalogRefreshRequested();
        return true;
      }
    },
  );
});

test("attested status and events each emit one frame without preflight, cursor cache, or auto-page", async () => {
  const requests: BridgeMessage[] = [];
  await withHelloAck(
    "farmhand_client",
    generation,
    async (pipeName) => {
      const client = await LocalStardewBridgeClient.connectFarmhand(
        scope,
        pipeName,
        token,
        generation,
        Date.now() + 5_000,
        testAdapter,
      );
      const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
        client,
        Object.freeze({
          playerId: "player_attestation",
          companionId: scope.companionId,
          continuityId,
          saveId: scope.saveId,
          worldId: scope.worldId,
        }),
        { module: STARDEW_GAME_INTEGRATION_ADAPTER },
      );
      const binding = await receiptBackedBinding(launch);
      let materialized:
        | Awaited<ReturnType<ReturnType<typeof createHostGameRuntimeMaterializer>["materializeEnter"]>>
        | undefined;
      try {
        materialized = await binding.executeWithBinding((bindingToken) =>
          withConsumedBindingExecution(bindingToken, (execution) =>
            createHostGameRuntimeMaterializer().materializeEnter(
              reserveGameRuntimeMaterialization(execution),
              enterPermit(execution),
            ),
          ),
        );
        const mounted = () => observeMaterializedProductionRuntimeForTest(materialized!).session.agent.state.tools;
        const observeRequestsAtMaterialization = requests.filter(
          (request) => request.type === "observe_request",
        ).length;
        const execute = (name: string, params: Record<string, unknown>) =>
          mounted()
            .find((tool) => tool.name === name)!
            .execute("single_frame", params, new AbortController().signal, () => undefined);
        // The readers are mounted by the first recorded program, so one accepted submission comes first.
        await execute("stardew_submit_action_program", {
          programId: "program_03",
          nodes: [{ nodeId: "node_03", actionId: "move_to_tile", arguments: {}, dependsOn: [], bindings: {} }],
        });
        await execute("stardew_action_program_status", { programId: "program_03" });
        await execute("stardew_action_program_events", { programId: "program_03", cursor: 11, pageSize: 1 });
        assert.deepEqual(
          requests.filter((request) => request.type.startsWith("program_")).map((request) => request.type),
          ["program_submit", "program_status", "program_events"],
        );
        assert.equal(
          requests.filter((request) => request.type === "observe_request").length,
          observeRequestsAtMaterialization,
        );
      } finally {
        await materialized?.close();
        await binding.close();
      }
    },
    (request, socket) => {
      requests.push(request);
      if (request.type !== "program_submit") return;
      socket.write(
        frame({
          ...request,
          messageId: "mod_program_submit_one_frame",
          type: "program_submit_result",
          payload: {
            code: "accepted",
            verification: { accepted: true, catalogRevision: 1, diagnostics: [] },
            snapshot: {
              programId: request.payload.programId,
              state: "active",
              catalogRevision: 1,
              stopEpoch: 0,
              eventHighWater: 0,
              nodes: [],
            },
          },
        }),
      );
      return true;
    },
  );
});

test("attested submit timeout emits exactly one program frame and is not retried", { timeout: 15_000 }, async () => {
  const requests: BridgeMessage[] = [];
  await withHelloAck(
    "farmhand_client",
    generation,
    async (pipeName) => {
      const client = await LocalStardewBridgeClient.connectFarmhand(
        scope,
        pipeName,
        token,
        generation,
        Date.now() + 10_000,
        testAdapter,
      );
      const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
        client,
        Object.freeze({
          playerId: "player_attestation",
          companionId: scope.companionId,
          continuityId,
          saveId: scope.saveId,
          worldId: scope.worldId,
        }),
        { module: STARDEW_GAME_INTEGRATION_ADAPTER },
      );
      const binding = await receiptBackedBinding(launch);
      let materialized:
        | Awaited<ReturnType<ReturnType<typeof createHostGameRuntimeMaterializer>["materializeEnter"]>>
        | undefined;
      try {
        materialized = await binding.executeWithBinding((bindingToken) =>
          withConsumedBindingExecution(bindingToken, (execution) =>
            createHostGameRuntimeMaterializer().materializeEnter(
              reserveGameRuntimeMaterialization(execution),
              enterPermit(execution),
            ),
          ),
        );
        const submit = observeMaterializedProductionRuntimeForTest(materialized).session.agent.state.tools.find(
          (tool) => tool.name === "stardew_submit_action_program",
        )!;
        await assert.rejects(
          () =>
            submit.execute(
              "submit_timeout",
              {
                programId: "program_04",
                nodes: [{ nodeId: "node_04", actionId: "move_to_tile", arguments: {}, dependsOn: [], bindings: {} }],
              },
              new AbortController().signal,
              () => undefined,
            ),
          /bridge_response_timeout/,
        );
        assert.equal(requests.filter((request) => request.type === "program_submit").length, 1);
      } finally {
        await materialized?.close();
        await binding.close();
      }
    },
    (request) => {
      requests.push(request);
      // Withhold only the submit response; the default fixture path remains
      // available for every other request and transport cleanup.
      return request.type === "program_submit";
    },
  );
});

/**
 * The wait's own news, proven through the real tool, socket and Mod-shape response rather than the unit seam.
 *
 * Measured 2026-10-28 (`round4`): four consecutive 30 s waits on `plan_273` each returned `eventHighWater: 288` with
 * `n03` running, and the caller waited again. The tool has to say that the plan did not move, so the difference
 * between patience and blindness reaches the model that decides whether to wait once more.
 */
test("an expired wait reports whether the plan moved, through the real status tool", { timeout: 15_000 }, async () => {
  const requests: BridgeMessage[] = [];
  // The Mod's answer moves once, AFTER the two reads the tool makes before it starts waiting: the caller's own read and
  // the staleness re-read (`program-event-delivery.ts`). Landing the movement on the first of those put it behind the
  // wait's starting point, so the wait saw a frozen plan and `snapshotChanged` was false - the movement has to land on
  // a read the WAIT makes for the wait to be able to report it.
  let statusReads = 0;
  await withHelloAck(
    "farmhand_client",
    generation,
    async (pipeName) => {
      const client = await LocalStardewBridgeClient.connectFarmhand(
        scope,
        pipeName,
        token,
        generation,
        Date.now() + 10_000,
        testAdapter,
      );
      const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
        client,
        Object.freeze({
          playerId: "player_attestation",
          companionId: scope.companionId,
          continuityId,
          saveId: scope.saveId,
          worldId: scope.worldId,
        }),
        { module: STARDEW_GAME_INTEGRATION_ADAPTER },
      );
      const binding = await receiptBackedBinding(launch);
      let materialized:
        | Awaited<ReturnType<ReturnType<typeof createHostGameRuntimeMaterializer>["materializeEnter"]>>
        | undefined;
      try {
        materialized = await binding.executeWithBinding((bindingToken) =>
          withConsumedBindingExecution(bindingToken, (execution) =>
            createHostGameRuntimeMaterializer().materializeEnter(
              reserveGameRuntimeMaterialization(execution),
              enterPermit(execution),
            ),
          ),
        );
        const tools = () => observeMaterializedProductionRuntimeForTest(materialized!).session.agent.state.tools;
        const execute = async (name: string, params: Record<string, unknown>) =>
          (
            await tools()
              .find((tool) => tool.name === name)!
              .execute("wait_outcome", params, new AbortController().signal, () => undefined)
          ).details as {
            code?: string;
            waited?: {
              terminality: "terminal" | "active" | "unknown";
              unreadable: string | null;
              snapshotChanged: boolean;
            };
          };
        // The readers mount on a recorded submission, so one accepted program comes first.
        await execute("stardew_submit_action_program", {
          programId: "program_06",
          nodes: [{ nodeId: "node_06", actionId: "move_to_tile", arguments: {}, dependsOn: [], bindings: {} }],
        });
        // A short wait, not 30 s: the fact under test is WHICH answer comes back, and the deadline is the unit test's.
        const advanced = await execute("stardew_action_program_status", { programId: "program_06", waitMs: 400 });
        assert.equal(advanced.code, "found");
        assert.equal(
          advanced.waited?.terminality,
          "active",
          "the fixture never settles, so the wait expired on a plan still running",
        );
        assert.equal(advanced.waited?.snapshotChanged, true, "a node moved while the call waited");
      } finally {
        await materialized?.close();
        await binding.close();
      }
    },
    (request, socket) => {
      requests.push(request);
      if (request.type !== "program_submit" && request.type !== "program_status") return;
      const programId = (request.payload as { programId: string }).programId;
      if (request.type === "program_submit")
        socket.write(
          frame({
            ...request,
            messageId: "mod_program_submit_wait_outcome",
            type: "program_submit_result",
            payload: {
              code: "accepted",
              verification: { accepted: true, catalogRevision: 1, diagnostics: [] },
              snapshot: {
                programId,
                state: "active",
                catalogRevision: 1,
                stopEpoch: 0,
                eventHighWater: 0,
                nodes: [
                  {
                    nodeId: "node_06",
                    actionId: "move_to_tile",
                    state: "running",
                    nodeAttempt: 1,
                    admissionAttempt: 1,
                  },
                ],
              },
            },
          }),
        );
      else {
        statusReads += 1;
        socket.write(
          frame({
            ...request,
            messageId: "mod_program_status_wait_outcome",
            type: "program_status_result",
            payload: {
              code: "found",
              snapshot: {
                programId,
                state: "active",
                catalogRevision: 1,
                stopEpoch: 0,
                eventHighWater: 0,
                nodes: [
                  {
                    nodeId: "node_06",
                    actionId: "move_to_tile",
                    state: statusReads <= 2 ? "running" : "succeeded",
                    nodeAttempt: 1,
                    admissionAttempt: 1,
                  },
                ],
              },
              programs: null,
              programCount: 1,
            },
          }),
        );
      }
      return true;
    },
  );
});

/**
 * `progress` exists because the result used to say only which nodes were in which state (`round18`): 65 status calls
 * spent 281 s of a 24-minute run, the longest asking for the whole 30,000 ms bound, because nothing in the answer told
 * the caller how much work was left or whether the node in front of it was moving. This reads the real tool rather than
 * the helper, because the field is only worth anything if it reaches the model.
 */
test(
  "a status call for a program with work remaining reports that work, through the real status tool",
  { timeout: 15_000 },
  async () => {
    await withHelloAck(
      "farmhand_client",
      generation,
      async (pipeName) => {
        const client = await LocalStardewBridgeClient.connectFarmhand(
          scope,
          pipeName,
          token,
          generation,
          Date.now() + 10_000,
          testAdapter,
        );
        const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
          client,
          Object.freeze({
            playerId: "player_attestation",
            companionId: scope.companionId,
            continuityId,
            saveId: scope.saveId,
            worldId: scope.worldId,
          }),
          { module: STARDEW_GAME_INTEGRATION_ADAPTER },
        );
        const binding = await receiptBackedBinding(launch);
        let materialized:
          | Awaited<ReturnType<ReturnType<typeof createHostGameRuntimeMaterializer>["materializeEnter"]>>
          | undefined;
        try {
          materialized = await binding.executeWithBinding((bindingToken) =>
            withConsumedBindingExecution(bindingToken, (execution) =>
              createHostGameRuntimeMaterializer().materializeEnter(
                reserveGameRuntimeMaterialization(execution),
                enterPermit(execution),
              ),
            ),
          );
          const tools = () => observeMaterializedProductionRuntimeForTest(materialized!).session.agent.state.tools;
          const execute = async (name: string, params: Record<string, unknown>) =>
            (
              await tools()
                .find((tool) => tool.name === name)!
                .execute("status_progress", params, new AbortController().signal, () => undefined)
            ).details as {
              code?: string;
              progress?: {
                total: number;
                settled: number;
                remaining: number;
                running: number;
                queued: number;
                current: { nodeId: string; state: string; observedInStateMs: number } | null;
              };
            };
          // The readers mount on a recorded submission, so one accepted program comes first.
          await execute("stardew_submit_action_program", {
            programId: "program_07",
            nodes: [{ nodeId: "node_07", actionId: "move_to_tile", arguments: {}, dependsOn: [], bindings: {} }],
          });
          // No `waitMs`: the point is that a plain read is already enough to decide whether waiting is worth it.
          const status = await execute("stardew_action_program_status", { programId: "program_07" });
          assert.equal(status.code, "found");
          assert.equal(status.progress?.total, 4);
          assert.equal(status.progress?.settled, 1);
          assert.equal(status.progress?.remaining, 3, "three of four nodes are still to run");
          assert.equal(status.progress?.running, 1, "one is dispatched with its receipt owed");
          assert.equal(status.progress?.queued, 2, "two have not started");
          assert.equal(status.progress?.current?.nodeId, "node_b");
          assert.equal(status.progress?.current?.state, "running");
          const observed = status.progress?.current?.observedInStateMs ?? -1;
          assert.ok(observed >= 0 && observed < 5_000, `first observation of the node reported ${String(observed)} ms`);
        } finally {
          await materialized?.close();
          await binding.close();
        }
      },
      (request, socket) => {
        if (request.type !== "program_submit" && request.type !== "program_status") return;
        const programId = (request.payload as { programId: string }).programId;
        socket.write(
          frame(
            request.type === "program_submit"
              ? {
                  ...request,
                  messageId: "mod_program_submit_progress",
                  type: "program_submit_result",
                  payload: {
                    code: "accepted",
                    verification: { accepted: true, catalogRevision: 1, diagnostics: [] },
                    snapshot: {
                      programId,
                      state: "active",
                      catalogRevision: 1,
                      stopEpoch: 0,
                      eventHighWater: 0,
                      nodes: [],
                    },
                  },
                }
              : {
                  ...request,
                  messageId: "mod_program_status_progress",
                  type: "program_status_result",
                  payload: {
                    code: "found",
                    snapshot: {
                      programId,
                      state: "active",
                      catalogRevision: 1,
                      stopEpoch: 0,
                      eventHighWater: 1,
                      nodes: [
                        {
                          nodeId: "node_a",
                          actionId: "till_soil",
                          state: "succeeded",
                          nodeAttempt: 1,
                          admissionAttempt: 1,
                        },
                        {
                          nodeId: "node_b",
                          actionId: "till_soil",
                          state: "running",
                          nodeAttempt: 1,
                          admissionAttempt: 1,
                        },
                        {
                          nodeId: "node_c",
                          actionId: "till_soil",
                          state: "pending",
                          nodeAttempt: 0,
                          admissionAttempt: 0,
                        },
                        {
                          nodeId: "node_d",
                          actionId: "till_soil",
                          state: "pending",
                          nodeAttempt: 0,
                          admissionAttempt: 0,
                        },
                      ],
                    },
                    programs: null,
                    programCount: 1,
                  },
                },
          ),
        );
        return true;
      },
    );
  },
);

test("attested fixed closure drains the held request before revocation", async () => {
  const requests: BridgeMessage[] = [];
  let heldStatus: BridgeMessage | undefined;
  let heldSocket: Socket | undefined;
  let resolveStatusSent!: () => void;
  const statusSent = new Promise<void>((resolve) => {
    resolveStatusSent = resolve;
  });
  await withHelloAck(
    "farmhand_client",
    generation,
    async (pipeName) => {
      const client = await LocalStardewBridgeClient.connectFarmhand(
        scope,
        pipeName,
        token,
        generation,
        Date.now() + 5_000,
        testAdapter,
      );
      const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
        client,
        Object.freeze({
          playerId: "player_attestation",
          companionId: scope.companionId,
          continuityId,
          saveId: scope.saveId,
          worldId: scope.worldId,
        }),
        { module: STARDEW_GAME_INTEGRATION_ADAPTER },
      );
      const binding = await receiptBackedBinding(launch);
      let materialized:
        | Awaited<ReturnType<ReturnType<typeof createHostGameRuntimeMaterializer>["materializeEnter"]>>
        | undefined;
      try {
        materialized = await binding.executeWithBinding((bindingToken) =>
          withConsumedBindingExecution(bindingToken, (execution) =>
            createHostGameRuntimeMaterializer().materializeEnter(
              reserveGameRuntimeMaterialization(execution),
              enterPermit(execution),
            ),
          ),
        );
        const runtime = observeMaterializedProductionRuntimeForTest(materialized);
        // The readers exist only after a recorded program, so the drain case records one first.
        const submit = runtime.session.agent.state.tools.find((tool) => tool.name === "stardew_submit_action_program")!;
        await submit.execute(
          "drain_reveal",
          {
            programId: "program_05",
            nodes: [{ nodeId: "node_05", actionId: "move_to_tile", arguments: {}, dependsOn: [], bindings: {} }],
          },
          new AbortController().signal,
          () => undefined,
        );
        const status = runtime.session.agent.state.tools.find((tool) => tool.name === "stardew_action_program_status")!;
        const started = status.execute(
          "draining_status",
          { programId: "program_05" },
          new AbortController().signal,
          () => undefined,
        );
        await Promise.race([
          statusSent,
          delay(1_000).then(() => {
            throw new Error("status_request_not_observed");
          }),
        ]);
        const closing = materialized.close();
        await assert.rejects(
          () =>
            status.execute(
              "revoked_status",
              { programId: "program_05" },
              new AbortController().signal,
              () => undefined,
            ),
          /action_program_runtime_unavailable/,
        );
        assert.equal(requests.filter((request) => request.type === "program_status").length, 1);
        assert.ok(heldStatus);
        heldSocket!.write(
          frame({
            ...heldStatus,
            messageId: "status_drain_attestation",
            type: "program_status_result",
            payload: {
              code: "found",
              snapshot: {
                programId: "program_05",
                state: "active",
                catalogRevision: 1,
                stopEpoch: 0,
                eventHighWater: 0,
                nodes: [],
              },
              programs: null,
              programCount: 1,
            },
          }),
        );
        await started;
        await closing;
        assert.throws(
          () => observeMaterializedProductionRuntimeForTest(materialized!),
          /materialized_runtime_test_observation_unavailable/,
        );
      } finally {
        await materialized?.close();
        await binding.close();
      }
    },
    (request, socket) => {
      requests.push(request);
      if (request.type === "program_submit") {
        socket.write(
          frame({
            ...request,
            messageId: "mod_program_submit_drain_reveal",
            type: "program_submit_result",
            payload: {
              code: "accepted",
              verification: { accepted: true, catalogRevision: 1, diagnostics: [] },
              snapshot: {
                programId: request.payload.programId,
                state: "active",
                catalogRevision: 1,
                stopEpoch: 0,
                eventHighWater: 0,
                nodes: [],
              },
            },
          }),
        );
        return true;
      }
      if (request.type === "program_status") {
        heldStatus = request;
        heldSocket = socket;
        resolveStatusSent();
        return true;
      }
    },
  );
});

test("authenticated launch association has a lexical owner and generic handles expose no mutation escape hatch", async () => {
  const { shape: source } = readSourceShape(
    new URL("./stardew-integration-launcher-body-program.internal.js", import.meta.url),
  );
  assert.match(source, /const authenticatedStardewLaunchRecords = new WeakMap/);
  assert.match(source, /function associateAuthenticatedStardewLaunch\(/);
  assert.doesNotMatch(source, /export\s+(?:const|let|var)\s+authenticatedStardewLaunchRecords/);
  assert.doesNotMatch(source, /export\s+(?:async\s+)?function\s+associateAuthenticatedStardewLaunch/);
  assert.doesNotMatch(source, /export\s*\{[^}]*authenticatedStardewLaunchRecords/);
  assert.doesNotMatch(source, /export\s*\{[^}]*associateAuthenticatedStardewLaunch/);
  const launch = Object.freeze({}) as never;
  assert.equal(Object.hasOwn(launch, "authenticatedStardewLaunchRecords"), false);
  assert.equal(Object.hasOwn(launch, "associateAuthenticatedStardewLaunch"), false);
});

test("the connection liveness check stays lexical to the launcher producer; facade exports no registrar", async () => {
  const facadeSource = await readFile(new URL("./game-connection.js", import.meta.url), "utf8");
  assert.doesNotMatch(facadeSource, /registerAuthenticatedStardewConnection/);
  assert.doesNotMatch(facadeSource, /authenticatedStardewConnections/);
  assert.doesNotMatch(facadeSource, /requireLiveConnection/);
  assert.doesNotMatch(facadeSource, /isAuthenticatedStardewConnectionLive/);
  const { shape: producerSource } = readSourceShape(
    new URL("./stardew-integration-launcher-body-program.internal.js", import.meta.url),
  );
  // Expiry of the deleted forgery gate. The association map must stay gone: keyed on the wrapper, it existed to
  // refuse objects this file never minted, and the constructor is the only place a connection is built.
  assert.doesNotMatch(producerSource, /authenticatedStardewConnections/);
  assert.doesNotMatch(producerSource, /registerAuthenticatedStardewConnection/);
  assert.match(producerSource, /export function requireLiveConnection\(/);
  const facade = await import("./game-connection.js");
  assert.equal("registerAuthenticatedStardewConnection" in facade, false);
  assert.equal("requireLiveConnection" in facade, false);
  assert.equal("isAuthenticatedStardewConnectionLive" in facade, false);
  const producer = await import("./stardew-integration-launcher-body-program.internal.js");
  assert.equal("registerAuthenticatedStardewConnection" in producer, false);
  assert.equal("authenticatedStardewConnections" in producer, false);
  assert.equal(typeof producer.requireLiveConnection, "function");
});

test("launcher-owned preview presentation accessor rejects an ordinary handle", () => {
  assert.throws(
    () => getAuthenticatedStardewPresentationPortForPreview(Object.freeze({}) as never),
    /authenticated_stardew_presentation_port_required/,
  );
});

test("authenticated Stardew launch-handle producer rejects a forged bridge before adapter use", async () => {
  await assert.rejects(
    () =>
      createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
        Object.freeze({ close() {} }) as unknown as LocalStardewBridgeClient,
        scope,
        { module: STARDEW_GAME_INTEGRATION_ADAPTER },
      ),
    /authenticated_stardew_bridge_required/,
  );
});

test("authenticated Stardew launch-handle producer closes an exact client on identity mismatch", async () => {
  await withHelloAck("farmhand_client", generation, async (pipeName, peerClosed) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(
      scope,
      pipeName,
      token,
      generation,
      Date.now() + 5_000,
      testAdapter,
    );
    await assert.rejects(
      () =>
        createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
          client,
          { ...scope, companionId: "foreign_companion" },
          { module: STARDEW_GAME_INTEGRATION_ADAPTER },
        ),
      /stardew_bridge_identity_scope_mismatch/,
    );
    await peerClosed;
  });
});

for (const mismatch of ["role", "generation"] as const) {
  test(`formal Farmhand bridge rejects ${mismatch} mismatch and closes transport`, async () => {
    await withHelloAck(
      mismatch === "role" ? "native_local_fixture" : "farmhand_client",
      mismatch === "generation" ? "different-generation" : null,
      async (pipeName, peerClosed) => {
        await assert.rejects(
          () =>
            LocalStardewBridgeClient.connectFarmhand(
              scope,
              pipeName,
              token,
              generation,
              Date.now() + 5_000,
              testAdapter,
            ),
          /bridge_runtime_attestation_mismatch/,
        );
        await peerClosed;
      },
    );
  });
}

test("formal Farmhand bridge rejects an invalid expected generation before pipe access", async () => {
  await assert.rejects(
    () =>
      LocalStardewBridgeClient.connectFarmhand(
        scope,
        "unused-valid-pipe-name",
        token,
        "invalid generation",
        Date.now() + 5_000,
        testAdapter,
      ),
    /invalid_bridge_launch_generation/,
  );
});

test(
  "formal Farmhand bridge closes the exact transport when hello misses its deadline",
  { timeout: 5_000 },
  async () => {
    const pipeName = `gamebuddy_farmhand_deadline_${process.pid}_${Date.now()}`;
    let peer: Socket | undefined;
    let resolvePeerClosed!: () => void;
    const peerClosed = new Promise<void>((resolve) => {
      resolvePeerClosed = resolve;
    });
    const server = createServer((socket) => {
      peer = socket;
      socket.on("data", () => undefined);
      socket.once("end", resolvePeerClosed);
      socket.once("close", resolvePeerClosed);
    });
    await new Promise<void>((resolve, reject) =>
      server.listen(`\\\\.\\pipe\\${pipeName}`, resolve).once("error", reject),
    );
    try {
      await assert.rejects(
        () =>
          LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 50, testAdapter),
        /bridge_connect_deadline_exceeded/,
      );
      await Promise.race([
        peerClosed,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("peer_close_timeout")), 1_000)),
      ]);
    } finally {
      peer?.destroy();
      server.close();
    }
  },
);

/** The launch producer mints exactly one authenticated wrapper for this bridge. */
async function attestedLaunch(client: LocalStardewBridgeClient) {
  return await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
    client,
    Object.freeze({
      playerId: "player_attestation",
      companionId: scope.companionId,
      continuityId,
      saveId: scope.saveId,
      worldId: scope.worldId,
    }),
    { module: STARDEW_GAME_INTEGRATION_ADAPTER },
  );
}

async function until(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  throw new Error(message);
}

/** One frame pushed by the fixture Mod over the same authenticated pipe. */
function receiptFrame(receipt: ExecutionReceipt): Buffer {
  return frame({
    protocolVersion: 1,
    messageId: "mod_receipt_attestation",
    correlationId: "mod_receipt_attestation",
    timestampMs: Date.now(),
    scope,
    type: "execution_receipt",
    payload: receipt,
  } satisfies BridgeMessage);
}

function snapshotFrame(payload: Snapshot): Buffer {
  return frame({
    protocolVersion: 1,
    messageId: "mod_snapshot_attestation",
    correlationId: "mod_snapshot_attestation",
    timestampMs: Date.now(),
    scope,
    type: "snapshot",
    payload,
  } satisfies BridgeMessage);
}

test("a closed launch connection is refused by the liveness check and by every adapter entry point", async () => {
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(
      scope,
      pipeName,
      token,
      generation,
      Date.now() + 5_000,
      testAdapter,
    );
    const launch = await attestedLaunch(client);
    try {
      const real = launch.connection;
      // The minted wrapper is live and drives the exact-identity entry points.
      assert.equal(STARDEW_GAME_INTEGRATION_ADAPTER.actorId(real), scope.playerId);
      assert.equal(STARDEW_GAME_INTEGRATION_ADAPTER.readState(real).connected, true);
      assert.doesNotThrow(() => requireLiveConnection(real));
      // The forgery half is gone: a structural copy of this wrapper is served now, because only liveness is a
      // state the launcher can really lose. The handle still hands out the same frozen wrapper after `close()`,
      // dead - so every entry point that used to refuse copies is asserted against the connection that stops
      // being usable.
      launch.close();
      assert.throws(() => requireLiveConnection(real), /stardew_connection_not_live/);
      for (const read of [
        () => STARDEW_GAME_INTEGRATION_ADAPTER.readState(real),
        () => STARDEW_GAME_INTEGRATION_ADAPTER.actorId(real),
        () => STARDEW_GAME_INTEGRATION_ADAPTER.worldScope(real),
        () => STARDEW_GAME_INTEGRATION_ADAPTER.status(real),
        () => STARDEW_GAME_INTEGRATION_ADAPTER.createToolSet({ connection: real }),
        () => STARDEW_GAME_INTEGRATION_ADAPTER.cancelExecution(real, "req_01", "exec_01", "cancelled"),
      ])
        assert.throws(read, /stardew_connection_not_live/);
    } finally {
      launch.close();
    }
  });
});

test("exact authenticated launch handle projects a Mod receipt through readState byte-for-byte", async () => {
  const receipt: ExecutionReceipt = {
    executionId: "exec_water_07",
    requestId: "req_water_07",
    actionId: "water_crop",
    state: "succeeded",
    reasonCode: "crop_watered",
    revision: 7,
    evidence: {
      detail:
        "location=Farm;target=crop_abcdef0123456789;tile=38,18;tool_selected=watering_can;slot=2;tool_before=axe;slot_before=0;before_watered=false;after_watered=true;water_before=40;water_after=39;water_consumed=true;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2;tool_restored=axe",
    },
  };
  let socket!: Socket;
  await withHelloAck(
    "farmhand_client",
    generation,
    async (pipeName) => {
      const client = await LocalStardewBridgeClient.connectFarmhand(
        scope,
        pipeName,
        token,
        generation,
        Date.now() + 5_000,
        testAdapter,
      );
      const launch = await attestedLaunch(client);
      try {
        // Push the genuine Mod receipt over the same authenticated pipe the
        // launcher used; latestReceipt then mirrors a real delivered fact.
        socket.write(receiptFrame(receipt));
        await until(() => client.state.latestReceipt !== null, "mod_receipt_not_delivered");
        const view = STARDEW_GAME_INTEGRATION_ADAPTER.readState(launch.connection);
        assert.equal(view.connected, true);
        assert.equal(view.sessionId, "session_attestation");
        assert.equal(view.capabilityRevision, 1);
        assert.deepEqual(view.enabledActionIds, ["move_to_tile"]);
        assert.deepEqual(view.registrations, [
          {
            actionId: "move_to_tile",
            familyId: "movement_navigation",
            identityVersion: 1,
            lifecycle: "published",
            kind: "execution",
          },
        ]);
        // The bridge synchronizes the admitted snapshot's monotonic revision to a
        // newer Mod receipt revision (see "local Stardew bridge advances the
        // admitted snapshot revision on an unsolicited execution receipt"); the
        // world fields still describe the pre-action moment.
        assert.equal(view.snapshotRevision, 7);
        assert.equal(view.latestReceipt?.actionId, receipt.actionId);
        assert.equal(view.latestReceipt?.requestId, receipt.requestId);
        assert.equal(view.latestReceipt?.executionId, receipt.executionId);
        assert.equal(view.latestReceipt?.state, receipt.state);
        assert.equal(view.latestReceipt?.reasonCode, receipt.reasonCode);
        // The Mod revision is preserved exactly; the adapter never renumbers it.
        assert.equal(view.latestReceipt?.revision, 7);
        // Evidence passes through untouched; the adapter neither repairs nor infers it.
        assert.deepEqual(view.latestReceipt?.evidence, receipt.evidence);
        assert.equal(
          view.latestReceipt?.evidence?.detail,
          "location=Farm;target=crop_abcdef0123456789;tile=38,18;tool_selected=watering_can;slot=2;tool_before=axe;slot_before=0;before_watered=false;after_watered=true;water_before=40;water_after=39;water_consumed=true;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2;tool_restored=axe",
        );
        // Save/world identity is bound to the authenticated scope and verified
        // through assertIdentityBinding; readState never re-exposes it.
        for (const forbidden of [
          "saveId",
          "worldId",
          "playerId",
          "companionId",
          "sessionBinding",
          "attachmentGeneration",
        ])
          assert.equal(Object.hasOwn(view, forbidden), false, forbidden);
      } finally {
        launch.close();
      }
    },
    (_request, currentSocket) => {
      socket = currentSocket;
    },
  );
});

test("exact authenticated launch handle keeps catalog capabilityRevision independent from snapshot revision", async () => {
  let socket!: Socket;
  await withHelloAck(
    "farmhand_client",
    generation,
    async (pipeName) => {
      const client = await LocalStardewBridgeClient.connectFarmhand(
        scope,
        pipeName,
        token,
        generation,
        Date.now() + 5_000,
        testAdapter,
      );
      const launch = await attestedLaunch(client);
      try {
        const initial = STARDEW_GAME_INTEGRATION_ADAPTER.readState(launch.connection);
        assert.equal(initial.capabilityRevision, 1);
        assert.equal(initial.snapshotRevision, 1);
        assert.deepEqual(initial.enabledActionIds, ["move_to_tile"]);
        // A fresh Mod snapshot advances the world observation without publishing a
        // new catalog: snapshotRevision moves, capabilityRevision does not.
        socket.write(
          snapshotFrame({
            revision: 2,
            location: "Farm",
            tile: { x: 6, y: 9 },
            stamina: 240,
            exhausted: false,
            health: 100,
            actionable: true,
            capabilities: ["move_to_tile"],
            catalogRevision: 1,
            enabledActionIds: ["move_to_tile"],
            presentationLocale: "en-US",
            weather: "sunny",
            timeOfDay: 600,
            dayOfMonth: 1,
            seasonIndex: 0,
            year: 1,
            activeExecution: null,
          }),
        );
        await until(() => client.state.snapshot?.revision === 2, "second_snapshot_not_admitted");
        const advanced = STARDEW_GAME_INTEGRATION_ADAPTER.readState(launch.connection);
        assert.equal(advanced.snapshotRevision, 2);
        assert.equal(advanced.capabilityRevision, 1);
        assert.notEqual(advanced.capabilityRevision, advanced.snapshotRevision);
      } finally {
        launch.close();
      }
    },
    (_request, currentSocket) => {
      socket = currentSocket;
    },
  );
});

test("exact authenticated launch handle projects an in-flight snapshot execution without synthesizing a receipt", async () => {
  let socket!: Socket;
  await withHelloAck(
    "farmhand_client",
    generation,
    async (pipeName) => {
      const client = await LocalStardewBridgeClient.connectFarmhand(
        scope,
        pipeName,
        token,
        generation,
        Date.now() + 5_000,
        testAdapter,
      );
      const launch = await attestedLaunch(client);
      try {
        socket.write(
          snapshotFrame({
            revision: 2,
            location: "Farm",
            tile: { x: 5, y: 8 },
            stamina: 250,
            exhausted: false,
            health: 100,
            actionable: true,
            capabilities: ["move_to_tile"],
            catalogRevision: 1,
            enabledActionIds: ["move_to_tile"],
            presentationLocale: "en-US",
            weather: "sunny",
            timeOfDay: 600,
            dayOfMonth: 1,
            seasonIndex: 0,
            year: 1,
            activeExecution: {
              executionId: "exec_active_01",
              requestId: "req_active_01",
              action: "move_to_tile",
              state: "accepted",
              reasonCode: "started",
              evidence: null,
            },
          }),
        );
        await until(() => client.state.snapshot?.revision === 2, "active_snapshot_not_admitted");
        const view = STARDEW_GAME_INTEGRATION_ADAPTER.readState(launch.connection);
        // The in-flight snapshot fact must not be projected as a terminal receipt.
        assert.equal(view.latestReceipt, null);
        // The active execution identity is projected from the snapshot, untouched.
        assert.deepEqual(view.activeExecution, {
          actionId: "move_to_tile",
          requestId: "req_active_01",
          executionId: "exec_active_01",
          state: "accepted",
        });
        // An in-flight snapshot cannot become an authoritative completion on its own.
        assert.equal(
          STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("move_to_tile", {
            state: "accepted",
            reasonCode: "started",
            evidence: null,
          }),
          false,
        );
      } finally {
        launch.close();
      }
    },
    (_request, currentSocket) => {
      socket = currentSocket;
    },
  );
});

test("exact authenticated launch handle enforces the exact save/world/companion identity binding", async () => {
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(
      scope,
      pipeName,
      token,
      generation,
      Date.now() + 5_000,
      testAdapter,
    );
    const launch = await attestedLaunch(client);
    try {
      assert.doesNotThrow(() =>
        STARDEW_GAME_INTEGRATION_ADAPTER.assertIdentityBinding(launch.connection, {
          companionId: scope.companionId,
          saveId: scope.saveId,
          worldId: scope.worldId,
        }),
      );
      for (const mismatched of [
        { companionId: scope.companionId, saveId: "save_other", worldId: scope.worldId },
        { companionId: scope.companionId, saveId: scope.saveId, worldId: "world_other" },
        { companionId: "companion_other", saveId: scope.saveId, worldId: scope.worldId },
        { companionId: scope.companionId, saveId: "save_other", worldId: "world_other" },
      ])
        assert.throws(
          () => STARDEW_GAME_INTEGRATION_ADAPTER.assertIdentityBinding(launch.connection, mismatched),
          /integration_identity_binding_mismatch/,
        );
      // Omitting the Stardew save/world identity never binds this adapter.
      assert.throws(
        () =>
          STARDEW_GAME_INTEGRATION_ADAPTER.assertIdentityBinding(launch.connection, { companionId: scope.companionId }),
        /integration_identity_binding_mismatch/,
      );
    } finally {
      launch.close();
    }
  });
});

test("exact authenticated launch handle projects a redacted adapter-neutral world scope", async () => {
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(
      scope,
      pipeName,
      token,
      generation,
      Date.now() + 5_000,
      testAdapter,
    );
    const launch = await attestedLaunch(client);
    try {
      const projected = STARDEW_GAME_INTEGRATION_ADAPTER.worldScope(launch.connection);
      assert.deepEqual(projected, {
        integrationId: "stardew",
        saveId: scope.saveId,
        worldId: scope.worldId,
      });
      // The projection is only the current-world key; it never carries launch
      // generation, paths, PIDs, tokens, leases, proofs, or native frames.
      assert.deepEqual(Object.keys(projected).sort(), ["integrationId", "saveId", "worldId"]);
    } finally {
      launch.close();
    }
  });
});

test("exact authenticated launch handle projects the embodied actor and never the Host identity playerId", async () => {
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(
      scope,
      pipeName,
      token,
      generation,
      Date.now() + 5_000,
      testAdapter,
    );
    const launch = await attestedLaunch(client);
    try {
      // The actor is the authenticated connection player, never the Host
      // identity playerId supplied to the launch producer.
      assert.equal(STARDEW_GAME_INTEGRATION_ADAPTER.actorId(launch.connection), scope.playerId);
      assert.notEqual(STARDEW_GAME_INTEGRATION_ADAPTER.actorId(launch.connection), "player_attestation");
    } finally {
      launch.close();
    }
  });
});

test("exact authenticated launch handle drives status and toolset materialization from the live gate", async () => {
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(
      scope,
      pipeName,
      token,
      generation,
      Date.now() + 5_000,
      testAdapter,
    );
    const launch = await attestedLaunch(client);
    try {
      assert.deepEqual(STARDEW_GAME_INTEGRATION_ADAPTER.status(launch.connection), {
        connected: true,
        capabilities: ["move_to_tile"],
        snapshotRevision: 1,
        latestReceiptState: null,
        latestReasonCode: null,
      });
      const tools = STARDEW_GAME_INTEGRATION_ADAPTER.createToolSet({ connection: launch.connection });
      // Observation tools materialize for the live authenticated connection;
      // executable actions stay empty without a dispatch admission factory.
      assert.ok(tools.observation.length >= 1);
      for (const tool of tools.observation) assert.equal(tool.name.startsWith("stardew_"), true);
      assert.deepEqual(tools.actions, []);
      assert.deepEqual(tools.knowledge, []);
    } finally {
      launch.close();
    }
  });
});
/**
 * The three read-only tools are the companion's only way to SEE a scene and the map. They are gated on six terms
 * (`game-tools.ts` navigationCapabilityReady/sceneCapabilityReady), and the Mod publishes every one of them: the
 * `R(...)` registrations carry `familyId`, `kind="read_only"`, `lifecycle="published"`, `identityVersion=1`, and
 * land in `AdvertisedCapabilityIds` (`farmhandcapabilityset.cs:56`), which is what hello_ack's `capabilities` and the
 * snapshot's `capabilities` both carry.
 *
 * The term that was FALSE was the route itself: the authenticated connection facade built by the launcher forwarded
 * `observe`/`execute`/`cancel` and omitted `observeScene`/`navigationRead`, so the gate's route-presence clause could
 * never hold and every call was refused synchronously (`durationMs: 1`, and no `world_navigation` frame ever reached
 * the Mod). This test pins the whole product path - adapter -> tool set -> tool -> authenticated pipe - rather than
 * the facade's key list, so it stays meaningful if the facade is ever rebuilt.
 */
test("authenticated launch handle forwards the Mod-published read-only routes so scene and map tools reach the Mod", async () => {
  const readRequests: string[] = [];
  const readOnlyRegistrations = Object.freeze([
    {
      actionId: "observe_scene",
      familyId: "world_perception",
      identityVersion: 1,
      lifecycle: "published",
      kind: "read_only",
    },
    {
      actionId: "inspect_world_map",
      familyId: "world_navigation",
      identityVersion: 1,
      lifecycle: "published",
      kind: "read_only",
    },
    {
      actionId: "find_destination",
      familyId: "world_navigation",
      identityVersion: 1,
      lifecycle: "published",
      kind: "read_only",
    },
  ]);
  const readCapabilities = ["observe_scene", "inspect_world_map", "find_destination"];
  const navigationResult = {
    status: "succeeded",
    reason: "world_map_observed",
    entries: [],
    nextCursor: null,
    candidates: null,
    destination: null,
    unlockState: null,
  };
  await withHelloAck(
    "farmhand_client",
    generation,
    async (pipeName) => {
      const client = await LocalStardewBridgeClient.connectFarmhand(
        scope,
        pipeName,
        token,
        generation,
        Date.now() + 5_000,
        testAdapter,
      );
      const launch = await attestedLaunch(client);
      try {
        const tools = STARDEW_GAME_INTEGRATION_ADAPTER.createToolSet({ connection: launch.connection });
        const read = tools.observation.find((tool) => tool.name === "stardew_read_scene");
        const map = tools.observation.find((tool) => tool.name === "stardew_inspect_world_map");
        const find = tools.observation.find((tool) => tool.name === "stardew_find_destination");
        assert.ok(read, "stardew_read_scene is a constant mount");
        assert.ok(map, "stardew_inspect_world_map is a constant mount");
        assert.ok(find, "stardew_find_destination is a constant mount");
        const signal = new AbortController().signal;
        await read.execute("read_scene_01", {}, signal, () => {}, {} as never);
        await map.execute("inspect_map_01", {}, signal, () => {}, {} as never);
        await find.execute("find_destination_01", { query: "mine" }, signal, () => {}, {} as never);
        assert.deepEqual(readRequests, ["observe_scene_request", "navigation_read_request", "navigation_read_request"]);
      } finally {
        launch.close();
      }
    },
    (request, socket) => {
      if (request.type === "observe_scene_request") {
        readRequests.push(request.type);
        socket.write(
          frame({
            ...request,
            messageId: "mod_observe_scene_attestation",
            type: "observe_scene_result",
            payload: {
              observationId: "observation_attestation",
              currentLocation: "Farm",
              currentRegion: "outdoor",
              affordances: [],
              summary: "Nothing within reach.",
              partial: false,
              truncatedReason: null,
              ground: null,
            },
          }),
        );
        return true;
      }
      if (request.type === "navigation_read_request") {
        readRequests.push(request.type);
        socket.write(
          frame({
            ...request,
            messageId: "mod_navigation_read_attestation",
            type: "navigation_read_result",
            payload: navigationResult,
          }),
        );
        return true;
      }
      return false;
    },
    { registrations: readOnlyRegistrations, capabilities: readCapabilities },
  );
});

test("invalidated execution receipt immediately closes launcher-owned preview and materializer projections", async () => {
  let socket!: Socket;
  const requests: BridgeMessage[] = [];
  await withHelloAck(
    "farmhand_client",
    generation,
    async (pipeName) => {
      const client = await LocalStardewBridgeClient.connectFarmhand(
        scope,
        pipeName,
        token,
        generation,
        Date.now() + 5_000,
        testAdapter,
      );
      const launch = await attestedLaunch(client);
      const binding = await receiptBackedBinding(launch);
      try {
        // Both launcher-owned projections admit while the execution is live.
        assert.ok(getAuthenticatedStardewPresentationPortForPreview(launch));
        await binding.executeWithBinding((bindingToken) =>
          withConsumedBindingExecution(bindingToken, (execution) =>
            materializeExactEnter(
              reserveGameRuntimeMaterialization(execution),
              enterPermit(execution),
              async (current, admission) => {
                const ports = materializeAuthenticatedStardewLaunchPorts(current, admission);
                assert.deepEqual(Object.keys(ports).sort(), ["bodyProgram", "presentation"]);
                assert.deepEqual(await ports.bodyProgram.status({ programId: "program_invalidated_before" }), {
                  code: "found",
                  snapshot: {
                    programId: "program_invalidated_before",
                    state: "active",
                    catalogRevision: 1,
                    stopEpoch: 0,
                    eventHighWater: 0,
                    nodes: [],
                  },
                  programs: null,
                  programCount: 1,
                });
                const statusFramesBeforeInvalidation = requests.filter(
                  (request) => request.type === "program_status",
                ).length;
                // A Mod invalidated receipt closes the launcher-owned record used by
                // preview/materializer immediately; the native mutation is not
                // replayed, retried, or closed (the pipe stays connected).
                socket.write(
                  receiptFrame({
                    executionId: "exec_invalidated_01",
                    requestId: "req_invalidated_01",
                    actionId: "move_to_tile",
                    state: "invalidated",
                    reasonCode: "reason_invalidated",
                    revision: 3,
                    evidence: null,
                  }),
                );
                await until(
                  () => client.state.latestReceipt?.state === "invalidated",
                  "invalidated_receipt_not_delivered",
                );
                assert.equal(client.state.connected, true);
                // The gate stays OPEN: an invalidated receipt freezes the launcher-owned program/presentation
                // records (asserted just below), but it must not forbid ordinary action dispatch - otherwise the
                // action that resolves the interruption is refused by the gate the interruption closed, and the Agent
                // is trapped by construction (ladder 6 tried `dismiss_modal` five times and got integration_not_ready).
                assert.equal(launch.connection.executionGate?.executable, true);
                assert.throws(
                  () => materializeAuthenticatedStardewLaunchPorts(current, admission),
                  /authenticated_stardew_launch_ports_required/,
                );
                assert.throws(
                  () => getAuthenticatedStardewPresentationPortForPreview(launch),
                  /authenticated_stardew_presentation_port_required/,
                );
                // Already-retained launcher-owned PROGRAM projection must KEEP WORKING. Its old assertion required
                // it to fail closed, on the premise that the Host would relearise a fresh port after an
                // interruption - and that premise is false: materialization happens ONCE per run
                // (`continuity-semantic-game-facade.internal.ts:101`, `if (... || live || ...) throw`), so a frozen
                // port is a frozen port for the rest of the session.
                //
                // Measured 2026-10-28 (`round2b`, spring day 5): one Clint cutscene interrupted one `enter_exit`, and
                // the next 16 `program_status` / `program_submit` calls were refused. The companion stood at the
                // farmhouse door for the rest of the run.
                //
                // The frozen port also protected nothing. `BodyProgramState` has no `invalidated` member
                // (`BodyProgramModels.cs:17`), and the Mod's own executor answers that receipt with `return null`,
                // keeping the node bound-Running for a retry (`RouteReenteringBodyProgramExecutor.cs:301-305`).
                // Unsettled program state is guarded by the journal and the controller, which refuse by name; the
                // Host cannot protect it by cutting the only channel through which it could learn that state.
                //
                // The RECORD still closes, and that half is unchanged and asserted above: a new materialization and
                // the preview accessor both fail. What survives an invalidation is the long-lived port, exactly as
                // `presentation` already does - and for the same reason its own comment records.
                const statusAfterInvalidation = ports.bodyProgram.status({ programId: "program_invalidated_after" });
                assert.ok(
                  statusAfterInvalidation instanceof Promise,
                  "the long-lived program port must still accept work after one execution is invalidated",
                );
                statusAfterInvalidation.catch(() => undefined);
                assert.ok(
                  ports.presentation.state.snapshot !== undefined || ports.presentation.state.snapshot === null,
                  "the live presentation port must keep working after an execution invalidation",
                );
                // The channel stays open, which is the point: a request reaches the native pipe after invalidation.
                //
                // Await the frame rather than assert a promise exists: `status()` resolves only once its result
                // arrives, and the socket handler here records without replying, so awaiting would hang. Polling the
                // recorded requests is the honest form - it observes the frame actually leaving.
                await until(
                  () =>
                    requests.filter((request) => request.type === "program_status").length >
                    statusFramesBeforeInvalidation,
                  "program_status_after_invalidation_not_observed",
                );
                assert.equal(
                  requests.filter((request) => request.type === "program_status").length,
                  statusFramesBeforeInvalidation + 1,
                  "an invalidated receipt must not seal the program channel",
                );
                return Object.freeze({ session: Object.freeze({ dispose: () => undefined }) });
              },
            ),
          ),
        );
      } finally {
        await binding.close();
      }
    },
    (request, currentSocket) => {
      requests.push(request);
      socket = currentSocket;
    },
  );
});

test("authenticated bridge rejects unsolicited hello_ack by unknown correlation", async () => {
  let socket!: Socket;
  await withHelloAck(
    "farmhand_client",
    generation,
    async (pipeName, peerClosed) => {
      const client = await LocalStardewBridgeClient.connectFarmhand(
        scope,
        pipeName,
        token,
        generation,
        Date.now() + 5_000,
        testAdapter,
      );
      try {
        socket.write(
          frame({
            protocolVersion: 1,
            messageId: "unsolicited_hello_ack",
            correlationId: "unknown_hello_correlation",
            timestampMs: Date.now(),
            scope,
            type: "hello_ack",
            payload: {
              sessionId: "session_unsolicited",
              capabilities: ["move_to_tile"],
              catalogRevision: 1,
              policyIdentity: { value: "abcdef0123456789abcdef0123456789", capabilityRevision: 2 },
              enabledActionIds: ["move_to_tile"],
              presentationLocale: "en-US",
              registrations: [
                {
                  actionId: "move_to_tile",
                  familyId: "movement_navigation",
                  identityVersion: 1,
                  lifecycle: "published",
                  kind: "execution",
                },
              ],
              runtimeRole: "farmhand_client",
              launchGeneration: generation,
            },
          } satisfies BridgeMessage),
        );
        await Promise.race([
          peerClosed,
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("peer_close_timeout")), 1_000)),
        ]);
        assert.equal(client.state.connected, false);
        assert.equal(client.state.latestReasonCode, "unexpected_hello_ack");
      } finally {
        client.close();
      }
    },
    (_request, currentSocket) => {
      socket = currentSocket;
    },
  );
});

/**
 * A status answer must never be OLDER than the events this connection already delivered for that program.
 *
 * MEASURED 2026-11-09 (round41 `multiday_routine`): a `programStatus` reply carried `snapshot.programId=plan_739…`,
 * `state: "active"`, `eventHighWater: 626`, while that program's three nodes had all reached `succeeded` on journal
 * cursors 625/629/633. The answer is composed by the Mod from the journal state it publishes
 * (`local-stardew-bridge.ts:609`) and was forwarded verbatim
 * (`continuity-semantic-game-runtime-materializer.ts:571-591`), so nothing compared it with what this Host had already
 * been handed and a finished plan was reported as still running. `eventHighWater` is the journal-wide cursor at the
 * moment the snapshot was composed, so it is monotone: a snapshot below one this Host already holds is provably older.
 */
test(
  "a settled program is not answered from a snapshot the connection has already moved past",
  { timeout: 15_000 },
  async () => {
    const requests: BridgeMessage[] = [];
    // Read 1 is the background settlement watch the submission starts (it would otherwise race this test's own read),
    // read 2 is the tool's first read - composed from a journal state the Mod has already moved past - and read 3 is
    // its re-read.
    let statusReads = 0;
    await withHelloAck(
      "farmhand_client",
      generation,
      async (pipeName) => {
        const client = await LocalStardewBridgeClient.connectFarmhand(
          scope,
          pipeName,
          token,
          generation,
          Date.now() + 10_000,
          testAdapter,
        );
        const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
          client,
          Object.freeze({
            playerId: "player_attestation",
            companionId: scope.companionId,
            continuityId,
            saveId: scope.saveId,
            worldId: scope.worldId,
          }),
          { module: STARDEW_GAME_INTEGRATION_ADAPTER },
        );
        const binding = await receiptBackedBinding(launch);
        let materialized:
          | Awaited<ReturnType<ReturnType<typeof createHostGameRuntimeMaterializer>["materializeEnter"]>>
          | undefined;
        try {
          materialized = await binding.executeWithBinding((bindingToken) =>
            withConsumedBindingExecution(bindingToken, (execution) =>
              createHostGameRuntimeMaterializer().materializeEnter(
                reserveGameRuntimeMaterialization(execution),
                enterPermit(execution),
              ),
            ),
          );
          const tools = () => observeMaterializedProductionRuntimeForTest(materialized!).session.agent.state.tools;
          const execute = async (name: string, params: Record<string, unknown>) =>
            (
              await tools()
                .find((tool) => tool.name === name)!
                .execute("delivery_watermark", params, new AbortController().signal, () => undefined)
            ).details as {
              code?: string;
              snapshot?: { state?: string; eventHighWater?: number };
              staleSnapshot?: string;
              staleSnapshotReplaced?: string;
            };
          // The readers mount on a recorded submission, so one accepted program comes first.
          await execute("stardew_submit_action_program", {
            programId: "plan_739_frozen",
            nodes: [
              { nodeId: "n01", actionId: "move_to_tile", arguments: {}, dependsOn: [], bindings: {} },
              { nodeId: "n03", actionId: "move_to_tile", arguments: {}, dependsOn: ["n01"], bindings: {} },
            ],
          });
          // The plan's own event log, which is what this Host has already been delivered: cursors 625/629/633 with a
          // journal watermark of 633. Every later status snapshot has to be at least this current.
          const events = await execute("stardew_action_program_events", {
            programId: "plan_739_frozen",
            cursor: 0,
            pageSize: 32,
          });
          assert.equal((events as { highWater?: number }).highWater, 633);
          const status = await execute("stardew_action_program_status", { programId: "plan_739_frozen" });
          assert.equal(status.code, "found");
          assert.equal(status.snapshot?.eventHighWater, 634, "the answer is the read that caught up");
          assert.equal(
            status.snapshot?.state,
            "succeeded",
            "a plan whose nodes all settled on events this Host already has is not 'active'",
          );
          assert.equal(status.staleSnapshot, undefined, "the answer in hand is current, so nothing about it is stale");
          assert.equal(
            status.staleSnapshotReplaced,
            "stale_snapshot:eventHighWater=626;delivered=633",
            "and the frozen answer it replaced is named, not dropped silently",
          );
          assert.equal(
            requests.filter((request) => request.type === "program_status").length,
            3,
            "one read for the watch, one frozen read, and exactly one re-read",
          );
        } finally {
          await materialized?.close();
          await binding.close();
        }
      },
      (request, socket) => {
        requests.push(request);
        if (request.type === "program_submit") {
          socket.write(
            frame({
              ...request,
              messageId: "mod_program_submit_delivery_watermark",
              type: "program_submit_result",
              payload: {
                code: "accepted",
                verification: { accepted: true, catalogRevision: 1, diagnostics: [] },
                snapshot: {
                  programId: request.payload.programId,
                  state: "active",
                  catalogRevision: 1,
                  stopEpoch: 0,
                  eventHighWater: 620,
                  nodes: [],
                },
              },
            }),
          );
          return true;
        }
        if (request.type === "program_events") {
          socket.write(
            frame({
              ...request,
              messageId: "mod_program_events_delivery_watermark",
              type: "program_events_result",
              payload: {
                programId: request.payload.programId,
                code: "found",
                events: [
                  {
                    cursor: 625,
                    programId: request.payload.programId,
                    kind: "node_settled",
                    catalogRevision: 1,
                    nodeId: "n01",
                    nodeAttempt: 1,
                    atMs: 1_264_847,
                  },
                  {
                    cursor: 629,
                    programId: request.payload.programId,
                    kind: "node_settled",
                    catalogRevision: 1,
                    nodeId: "auto_walk_02",
                    nodeAttempt: 1,
                    atMs: 1_265_049,
                  },
                  {
                    cursor: 633,
                    programId: request.payload.programId,
                    kind: "node_settled",
                    catalogRevision: 1,
                    nodeId: "n03",
                    nodeAttempt: 1,
                    atMs: 1_265_261,
                  },
                ],
                nextCursor: 633,
                highWater: 633,
              },
            }),
          );
          return true;
        }
        if (request.type !== "program_status") return;
        statusReads += 1;
        if (statusReads === 1) {
          // The settlement watch: a journal that does not hold the plan yet ends it without a digest, which keeps this
          // test's own reads the only ones that decide anything.
          socket.write(
            frame({
              ...request,
              messageId: "mod_program_status_delivery_watch",
              type: "program_status_result",
              payload: { code: "not_found", snapshot: null, programs: null, programCount: 0 },
            }),
          );
          return true;
        }
        const frozen = statusReads === 2;
        socket.write(
          frame({
            ...request,
            messageId: "mod_program_status_delivery_watermark",
            type: "program_status_result",
            payload: {
              code: "found",
              snapshot: {
                programId: request.payload.programId,
                state: frozen ? "active" : "succeeded",
                catalogRevision: 1,
                stopEpoch: 0,
                eventHighWater: frozen ? 626 : 634,
                nodes: [
                  { nodeId: "n01", actionId: "move_to_tile", state: "succeeded", nodeAttempt: 1, admissionAttempt: 1 },
                  {
                    nodeId: "n03",
                    actionId: "move_to_tile",
                    state: frozen ? "pending" : "succeeded",
                    nodeAttempt: frozen ? 0 : 1,
                    admissionAttempt: frozen ? 0 : 1,
                  },
                ],
              },
              programs: null,
              programCount: 1,
            },
          }),
        );
        return true;
      },
    );
  },
);

/**
 * When the journal does not catch up, the answer says so instead of reading as an authoritative `active`.
 *
 * The same round41 snapshot, with a Mod that keeps composing it: the re-read is one attempt to get a current answer,
 * not a loop, and what comes back is LABELLED with both cursors so a caller can tell "the plan is running" from "the
 * journal is behind the events I already hold".
 */
test(
  "a snapshot that stays behind the delivered events names itself instead of reading as current",
  { timeout: 15_000 },
  async () => {
    const requests: BridgeMessage[] = [];
    // Read 1 is the background settlement watch the submission starts; every read after it is frozen, so the answer
    // the tool reports is the lagging one and has to say so.
    let statusReads = 0;
    await withHelloAck(
      "farmhand_client",
      generation,
      async (pipeName) => {
        const client = await LocalStardewBridgeClient.connectFarmhand(
          scope,
          pipeName,
          token,
          generation,
          Date.now() + 10_000,
          testAdapter,
        );
        const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
          client,
          Object.freeze({
            playerId: "player_attestation",
            companionId: scope.companionId,
            continuityId,
            saveId: scope.saveId,
            worldId: scope.worldId,
          }),
          { module: STARDEW_GAME_INTEGRATION_ADAPTER },
        );
        const binding = await receiptBackedBinding(launch);
        let materialized:
          | Awaited<ReturnType<ReturnType<typeof createHostGameRuntimeMaterializer>["materializeEnter"]>>
          | undefined;
        try {
          materialized = await binding.executeWithBinding((bindingToken) =>
            withConsumedBindingExecution(bindingToken, (execution) =>
              createHostGameRuntimeMaterializer().materializeEnter(
                reserveGameRuntimeMaterialization(execution),
                enterPermit(execution),
              ),
            ),
          );
          const tools = () => observeMaterializedProductionRuntimeForTest(materialized!).session.agent.state.tools;
          const execute = async (name: string, params: Record<string, unknown>) =>
            (
              await tools()
                .find((tool) => tool.name === name)!
                .execute("stale_answer", params, new AbortController().signal, () => undefined)
            ).details as {
              code?: string;
              snapshot?: { state?: string };
              staleSnapshot?: string;
              staleSnapshotReplaced?: string;
            };
          await execute("stardew_submit_action_program", {
            programId: "plan_739_frozen_forever",
            nodes: [{ nodeId: "n01", actionId: "move_to_tile", arguments: {}, dependsOn: [], bindings: {} }],
          });
          await execute("stardew_action_program_events", {
            programId: "plan_739_frozen_forever",
            cursor: 0,
            pageSize: 32,
          });
          const status = await execute("stardew_action_program_status", {
            programId: "plan_739_frozen_forever",
          });
          assert.equal(status.code, "found");
          assert.equal(status.snapshot?.state, "active", "the Mod's own word is not rewritten by this Host");
          assert.equal(
            status.staleSnapshot,
            "stale_snapshot:eventHighWater=626;delivered=633",
            "but it is qualified by the cursor it was composed at and the one this connection already reached",
          );
          assert.equal(status.staleSnapshotReplaced, undefined, "nothing replaced it, so nothing claims to have");
          assert.equal(
            requests.filter((request) => request.type === "program_status").length,
            3,
            "one read for the watch, one frozen read, and exactly one re-read - not a poll loop",
          );
        } finally {
          await materialized?.close();
          await binding.close();
        }
      },
      (request, socket) => {
        requests.push(request);
        if (request.type === "program_submit") {
          socket.write(
            frame({
              ...request,
              messageId: "mod_program_submit_stale_answer",
              type: "program_submit_result",
              payload: {
                code: "accepted",
                verification: { accepted: true, catalogRevision: 1, diagnostics: [] },
                snapshot: {
                  programId: request.payload.programId,
                  state: "active",
                  catalogRevision: 1,
                  stopEpoch: 0,
                  eventHighWater: 620,
                  nodes: [],
                },
              },
            }),
          );
          return true;
        }
        if (request.type === "program_events") {
          socket.write(
            frame({
              ...request,
              messageId: "mod_program_events_stale_answer",
              type: "program_events_result",
              payload: {
                programId: request.payload.programId,
                code: "found",
                events: [
                  {
                    cursor: 633,
                    programId: request.payload.programId,
                    kind: "node_settled",
                    catalogRevision: 1,
                    nodeId: "n01",
                    nodeAttempt: 1,
                    atMs: 1_265_261,
                  },
                ],
                nextCursor: 633,
                highWater: 633,
              },
            }),
          );
          return true;
        }
        if (request.type !== "program_status") return;
        statusReads += 1;
        if (statusReads === 1) {
          socket.write(
            frame({
              ...request,
              messageId: "mod_program_status_stale_watch",
              type: "program_status_result",
              payload: { code: "not_found", snapshot: null, programs: null, programCount: 0 },
            }),
          );
          return true;
        }
        socket.write(
          frame({
            ...request,
            messageId: "mod_program_status_stale_answer",
            type: "program_status_result",
            payload: {
              code: "found",
              snapshot: {
                programId: request.payload.programId,
                state: "active",
                catalogRevision: 1,
                stopEpoch: 0,
                eventHighWater: 626,
                nodes: [
                  { nodeId: "n01", actionId: "move_to_tile", state: "succeeded", nodeAttempt: 1, admissionAttempt: 1 },
                ],
              },
              programs: null,
              programCount: 1,
            },
          }),
        );
        return true;
      },
    );
  },
);
