import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

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
import { createHostGameRuntimeMaterializer } from "./continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.js";
import { observeMaterializedProductionRuntimeForTest } from "./continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.test-support.js";
import { assertReceiptBackedLaunch } from "./integration-launcher.js";
import { LocalStardewBridgeClient } from "./local-stardew-bridge.js";
import type { BridgeMessage, Scope } from "./protocol.js";
import {
  createStardewIntegrationLaunchHandleFromAuthenticatedBridge,
  getAuthenticatedStardewPresentationPortForPreview,
  STARDEW_INTEGRATION_LAUNCHER,
} from "./stardew-integration-launcher.js";
import { materializeAuthenticatedStardewLaunchPorts } from "./stardew-integration-launcher-body-program.internal.js";

const scope: Scope = Object.freeze({
  integrationId: "stardew",
  saveId: "save_attestation",
  worldId: "world_attestation",
  playerId: "farmhand_attestation",
  companionId: "companion_attestation",
});
const token = "farmhand_bridge_token_0123456789";
const generation = "ai-generation-attestation";

async function receiptBackedBinding(launch: import("./integration-launcher.js").IntegrationLaunchHandle): Promise<GameRuntimeBinding> {
  const root = await mkdtemp(join(tmpdir(), "stardew-s4c-admission-"));
  const runtimeRoot = join(root, "runtime");
  await mkdir(runtimeRoot);
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({
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
  }));
  return createGameRuntimeBindingFromReceiptBackedLaunch(Object.freeze({
    manifest: await loadHostDeploymentManifest(manifestPath),
    launcher: STARDEW_INTEGRATION_LAUNCHER,
    launch,
    expectedWorld: Object.freeze({ saveId: scope.saveId, worldId: scope.worldId }),
  }));
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
    server.close((error) => error === undefined ? resolve() : reject(error)),
  );
}

async function withHelloAck<T>(
  runtimeRole: "farmhand_client" | "native_local_fixture" | "unattested",
  launchGeneration: string | null,
  operation: (pipeName: string, peerClosed: Promise<void>) => Promise<T>,
  onRequest?: (request: BridgeMessage, socket: Socket) => boolean | void,
): Promise<T> {
  const pipeName = `gamebuddy_farmhand_attestation_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let peer: Socket | undefined;
  let resolvePeerClosed!: () => void;
  const peerClosed = new Promise<void>((resolve) => { resolvePeerClosed = resolve; });
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
          socket.write(frame({
            ...request,
            messageId: "mod_hello_attestation",
            type: "hello_ack",
            payload: {
              sessionId: "session_attestation",
              capabilities: ["move_to_tile"],
              catalogRevision: 1,
              enabledActionIds: ["move_to_tile"],
              presentationLocale: "en-US",
              registrations: [{
                actionId: "move_to_tile",
                familyId: "movement_navigation",
                identityVersion: 1,
                lifecycle: "published",
                kind: "execution",
              }],
              runtimeRole,
              launchGeneration,
            },
          }));
        else if (request.type === "observe_request")
          socket.write(frame({
            ...request,
            messageId: "mod_snapshot_attestation",
            type: "snapshot",
            payload: {
              revision: 1,
              location: "Farm",
              tile: { x: 5, y: 8 },
              stamina: 250,
              health: 100,
              actionable: true,
              capabilities: ["move_to_tile"],
              catalogRevision: 1,
              enabledActionIds: ["move_to_tile"],
              presentationLocale: "en-US",
              activeExecution: null,
            },
          }));
        else if (request.type === "program_verify" || request.type === "program_submit")
          socket.write(frame({
            ...request,
            messageId: `mod_${request.type}_attestation`,
            type: request.type === "program_verify" ? "program_verify_result" : "program_submit_result",
            payload: {
              programId: request.payload.programId,
              status: request.type === "program_submit" ? "rejected" : "accepted",
              diagnostics: request.type === "program_submit" ? ["policy_denied"] : [],
            },
          }));
        else if (request.type === "program_status")
          socket.write(frame({
            ...request,
            messageId: "mod_program_status_attestation",
            type: "program_status_result",
            payload: {
              programId: request.payload.programId,
              status: "accepted",
              catalogRevision: 1,
            },
          }));
        else if (request.type === "program_events")
          socket.write(frame({
            ...request,
            messageId: "mod_program_events_attestation",
            type: "program_events_result",
            payload: {
              programId: request.payload.programId,
               nextCursor: request.payload.cursor + 1,
               events: [{ cursor: request.payload.cursor + 1, kind: "accepted", catalogRevision: 1 }],
            },
          }));
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
    const client = await LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000);
    const identity = Object.freeze({
       playerId: "browser_player_01",
       companionId: scope.companionId,
       continuityId: "continuity_attestation_01",
       saveId: scope.saveId,
      worldId: scope.worldId,
    });
    const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(client, identity);
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
    assert.equal(Object.hasOwn(launch, "programVerify"), false);
    assert.equal(Object.hasOwn(launch, "programSubmit"), false);
    const presentation = getAuthenticatedStardewPresentationPortForPreview(launch);
    assert.deepEqual(Object.keys(presentation).sort(), ["presentCompanionText", "presentSystemNotice", "state"]);
    assert.equal("programVerify" in presentation, false);
    launch.close();
    assert.throws(
      () => getAuthenticatedStardewPresentationPortForPreview(launch),
      /authenticated_stardew_presentation_port_required/,
    );
  });
});

test("S4c body-program admission expires with its factory callback and rejects forgery", async () => {
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000);
    const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(client, Object.freeze({
      playerId: "player_attestation",
      companionId: scope.companionId,
      saveId: scope.saveId,
      worldId: scope.worldId,
    }));
    const binding = await receiptBackedBinding(launch);
    let retainedExecution!: GameRuntimeBindingExecution;
    let retainedAdmission!: OpaqueS4cMaterializationAdmission;
    try {
      await binding.executeWithBinding((token) => withConsumedBindingExecution(token, (execution) =>
        materializeExactEnter(
          reserveGameRuntimeMaterialization(execution),
          enterPermit(execution),
          async (current, admission) => {
            retainedExecution = current;
            retainedAdmission = admission;
            assert.throws(
              () => materializeAuthenticatedStardewLaunchPorts(current, Object.freeze({}) as OpaqueS4cMaterializationAdmission),
              /s4c_materialization_admission_rejected/,
            );
            const ports = materializeAuthenticatedStardewLaunchPorts(current, admission);
            assert.deepEqual(Object.keys(ports).sort(), ["bodyProgram", "presentation"]);
            assert.deepEqual(
              await ports.bodyProgram.status({ programId: "program_01" }),
              { programId: "program_01", status: "accepted", catalogRevision: 1 },
            );
            return Object.freeze({ session: Object.freeze({ dispose: () => undefined }) });
          },
        ),
      ));
      assert.throws(
        () => materializeAuthenticatedStardewLaunchPorts(retainedExecution, retainedAdmission),
        /s4c_materialization_admission_rejected/,
      );
    } finally {
      await binding.close();
    }
  });
});

test("actual attested pipe materializes exactly four fixed body-program tools and preserves their command semantics", async () => {
  const requests: BridgeMessage[] = [];
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000);
    const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(client, Object.freeze({
      playerId: "player_attestation", companionId: scope.companionId, saveId: scope.saveId, worldId: scope.worldId,
    }));
    const binding = await receiptBackedBinding(launch);
    let materialized: Awaited<ReturnType<ReturnType<typeof createHostGameRuntimeMaterializer>["materializeEnter"]>> | undefined;
    try {
      materialized = await binding.executeWithBinding((bindingToken) => withConsumedBindingExecution(bindingToken, (execution) =>
        createHostGameRuntimeMaterializer().materializeEnter(
          reserveGameRuntimeMaterialization(execution), enterPermit(execution),
        ),
      ));
      const tools = observeMaterializedProductionRuntimeForTest(materialized).session.agent.state.tools;
      const fixedToolNames = tools.map((tool) => tool.name).filter((name) =>
        ["stardew_verify_action_program", "stardew_submit_action_program", "stardew_action_program_status", "stardew_action_program_events"].includes(name),
      ).sort();
      assert.deepEqual(fixedToolNames, [
        "stardew_action_program_events", "stardew_action_program_status",
        "stardew_submit_action_program", "stardew_verify_action_program",
      ]);
      const execute = async (name: string, params: Record<string, unknown>) => {
        const tool = tools.find((current) => current.name === name);
        assert.ok(tool, `missing ${name}`);
        return await tool.execute("body-program-test", params, new AbortController().signal, () => undefined);
      };
      const candidate = Object.freeze({ programId: "program_01", nodes: [{
        nodeId: "node_01", actionId: "move_to_tile", arguments: {}, dependsOn: [], bindings: {}, deadlineMs: 1,
      }] });
      const verified = await execute("stardew_verify_action_program", candidate);
      const submitted = await execute("stardew_submit_action_program", candidate);
      const status = await execute("stardew_action_program_status", { programId: "program_01" });
      const events = await execute("stardew_action_program_events", { programId: "program_01", cursor: 7, pageSize: 1 });
      for (const result of [verified, submitted, status, events])
        assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), result.details);
      assert.deepEqual(verified.details, { programId: "program_01", status: "accepted", diagnostics: [] });
      assert.deepEqual(submitted.details, { programId: "program_01", status: "rejected", diagnostics: ["policy_denied"] });
      assert.deepEqual(status.details, { programId: "program_01", status: "accepted", catalogRevision: 1 });
       assert.deepEqual(events.details, { programId: "program_01", nextCursor: 8, events: [{ cursor: 8, kind: "accepted", catalogRevision: 1 }] });
      assert.deepEqual(requests.filter((request) => request.type.startsWith("program_")).map((request) => request.type), [
        "program_verify", "program_submit", "program_status", "program_events",
      ]);
      await assert.rejects(() => execute("stardew_submit_action_program", { programId: "bad id", nodes: [] }), /invalid_body_program_tool_arguments/);
      assert.equal(requests.filter((request) => request.type === "program_submit").length, 1);
    } finally {
      await materialized?.close();
      await binding.close();
    }
  }, (request) => { requests.push(request); });
});

test("attested fixed body-program closures recheck restrictive live policy without emitting a program frame", async () => {
  const requests: BridgeMessage[] = [];
  let socket!: Socket;
  let catalogUpdatePublished = false;
  let resolveCatalogRefreshRequested!: () => void;
  const catalogRefreshRequested = new Promise<void>((resolve) => { resolveCatalogRefreshRequested = resolve; });
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000);
    const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(client, Object.freeze({
      playerId: "player_attestation", companionId: scope.companionId, saveId: scope.saveId, worldId: scope.worldId,
    }));
    const binding = await receiptBackedBinding(launch);
    let materialized: Awaited<ReturnType<ReturnType<typeof createHostGameRuntimeMaterializer>["materializeEnter"]>> | undefined;
    try {
      materialized = await binding.executeWithBinding((bindingToken) => withConsumedBindingExecution(bindingToken, (execution) =>
        createHostGameRuntimeMaterializer().materializeEnter(reserveGameRuntimeMaterialization(execution), enterPermit(execution)),
      ));
      const tools = observeMaterializedProductionRuntimeForTest(materialized).session.agent.state.tools;
      const verify = tools.find((current) => current.name === "stardew_verify_action_program");
      const submit = tools.find((current) => current.name === "stardew_submit_action_program");
      assert.ok(verify);
      assert.ok(submit);
      catalogUpdatePublished = true;
      socket.write(frame({
        protocolVersion: 1, messageId: "catalog_update_attestation", correlationId: "catalog_update_attestation",
        timestampMs: Date.now(), scope, type: "catalog_update", payload: { catalogRevision: 2, enabledActionIds: [] },
      } satisfies BridgeMessage));
      await catalogRefreshRequested;
      for (let attempt = 0; attempt < 20 && client.state.snapshot?.catalogRevision !== 2; attempt++)
        await delay(5);
      assert.equal(client.state.catalogRevision, 2);
      assert.deepEqual(client.state.enabledActionIds, []);
      assert.equal(client.state.snapshot?.catalogRevision, 2);
      await assert.rejects(
        () => verify.execute("policy_recheck_verify", { programId: "program_02", nodes: [{ nodeId: "node_02", actionId: "move_to_tile", arguments: {}, dependsOn: [], bindings: {}, deadlineMs: 1 }] }, new AbortController().signal, () => undefined),
        /body_program_preflight_rejected/,
      );
      await assert.rejects(
        () => submit.execute("policy_recheck_submit", { programId: "program_02", nodes: [{ nodeId: "node_02", actionId: "move_to_tile", arguments: {}, dependsOn: [], bindings: {}, deadlineMs: 1 }] }, new AbortController().signal, () => undefined),
        /body_program_preflight_rejected/,
      );
      assert.equal(requests.filter((request) => request.type === "program_verify" || request.type === "program_submit").length, 0);
    } finally {
      await materialized?.close();
      await binding.close();
    }
  }, (request, currentSocket) => {
    requests.push(request);
    socket = currentSocket;
    if (catalogUpdatePublished && request.type === "observe_request") {
      currentSocket.write(frame({
        ...request,
        messageId: "mod_catalog_refresh_attestation",
        type: "snapshot",
        payload: {
          revision: 2,
          location: "Farm",
          tile: { x: 5, y: 8 },
          stamina: 250,
          health: 100,
          actionable: true,
          capabilities: ["move_to_tile"],
          catalogRevision: 2,
          enabledActionIds: [],
          presentationLocale: "en-US",
          activeExecution: null,
        },
      }));
      resolveCatalogRefreshRequested();
      return true;
    }
  });
});

test("attested status and events each emit one frame without preflight, cursor cache, or auto-page", async () => {
  const requests: BridgeMessage[] = [];
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000);
    const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(client, Object.freeze({ playerId: "player_attestation", companionId: scope.companionId, saveId: scope.saveId, worldId: scope.worldId }));
    const binding = await receiptBackedBinding(launch);
    let materialized: Awaited<ReturnType<ReturnType<typeof createHostGameRuntimeMaterializer>["materializeEnter"]>> | undefined;
    try {
      materialized = await binding.executeWithBinding((bindingToken) => withConsumedBindingExecution(bindingToken, (execution) => createHostGameRuntimeMaterializer().materializeEnter(reserveGameRuntimeMaterialization(execution), enterPermit(execution))));
       const tools = observeMaterializedProductionRuntimeForTest(materialized).session.agent.state.tools;
       const observeRequestsAtMaterialization = requests.filter((request) => request.type === "observe_request").length;
       const execute = (name: string, params: Record<string, unknown>) => tools.find((tool) => tool.name === name)!.execute("single_frame", params, new AbortController().signal, () => undefined);
       await execute("stardew_action_program_status", { programId: "program_03" });
      await execute("stardew_action_program_events", { programId: "program_03", cursor: 11, pageSize: 1 });
      assert.deepEqual(requests.filter((request) => request.type.startsWith("program_")).map((request) => request.type), ["program_status", "program_events"]);
       assert.equal(requests.filter((request) => request.type === "observe_request").length, observeRequestsAtMaterialization);
    } finally {
      await materialized?.close();
      await binding.close();
    }
  }, (request) => { requests.push(request); });
});

test("attested submit timeout emits exactly one program frame and is not retried", { timeout: 15_000 }, async () => {
  const requests: BridgeMessage[] = [];
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 10_000);
    const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(client, Object.freeze({ playerId: "player_attestation", companionId: scope.companionId, saveId: scope.saveId, worldId: scope.worldId }));
    const binding = await receiptBackedBinding(launch);
    let materialized: Awaited<ReturnType<ReturnType<typeof createHostGameRuntimeMaterializer>["materializeEnter"]>> | undefined;
    try {
      materialized = await binding.executeWithBinding((bindingToken) => withConsumedBindingExecution(bindingToken, (execution) => createHostGameRuntimeMaterializer().materializeEnter(reserveGameRuntimeMaterialization(execution), enterPermit(execution))));
      const submit = observeMaterializedProductionRuntimeForTest(materialized).session.agent.state.tools.find((tool) => tool.name === "stardew_submit_action_program")!;
      await assert.rejects(() => submit.execute("submit_timeout", { programId: "program_04", nodes: [{ nodeId: "node_04", actionId: "move_to_tile", arguments: {}, dependsOn: [], bindings: {}, deadlineMs: 1 }] }, new AbortController().signal, () => undefined), /bridge_response_timeout/);
      assert.equal(requests.filter((request) => request.type === "program_submit").length, 1);
    } finally {
      await materialized?.close();
      await binding.close();
    }
  }, (request) => {
    requests.push(request);
    // Withhold only the submit response; the default fixture path remains
    // available for every other request and transport cleanup.
    return request.type === "program_submit";
  });
});

test("attested fixed closure survives refresh by identity, then drains before revocation", async () => {
  const requests: BridgeMessage[] = [];
  let heldStatus: BridgeMessage | undefined;
  let heldSocket: Socket | undefined;
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000);
    const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(client, Object.freeze({ playerId: "player_attestation", companionId: scope.companionId, saveId: scope.saveId, worldId: scope.worldId }));
    const binding = await receiptBackedBinding(launch);
    let materialized: Awaited<ReturnType<ReturnType<typeof createHostGameRuntimeMaterializer>["materializeEnter"]>> | undefined;
    try {
      materialized = await binding.executeWithBinding((bindingToken) => withConsumedBindingExecution(bindingToken, (execution) => createHostGameRuntimeMaterializer().materializeEnter(reserveGameRuntimeMaterialization(execution), enterPermit(execution))));
      const runtime = observeMaterializedProductionRuntimeForTest(materialized);
      const status = runtime.session.agent.state.tools.find((tool) => tool.name === "stardew_action_program_status")!;
      await runtime.refreshIntegrationTools?.();
      assert.equal(runtime.session.agent.state.tools.find((tool) => tool.name === "stardew_action_program_status"), status);
      const started = status.execute("draining_status", { programId: "program_05" }, new AbortController().signal, () => undefined);
      await delay(0);
      const closing = materialized.close();
      await assert.rejects(() => status.execute("revoked_status", { programId: "program_05" }, new AbortController().signal, () => undefined), /action_program_runtime_unavailable/);
      assert.equal(requests.filter((request) => request.type === "program_status").length, 1);
      assert.ok(heldStatus);
      heldSocket!.write(frame({ ...heldStatus, messageId: "status_drain_attestation", type: "program_status_result", payload: { programId: "program_05", status: "accepted", catalogRevision: 1 } }));
      await started;
      await closing;
      assert.throws(() => observeMaterializedProductionRuntimeForTest(materialized!), /materialized_runtime_test_observation_unavailable/);
    } finally {
      await materialized?.close();
      await binding.close();
    }
  }, (request, socket) => {
    requests.push(request);
    if (request.type === "program_status") { heldStatus = request; heldSocket = socket; return true; }
  });
});

test("authenticated launch association has a lexical owner and generic handles expose no mutation escape hatch", async () => {
  const source = await readFile(new URL("./stardew-integration-launcher-body-program.internal.js", import.meta.url), "utf8");
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
      ),
    /authenticated_stardew_bridge_required/,
  );
});

test("authenticated Stardew launch-handle producer closes an exact client on identity mismatch", async () => {
  await withHelloAck("farmhand_client", generation, async (pipeName, peerClosed) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000);
    await assert.rejects(
      () => createStardewIntegrationLaunchHandleFromAuthenticatedBridge(client, { ...scope, companionId: "foreign_companion" }),
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
          () => LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000),
          /bridge_runtime_attestation_mismatch/,
        );
        await peerClosed;
      },
    );
  });
}

test("formal Farmhand bridge rejects an invalid expected generation before pipe access", async () => {
  await assert.rejects(
    () => LocalStardewBridgeClient.connectFarmhand(
      scope,
      "unused-valid-pipe-name",
      token,
      "invalid generation",
      Date.now() + 5_000,
    ),
    /invalid_bridge_launch_generation/,
  );
});

test("formal Farmhand bridge closes the exact transport when hello misses its deadline", { timeout: 5_000 }, async () => {
  const pipeName = `gamebuddy_farmhand_deadline_${process.pid}_${Date.now()}`;
  let peer: Socket | undefined;
  let resolvePeerClosed!: () => void;
  const peerClosed = new Promise<void>((resolve) => { resolvePeerClosed = resolve; });
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
      () => LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 50),
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
});
