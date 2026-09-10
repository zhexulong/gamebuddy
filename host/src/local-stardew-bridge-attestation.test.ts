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
import type { GameConnection } from "./game-connection.js";
import { LocalStardewBridgeClient } from "./local-stardew-bridge.js";
import type { BridgeMessage, ExecutionReceipt, Scope, Snapshot } from "./protocol.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";
import {
  createStardewIntegrationLaunchHandleFromAuthenticatedBridge,
  getAuthenticatedStardewPresentationPortForPreview,
  STARDEW_INTEGRATION_LAUNCHER,
} from "./stardew-integration-launcher.js";
import {
  assertAuthenticatedStardewConnection,
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
            payload: request.type === "program_verify"
              ? { accepted: true, catalogRevision: 1, diagnostics: [] }
              : { code: "rejected", verification: { accepted: false, catalogRevision: 1, diagnostics: [{ severity: "error", code: "policy_denied", nodeId: null, path: "program", message: "policy_denied" }] }, snapshot: null },
          }));
        else if (request.type === "program_status")
          socket.write(frame({
            ...request,
            messageId: "mod_program_status_attestation",
            type: "program_status_result",
            payload: {
              code: "found",
              snapshot: { programId: request.payload.programId, state: "active", catalogRevision: 1, stopEpoch: 0, eventHighWater: 0, nodes: [] },
            },
          }));
        else if (request.type === "program_events")
          socket.write(frame({
            ...request,
            messageId: "mod_program_events_attestation",
            type: "program_events_result",
            payload: {
              programId: request.payload.programId,
              code: "found",
              nextCursor: request.payload.cursor + 1,
              highWater: request.payload.cursor + 1,
              events: [{ cursor: request.payload.cursor + 1, programId: request.payload.programId, kind: "accepted", catalogRevision: 1, nodeId: null, nodeAttempt: null }],
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
       continuityId,
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
              { code: "found", snapshot: { programId: "program_01", state: "active", catalogRevision: 1, stopEpoch: 0, eventHighWater: 0, nodes: [] } },
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
      playerId: "player_attestation", companionId: scope.companionId, continuityId, saveId: scope.saveId, worldId: scope.worldId,
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
      assert.deepEqual(verified.details, { accepted: true, catalogRevision: 1, diagnostics: [] });
      assert.deepEqual(submitted.details, { code: "rejected", verification: { accepted: false, catalogRevision: 1, diagnostics: [{ severity: "error", code: "policy_denied", nodeId: null, path: "program", message: "policy_denied" }] }, snapshot: null });
      assert.deepEqual(status.details, { code: "found", snapshot: { programId: "program_01", state: "active", catalogRevision: 1, stopEpoch: 0, eventHighWater: 0, nodes: [] } });
      assert.deepEqual(events.details, { programId: "program_01", code: "found", nextCursor: 8, highWater: 8, events: [{ cursor: 8, programId: "program_01", kind: "accepted", catalogRevision: 1, nodeId: null, nodeAttempt: null }] });
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
      playerId: "player_attestation", companionId: scope.companionId, continuityId, saveId: scope.saveId, worldId: scope.worldId,
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
    const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(client, Object.freeze({ playerId: "player_attestation", companionId: scope.companionId, continuityId, saveId: scope.saveId, worldId: scope.worldId }));
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
    const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(client, Object.freeze({ playerId: "player_attestation", companionId: scope.companionId, continuityId, saveId: scope.saveId, worldId: scope.worldId }));
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
  let resolveStatusSent!: () => void;
  const statusSent = new Promise<void>((resolve) => { resolveStatusSent = resolve; });
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000);
    const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(client, Object.freeze({ playerId: "player_attestation", companionId: scope.companionId, continuityId, saveId: scope.saveId, worldId: scope.worldId }));
    const binding = await receiptBackedBinding(launch);
    let materialized: Awaited<ReturnType<ReturnType<typeof createHostGameRuntimeMaterializer>["materializeEnter"]>> | undefined;
    try {
      materialized = await binding.executeWithBinding((bindingToken) => withConsumedBindingExecution(bindingToken, (execution) => createHostGameRuntimeMaterializer().materializeEnter(reserveGameRuntimeMaterialization(execution), enterPermit(execution))));
      const runtime = observeMaterializedProductionRuntimeForTest(materialized);
       const beforeRefresh = runtime.session.agent.state.tools.find((tool) => tool.name === "stardew_action_program_status")!;
       await runtime.refreshIntegrationTools?.();
       const status = runtime.session.agent.state.tools.find((tool) => tool.name === "stardew_action_program_status")!;
       assert.notEqual(status, beforeRefresh);
        const started = status.execute("draining_status", { programId: "program_05" }, new AbortController().signal, () => undefined);
        await Promise.race([
          statusSent,
          delay(1_000).then(() => { throw new Error("status_request_not_observed"); }),
        ]);
        const closing = materialized.close();
       await assert.rejects(() => status.execute("revoked_status", { programId: "program_05" }, new AbortController().signal, () => undefined), /action_program_runtime_unavailable/);
      assert.equal(requests.filter((request) => request.type === "program_status").length, 1);
      assert.ok(heldStatus);
      heldSocket!.write(frame({ ...heldStatus, messageId: "status_drain_attestation", type: "program_status_result", payload: { code: "found", snapshot: { programId: "program_05", state: "active", catalogRevision: 1, stopEpoch: 0, eventHighWater: 0, nodes: [] } } }));
      await started;
      await closing;
      assert.throws(() => observeMaterializedProductionRuntimeForTest(materialized!), /materialized_runtime_test_observation_unavailable/);
    } finally {
      await materialized?.close();
      await binding.close();
    }
  }, (request, socket) => {
    requests.push(request);
    if (request.type === "program_status") {
      heldStatus = request;
      heldSocket = socket;
      resolveStatusSent();
      return true;
    }
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

test("connection registrar and mint WeakMap stay lexical to the launcher producer; facade exports no registrar", async () => {
  const facadeSource = await readFile(new URL("./game-connection.js", import.meta.url), "utf8");
  assert.doesNotMatch(facadeSource, /registerAuthenticatedStardewConnection/);
  assert.doesNotMatch(facadeSource, /authenticatedStardewConnections/);
  assert.doesNotMatch(facadeSource, /assertAuthenticatedStardewConnection/);
  assert.doesNotMatch(facadeSource, /isAuthenticatedStardewConnectionLive/);
  const producerSource = await readFile(new URL("./stardew-integration-launcher-body-program.internal.js", import.meta.url), "utf8");
  assert.match(producerSource, /const authenticatedStardewConnections = new WeakMap/);
  assert.match(producerSource, /function registerAuthenticatedStardewConnection\(/);
  assert.doesNotMatch(producerSource, /export\s+(?:async\s+)?function\s+registerAuthenticatedStardewConnection/);
  assert.doesNotMatch(producerSource, /export\s*\{[^}]*registerAuthenticatedStardewConnection/);
  const facade = await import("./game-connection.js");
  assert.equal("registerAuthenticatedStardewConnection" in facade, false);
  assert.equal("assertAuthenticatedStardewConnection" in facade, false);
  assert.equal("isAuthenticatedStardewConnectionLive" in facade, false);
  const producer = await import("./stardew-integration-launcher-body-program.internal.js");
  assert.equal("registerAuthenticatedStardewConnection" in producer, false);
  assert.equal("authenticatedStardewConnections" in producer, false);
  assert.equal(typeof producer.assertAuthenticatedStardewConnection, "function");
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

test("exact authentication admits only the minted launch connection and rejects structural copies, forged scopes, and revoked handles", async () => {
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000);
    const launch = await attestedLaunch(client);
    try {
      const real = launch.connection;
      // The minted wrapper is live and drives the exact-identity entry points.
      assert.equal(STARDEW_GAME_INTEGRATION_ADAPTER.actorId(real), scope.playerId);
      assert.equal(STARDEW_GAME_INTEGRATION_ADAPTER.readState(real).connected, true);
      assert.doesNotThrow(() => assertAuthenticatedStardewConnection(real));
      // Structural copies of the wrapper are distinct objects the authenticated
      // association map never minted: every auth-gated entry point rejects them
      // before any identity/state/data is read.
      const realScope = real.scope as unknown as Scope;
      const structuralCopy = Object.freeze({
        ...real,
        state: { ...(real.state as Record<string, unknown>) },
      }) as GameConnection;
      const forgedScope = Object.freeze({
        ...real,
        scope: Object.freeze({ ...realScope, worldId: "world_forged_01" }),
      }) as GameConnection;
      for (const fake of [structuralCopy, forgedScope]) {
        assert.throws(
          () => STARDEW_GAME_INTEGRATION_ADAPTER.readState(fake),
          /stardew_connection_not_authenticated_or_not_live/,
        );
        assert.throws(
          () => STARDEW_GAME_INTEGRATION_ADAPTER.actorId(fake),
          /stardew_connection_not_authenticated_or_not_live/,
        );
        assert.throws(
          () => STARDEW_GAME_INTEGRATION_ADAPTER.worldScope(fake),
          /stardew_connection_not_authenticated_or_not_live/,
        );
        assert.throws(
          () => STARDEW_GAME_INTEGRATION_ADAPTER.status(fake),
          /stardew_connection_not_authenticated_or_not_live/,
        );
        assert.throws(
          () => STARDEW_GAME_INTEGRATION_ADAPTER.createToolSet({ connection: fake }),
          /stardew_connection_not_authenticated_or_not_live/,
        );
        assert.throws(
          () => STARDEW_GAME_INTEGRATION_ADAPTER.cancelExecution(fake, "req_01", "exec_01", "cancelled"),
          /stardew_connection_not_authenticated_or_not_live/,
        );
      }
      // Revocation: the exact wrapper stops being live once the launch closes.
      launch.close();
      assert.throws(
        () => assertAuthenticatedStardewConnection(real),
        /stardew_connection_not_authenticated_or_not_live/,
      );
      assert.throws(
        () => STARDEW_GAME_INTEGRATION_ADAPTER.readState(real),
        /stardew_connection_not_authenticated_or_not_live/,
      );
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
        "location=Farm;target=crop_abcdef0123456789;tile=38,18;before_watered=false;after_watered=true;water_before=40;water_after=39;water_consumed=true",
    },
  };
  let socket!: Socket;
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000);
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
      assert.deepEqual(view.registrations, [{
        actionId: "move_to_tile",
        familyId: "movement_navigation",
        identityVersion: 1,
        lifecycle: "published",
        kind: "execution",
      }]);
      assert.equal(view.snapshotRevision, 1);
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
        "location=Farm;target=crop_abcdef0123456789;tile=38,18;before_watered=false;after_watered=true;water_before=40;water_after=39;water_consumed=true",
      );
      // Save/world identity is bound to the authenticated scope and verified
      // through assertIdentityBinding; readState never re-exposes it.
      for (const forbidden of ["saveId", "worldId", "playerId", "companionId", "sessionBinding", "attachmentGeneration"])
        assert.equal(Object.hasOwn(view, forbidden), false, forbidden);
    } finally {
      launch.close();
    }
  }, (_request, currentSocket) => { socket = currentSocket; });
});

test("exact authenticated launch handle keeps catalog capabilityRevision independent from snapshot revision", async () => {
  let socket!: Socket;
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000);
    const launch = await attestedLaunch(client);
    try {
      const initial = STARDEW_GAME_INTEGRATION_ADAPTER.readState(launch.connection);
      assert.equal(initial.capabilityRevision, 1);
      assert.equal(initial.snapshotRevision, 1);
      assert.deepEqual(initial.enabledActionIds, ["move_to_tile"]);
      // A fresh Mod snapshot advances the world observation without publishing a
      // new catalog: snapshotRevision moves, capabilityRevision does not.
      socket.write(snapshotFrame({
        revision: 2,
        location: "Farm",
        tile: { x: 6, y: 9 },
        stamina: 240,
        health: 100,
        actionable: true,
        capabilities: ["move_to_tile"],
        catalogRevision: 1,
        enabledActionIds: ["move_to_tile"],
        presentationLocale: "en-US",
        activeExecution: null,
      }));
      await until(() => client.state.snapshot?.revision === 2, "second_snapshot_not_admitted");
      const advanced = STARDEW_GAME_INTEGRATION_ADAPTER.readState(launch.connection);
      assert.equal(advanced.snapshotRevision, 2);
      assert.equal(advanced.capabilityRevision, 1);
      assert.notEqual(advanced.capabilityRevision, advanced.snapshotRevision);
    } finally {
      launch.close();
    }
  }, (_request, currentSocket) => { socket = currentSocket; });
});

test("exact authenticated launch handle projects an in-flight snapshot execution without synthesizing a receipt", async () => {
  let socket!: Socket;
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000);
    const launch = await attestedLaunch(client);
    try {
      socket.write(snapshotFrame({
        revision: 2,
        location: "Farm",
        tile: { x: 5, y: 8 },
        stamina: 250,
        health: 100,
        actionable: true,
        capabilities: ["move_to_tile"],
        catalogRevision: 1,
        enabledActionIds: ["move_to_tile"],
        presentationLocale: "en-US",
        activeExecution: {
          executionId: "exec_active_01",
          requestId: "req_active_01",
          action: "move_to_tile",
          state: "accepted",
          reasonCode: "started",
          evidence: null,
        },
      }));
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
        STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
          "move_to_tile",
          { state: "accepted", reasonCode: "started", evidence: null },
        ),
        false,
      );
    } finally {
      launch.close();
    }
  }, (_request, currentSocket) => { socket = currentSocket; });
});

test("exact authenticated launch handle enforces the exact save/world/companion identity binding", async () => {
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000);
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
        () => STARDEW_GAME_INTEGRATION_ADAPTER.assertIdentityBinding(launch.connection, { companionId: scope.companionId }),
        /integration_identity_binding_mismatch/,
      );
    } finally {
      launch.close();
    }
  });
});

test("exact authenticated launch handle projects a redacted adapter-neutral world scope", async () => {
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000);
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
    const client = await LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000);
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
    const client = await LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000);
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
test("invalidated execution receipt immediately closes launcher-owned preview and materializer projections", async () => {
  let socket!: Socket;
  await withHelloAck("farmhand_client", generation, async (pipeName) => {
    const client = await LocalStardewBridgeClient.connectFarmhand(scope, pipeName, token, generation, Date.now() + 5_000);
    const launch = await attestedLaunch(client);
    const binding = await receiptBackedBinding(launch);
    try {
      // Both launcher-owned projections admit while the execution is live.
      assert.ok(getAuthenticatedStardewPresentationPortForPreview(launch));
      await binding.executeWithBinding((bindingToken) => withConsumedBindingExecution(bindingToken, (execution) =>
        materializeExactEnter(
          reserveGameRuntimeMaterialization(execution),
          enterPermit(execution),
          async (current, admission) => {
            assert.deepEqual(
              Object.keys(materializeAuthenticatedStardewLaunchPorts(current, admission)).sort(),
              ["bodyProgram", "presentation"],
            );
            // A Mod invalidated receipt closes the launcher-owned record used by
            // preview/materializer immediately; the native mutation is not
            // replayed, retried, or closed (the pipe stays connected).
            socket.write(receiptFrame({
              executionId: "exec_invalidated_01",
              requestId: "req_invalidated_01",
              actionId: "move_to_tile",
              state: "invalidated",
              reasonCode: "reason_invalidated",
              revision: 3,
              evidence: null,
            }));
            await until(() => client.state.latestReceipt?.state === "invalidated", "invalidated_receipt_not_delivered");
            assert.equal(client.state.connected, true);
            assert.equal(launch.connection.executionGate?.executable, false);
            assert.throws(
              () => materializeAuthenticatedStardewLaunchPorts(current, admission),
              /authenticated_stardew_launch_ports_required/,
            );
            assert.throws(
              () => getAuthenticatedStardewPresentationPortForPreview(launch),
              /authenticated_stardew_presentation_port_required/,
            );
            return Object.freeze({ session: Object.freeze({ dispose: () => undefined }) });
          },
        ),
      ));
    } finally {
      await binding.close();
    }
  }, (_request, currentSocket) => { socket = currentSocket; });
});