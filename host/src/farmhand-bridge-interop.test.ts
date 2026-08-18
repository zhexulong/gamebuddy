import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Readable } from "node:stream";
import test from "node:test";

import { CompanionLoop } from "./companion-loop.js";
import { CompanionHostService, GameTurnLineageTracker, createGamePresentationAdmissionProvider } from "./host-service.js";
import {
  createFarmhandCompanionPresentationPort,
  createFarmhandPresentationEpochAdmission,
  type FarmhandPresentationBridge,
} from "./farmhand-companion-presentation.js";
import { LocalStardewBridgeClient } from "./local-stardew-bridge.js";
import { NamedPipeTransport } from "./named-pipe.js";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { newEnvelope, validateBridgeMessage, type BridgeMessage, type Scope } from "./protocol.js";
import { DEFAULT_COMPANION_MODEL_CONFIG, createGameCompanionRuntime } from "./runtime.js";
import { STARDEW_INTEGRATION_LAUNCHER } from "./stardew-integration-launcher.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const helperPath = resolve(
  repositoryRoot,
  "integrations/stardew/tests/bin/Release/net6.0/FarmhandBridgeInterop.Contract.dll",
);
const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "farmhand_01",
  companionId: "companion_01",
};
const token = "farmhand_bridge_interop_token_1234";
type InteropProcess = ChildProcessByStdio<null, Readable, Readable>;

async function waitForLine(process: InteropProcess, expected: string, observed: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    let poll: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => finish(new Error(`interop_helper_ready_timeout:${observed.join(",")}`)), 25_000);
    const onClose = (code: number | null) => finish(new Error(`interop_helper_exited_before_ready:${code ?? "signal"}`));
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      if (poll !== undefined) clearInterval(poll);
      process.off("close", onClose);
      if (error === undefined) resolvePromise();
      else reject(error);
    };
    if (observed.includes(expected)) {
      finish();
      return;
    }
    process.once("close", onClose);
    poll = setInterval(() => {
      if (observed.includes(expected)) finish();
    }, 5);
  });
}

async function beforeDeadline<T>(
  work: Promise<T>,
  label: string,
  observed: readonly string[],
  timeoutMs = 10_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolvePromise, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label}_timeout:${observed.join(",")}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function exit(process: InteropProcess): Promise<void> {
  if (process.exitCode !== null) return;
  const closed = once(process, "close");
  process.kill();
  await closed;
}

function isPipeListenerNotReady(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

async function connectAfterPipeListen<T>(pipeName: string, connect: () => Promise<T>): Promise<T> {
  const deadlineMs = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadlineMs) {
    try {
      return await connect();
    } catch (error) {
      lastError = error;
      if (!isPipeListenerNotReady(error)) throw error;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  throw lastError;
}

async function artifactLauncherUrl(): Promise<string> {
  const currentPath = resolve(repositoryRoot, "host", "dist", "current.json");
  const current = JSON.parse(await readFile(currentPath, "utf8")) as { generation?: unknown };
  const generation = current.generation;
  assert.equal(typeof generation, "string");
  if (typeof generation !== "string") throw new Error("interop_artifact_generation_invalid");
  assert.match(generation, /^g-[a-z0-9-]+$/);
  const modulePath = resolve(repositoryRoot, "host", "dist", "generations", generation, "stardew-integration-launcher.js");
  assert.equal(existsSync(modulePath), true);
  return pathToFileURL(modulePath).href;
}

function nextMessage(
  transport: NamedPipeTransport,
  predicate: (message: BridgeMessage) => boolean,
): Promise<BridgeMessage> {
  return new Promise<BridgeMessage>((resolvePromise) => {
    const unsubscribe = transport.onMessage((json) => {
      const message = JSON.parse(json) as BridgeMessage;
      if (!predicate(message)) return;
      unsubscribe();
      resolvePromise(message);
    });
  });
}

/**
 * Test-only lineage tracker that resolves after Pi settlement closes the batch.
 * It reuses the exact production endBatch authority: an endBatch that does not
 * observe exactly one presentation throws inside the production tracker, so a
 * missing or duplicated source-bound presentation cannot satisfy this promise.
 */
class SettledLineageTracker extends GameTurnLineageTracker {
  readonly #endBatchResolvers: Array<() => void> = [];
  waitForEndBatch(): Promise<void> {
    return new Promise<void>((resolvePromise) => this.#endBatchResolvers.push(resolvePromise));
  }
  public override endBatch(): void {
    super.endBatch();
    const resolvers = this.#endBatchResolvers.splice(0);
    for (const resolvePromise of resolvers) resolvePromise();
  }
}


test("Farmhand C# LocalPipeBridge delivers an idle semantic event to the production Node transport", async () => {
  assert.equal(existsSync(helperPath), true, "build the FarmhandBridgeInterop.Contract before this test");
  const pipeName = `gamebuddy_interop_raw_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const helper = spawn("dotnet", [helperPath, pipeName], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const stderr: Buffer[] = [];
  const observed: string[] = [];
  helper.stdout.on("data", (chunk: Buffer) => observed.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean)));
  helper.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  try {
    await waitForLine(helper, "farmhand_bridge_interop_ready", observed);
    const transport = await beforeDeadline(
      connectAfterPipeListen(pipeName, () => NamedPipeTransport.connect(pipeName)),
      "interop_raw_connect",
      observed,
    );
    const hello = nextMessage(transport, (message) => message.type === "hello_ack");
    transport.send(newEnvelope("hello", scope, { token }));
    await beforeDeadline(hello, "interop_raw_hello", observed);
    const snapshot = nextMessage(transport, (message) => message.type === "snapshot");
    transport.send(newEnvelope("observe_request", scope, {}));
    await beforeDeadline(snapshot, "interop_raw_snapshot", observed);
    const event = await beforeDeadline(
      nextMessage(transport, (message) => message.type === "semantic_event"),
      "interop_raw_player_input",
      observed,
    );
    assert.equal(validateBridgeMessage(event, scope), null, JSON.stringify(event));
    assert.equal(event.type, "semantic_event");
    assert.equal(event.payload.kind, "player_input");
    transport.close();
  } finally {
    await exit(helper);
  }

  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
});

test("Farmhand C# action execution crosses the production Node/C# pipe and returns an exact typed receipt", async () => {
  assert.equal(existsSync(helperPath), true, "build the FarmhandBridgeInterop.Contract before this test");
  const pipeName = `gamebuddy_farmhand_action_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const helper = spawn("dotnet", [helperPath, pipeName, "50", "await-farmhand-action-receipt"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr: Buffer[] = [];
  const observed: string[] = [];
  helper.stdout.on("data", (chunk: Buffer) => observed.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean)));
  helper.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  try {
    await waitForLine(helper, "farmhand_bridge_interop_ready", observed);
    const client = await beforeDeadline(
      connectAfterPipeListen(pipeName, () => LocalStardewBridgeClient.connect(scope, pipeName, token)),
      "interop_farmhand_action_connect",
      observed,
    );
    const snapshot = await beforeDeadline(client.observe(), "interop_farmhand_action_observe", observed);
    assert.ok(snapshot.capabilities.includes("machine_inspect"));
    const receipt = await beforeDeadline(
      client.execute({
        requestId: "farmhand_action_request_01",
        idempotencyKey: "farmhand_action_idempotency_01",
        action: "machine_inspect",
        args: { x: 1, y: 1, expectedTargetId: "machine_target_contract" },
        expectedRevision: snapshot.revision,
        deadlineMs: Date.now() + 10_000,
      }),
      "interop_farmhand_action_execute",
      observed,
    );
    assert.equal(receipt.requestId, "farmhand_action_request_01");
    assert.equal(receipt.state, "rejected");
    assert.equal(receipt.reasonCode, "world_not_ready");
    assert.equal(typeof receipt.executionId, "string");
    assert.ok(receipt.executionId.length > 0);
    await beforeDeadline(
      waitForLine(helper, "farmhand_bridge_interop_farmhand_action_receipt_delivered", observed),
      "interop_farmhand_action_receipt_delivery_marker",
      observed,
    );
    client.close();
  } finally {
    await exit(helper);
  }

  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
});

test("Farmhand C# LocalPipeBridge delivers an idle player_input frame to the production Node client", async () => {
  assert.equal(existsSync(helperPath), true, "build the FarmhandBridgeInterop.Contract before this test");
  const pipeName = `gamebuddy_interop_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const helper = spawn("dotnet", [helperPath, pipeName], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr: Buffer[] = [];
  const observed: string[] = [];
  helper.stdout.on("data", (chunk: Buffer) => observed.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean)));
  helper.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  try {
    await waitForLine(helper, "farmhand_bridge_interop_ready", observed);
    const client = await beforeDeadline(
      connectAfterPipeListen(pipeName, () => LocalStardewBridgeClient.connect(scope, pipeName, token)),
      "interop_connect",
      observed,
    );
    const diagnostics: Readonly<{ stage: string; reasonCode: string }>[] = [];
    const forwardedTypes: string[] = [];
    const connectionReasons: string[] = [];
    const received = new Promise<Extract<Parameters<typeof client.onFact>[0] extends (fact: infer T) => void ? T : never, { type: "semantic_event" }>>(
      (resolvePromise) => {
        client.onFact((fact) => {
          forwardedTypes.push(fact.type);
          if (fact.type === "semantic_event" && fact.payload.kind === "player_input") resolvePromise(fact);
        });
      },
    );
    client.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    client.onConnectionFact((fact) => connectionReasons.push(fact.reasonCode));

    const snapshot = await beforeDeadline(client.observe(), "interop_observe", observed);
    assert.equal(snapshot.revision, 0);
    const fact = await beforeDeadline(received, `interop_player_input:forwarded=${forwardedTypes.join(",")}:diagnostics=${diagnostics.map((item) => `${item.stage}:${item.reasonCode}`).join(",")}:closed=${connectionReasons.join(",")}`, observed);
    assert.equal(fact.payload.playerControl?.sourceEventId, "source_01");
    assert.equal(fact.payload.playerControl?.text, "你好");
    assert.ok(
      diagnostics.filter((item) => item.stage === "native_chat_pipe_data_received" && item.reasonCode === "received").length >= 1,
    );
    const nonChunkDiagnostics = diagnostics.filter(
      (item) => item.stage !== "native_chat_pipe_data_received",
    );
    assert.deepEqual(nonChunkDiagnostics, [
      { stage: "native_chat_bridge_inbound_frame_received", reasonCode: "received" },
      { stage: "native_chat_bridge_player_control_validated", reasonCode: "accepted" },
    ]);
    client.close();
  } finally {
    await exit(helper);
  }

  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
});

test("Farmhand C# player_input reaches the production Stardew adapter event source and fixed stdout stage", async () => {
  assert.equal(existsSync(helperPath), true, "build the FarmhandBridgeInterop.Contract before this test");
  const pipeName = `gamebuddy_interop_adapter_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const helper = spawn("dotnet", [helperPath, pipeName], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr: Buffer[] = [];
  const observed: string[] = [];
  helper.stdout.on("data", (chunk: Buffer) => observed.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean)));
  helper.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const originalDebug = console.debug;
  const stages: string[] = [];
  console.debug = (value: unknown) => {
    if (typeof value === "string") stages.push(value);
  };

  try {
    await waitForLine(helper, "farmhand_bridge_interop_ready", observed);
    const launch = await beforeDeadline(
      connectAfterPipeListen(pipeName, async () =>
        await STARDEW_INTEGRATION_LAUNCHER.launch({
          identity: {
            playerId: scope.playerId,
            companionId: scope.companionId,
            saveId: scope.saveId,
            worldId: scope.worldId,
          },
          config: { pipeName, bridgeToken: token, expectedPresentationLocale: "zh-CN" },
        }),
      ),
      "interop_adapter_launch",
      observed,
    );
    const received = new Promise<void>((resolvePromise) => {
      launch.events.onFact((fact) => {
        if (fact.kind === "semantic_event" && fact.payload.kind === "player_input") resolvePromise();
      });
    });
    await beforeDeadline(received, "interop_adapter_player_input", observed);
    const rawDataStage = "GameBuddy native chat ingress stage=native_chat_pipe_data_received:received";
    assert.ok(
      stages.filter((stage) => stage === rawDataStage).length >= 1,
      "the socket must publish at least one raw-data observation before frame handling",
    );
    assert.deepEqual(
      stages.filter((stage) => stage !== rawDataStage),
      [
        "GameBuddy native chat ingress stage=native_chat_bridge_inbound_frame_received:received",
        "GameBuddy native chat ingress stage=native_chat_bridge_player_control_validated:accepted",
        "GameBuddy native chat ingress stage=native_chat_adapter_fact_forwarded",
      ],
    );
    launch.close();
  } finally {
    console.debug = originalDebug;
    await exit(helper);
  }

  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
});

test("Farmhand adapter acknowledges player_input only after its Host listener returns", async () => {
  assert.equal(existsSync(helperPath), true, "build the FarmhandBridgeInterop.Contract before this test");
  const pipeName = `gamebuddy_interop_receipt_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const helper = spawn("dotnet", [helperPath, pipeName, "50", "await-player-control-receipt"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr: Buffer[] = [];
  const observed: string[] = [];
  helper.stdout.on("data", (chunk: Buffer) => observed.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean)));
  helper.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  try {
    await waitForLine(helper, "farmhand_bridge_interop_ready", observed);
    const launch = await beforeDeadline(
      connectAfterPipeListen(pipeName, async () =>
        await STARDEW_INTEGRATION_LAUNCHER.launch({
          identity: {
            playerId: scope.playerId,
            companionId: scope.companionId,
            saveId: scope.saveId,
            worldId: scope.worldId,
          },
          config: { pipeName, bridgeToken: token, expectedPresentationLocale: "zh-CN" },
        }),
      ),
      "interop_receipt_adapter_launch",
      observed,
    );
    const listenerReturned = new Promise<void>((resolvePromise) => {
      launch.events.onFact((fact) => {
        if (fact.kind === "semantic_event" && fact.payload.kind === "player_input") resolvePromise();
      });
    });
    await beforeDeadline(listenerReturned, "interop_receipt_player_input", observed);
    await beforeDeadline(
      waitForLine(helper, "farmhand_bridge_interop_player_input_host_accepted", observed),
      "interop_receipt_host_acceptance",
      observed,
    );
    launch.close();
  } finally {
    await exit(helper);
  }

  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
});

test("Farmhand adapter exposes an authenticated presentation capability that receives a C# receipt", async () => {
  assert.equal(existsSync(helperPath), true, "build the FarmhandBridgeInterop.Contract before this test");
  const pipeName = `gamebuddy_interop_presentation_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const helper = spawn("dotnet", [helperPath, pipeName, "50", "await-companion-presentation-receipt"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr: Buffer[] = [];
  const observed: string[] = [];
  helper.stdout.on("data", (chunk: Buffer) => observed.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean)));
  helper.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  try {
    await waitForLine(helper, "farmhand_bridge_interop_ready", observed);
    const launch = await beforeDeadline(
      connectAfterPipeListen(pipeName, async () =>
        await STARDEW_INTEGRATION_LAUNCHER.launch({
          identity: { playerId: scope.playerId, companionId: scope.companionId, saveId: scope.saveId, worldId: scope.worldId },
          config: { pipeName, bridgeToken: token, expectedPresentationLocale: "zh-CN" },
        }),
      ),
      "interop_presentation_adapter_launch",
      observed,
    );
    assert.ok(launch.presentationBridge instanceof LocalStardewBridgeClient);
    await beforeDeadline(
      launch.presentationBridge.presentCompanionText({
        expressionId: "expression_01",
        sourceEventId: "source_01",
        text: "Bridge receipt.",
        locale: "zh-CN",
        expectedRevision: 0,
        presentationEpoch: 0,
      }),
      "interop_presentation_bridge_receipt",
      observed,
    );
    await beforeDeadline(
      waitForLine(helper, "farmhand_bridge_interop_companion_presentation_accepted", observed),
      "interop_presentation_csharp_receipt",
      observed,
    );
    launch.close();
  } finally {
    await exit(helper);
  }

  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
});

test("Farmhand C# player_input sourceEventId crosses Pi consumption into the C# presentation receipt", async () => {
  assert.equal(existsSync(helperPath), true, "build the FarmhandBridgeInterop.Contract before this test");
  // The source/test artifact is deliberately not a production artifact, so its
  // default resolver rejects repository helpers. This test explicitly mints
  // the build-only capability needed by identity-profile's path-lock release.
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  const pipeName = `gamebuddy_interop_source_bound_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const helper = spawn("dotnet", [helperPath, pipeName, "50", "await-source-bound-presentation-receipt"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr: Buffer[] = [];
  const observed: string[] = [];
  helper.stdout.on("data", (chunk: Buffer) => observed.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean)));
  helper.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-source-bound-presentation-"));
  let launch: Awaited<ReturnType<typeof STARDEW_INTEGRATION_LAUNCHER.launch>> | undefined;
  let runtime: Awaited<ReturnType<typeof createGameCompanionRuntime>> | undefined;
  let host: CompanionHostService | undefined;
  let piListener: ((event: unknown) => void) | undefined;

  try {
    await waitForLine(helper, "farmhand_bridge_interop_ready", observed);
    launch = await beforeDeadline(
      connectAfterPipeListen(pipeName, async () =>
        await STARDEW_INTEGRATION_LAUNCHER.launch({
          identity: { playerId: scope.playerId, companionId: scope.companionId, saveId: scope.saveId, worldId: scope.worldId },
          config: { pipeName, bridgeToken: token, expectedPresentationLocale: "zh-CN" },
        }),
      ),
      "interop_source_bound_adapter_launch",
      observed,
    );
    // One private tracker is shared by the Host batch lifecycle and the game
    // presentation admission provider, exactly like the Preview composition.
    const turnTracker = new SettledLineageTracker();
    runtime = await createGameCompanionRuntime(
      { playerId: scope.playerId, companionId: scope.companionId, saveId: scope.saveId, worldId: scope.worldId },
      root,
      launch.connection,
      "source_bound_session_01",
      undefined,
      undefined,
      {
        modelConfig: DEFAULT_COMPANION_MODEL_CONFIG,
        gameplaySubagentEnabled: false,
        disableMagicContextMemory: true,
        hostBindingFactory: (handle) =>
          Object.freeze({
            profile: Object.freeze({ locale: "zh-CN", text: true, speech: null }),
            surface: "game" as const,
            sessionId: "source_bound_session_01",
            textPort: createFarmhandCompanionPresentationPort(
              launch!.presentationBridge as FarmhandPresentationBridge,
              createFarmhandPresentationEpochAdmission(handle.interruption),
            ),
            admissionProvider: createGamePresentationAdmissionProvider(turnTracker, handle.interruption),
          }),
      },
    );
    let resolvePiAccepted!: () => void;
    const piAccepted = new Promise<void>((resolvePromise) => {
      resolvePiAccepted = resolvePromise;
    });
    const loop = new CompanionLoop(
      {
        async sendUserMessage(text: string) {
          // Pi consumes the exact serialized batch: only the matching
          // message_start may open the source-bound presentation lineage.
          piListener?.({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
        },
        async abort() {},
        clearQueue() {},
        async waitForIdle() {},
        subscribe(next: (event: unknown) => void) {
          piListener = next;
          return () => {
            piListener = undefined;
          };
        },
      } as never,
      undefined,
      {
        nativePlayerInputObserved() {},
        nativeStopAllObserved() {},
        piTurnAccepted() {
          resolvePiAccepted();
        },
        piTurnSettled() {},
        stopSealed() {},
        stopSettled() {},
        stopUncertain() {},
        oldEpochQuiet() {},
        bodySettled() {},
      },
    );
    host = new CompanionHostService(
      loop,
      launch.events,
      undefined,
      runtime.interruption,
      runtime.cancelIntegrationEpoch,
      undefined,
      turnTracker,
      runtime.bindIntegrationReceipt,
    );
    // The observer must be attached before the buffered/ingress fact flush runs
    // on a later microtask, or beginPlayerBatch would be discarded.
    loop.attachTurnObserver(host);
    // The launcher delivered the startup-buffered player_input into the Host
    // listener (or the live ingress did); Pi consumed the exact batch and
    // opened the presentation lineage for the authenticated event id source_01.
    await beforeDeadline(piAccepted, "interop_source_bound_pi_batch_accepted", observed);

    const textTool = runtime.session.agent.state.tools.find((tool) => tool.name === "companion_text");
    assert.ok(textTool, "the game Host binding must mount the companion_text presentation tool");
    const result = await textTool!.execute(
      "source-bound-presentation-e2e",
      { text: "我在这里。" },
      new AbortController().signal,
    );
    // The C# helper rejects any companion_presentation_request whose source
    // differs from source_01 and only then returns its receipt; this marker
    // proves the same authenticated event id crossed the whole chain.
    await beforeDeadline(
      waitForLine(helper, "farmhand_bridge_interop_source_bound_presentation_accepted", observed),
      "interop_source_bound_presentation_receipt",
      observed,
    );
    // Pi settlement closes the batch; the production tracker requires exactly
    // one presentation, so this also proves the presentation committed once.
    piListener?.({ type: "agent_settled" });
    await beforeDeadline(turnTracker.waitForEndBatch(), "interop_source_bound_end_batch", observed);
    assert.match(
      result.content[0]?.type === "text" ? result.content[0].text : "",
      /expression/,
      "the presentation tool must report its committed expression id",
    );
    assert.equal(
      observed.includes("farmhand_bridge_interop_source_bound_player_input_enqueued"),
      true,
      "the helper must publish the typed player_input before the presentation",
    );
  } finally {
    host?.close();
    runtime?.session.dispose();
    launch?.close();
    await exit(helper);
    await rm(root, { recursive: true, force: true });
  }

  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
});

test("Farmhand Preview runtime remains pipe-responsive after mounting without Magic Context", async () => {
  assert.equal(existsSync(helperPath), true, "build the FarmhandBridgeInterop.Contract before this test");
  // The source/test artifact is deliberately not a production artifact, so its
  // default resolver rejects repository helpers. This test explicitly mints
  // the build-only capability needed by identity-profile's path-lock release.
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  const pipeName = `gamebuddy_interop_preview_runtime_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-preview-runtime-interop-"));
  const helper = spawn("dotnet", [helperPath, pipeName, "2000", "await-player-control-receipt"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr: Buffer[] = [];
  const observed: string[] = [];
  helper.stdout.on("data", (chunk: Buffer) => observed.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean)));
  helper.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  let launch: Awaited<ReturnType<typeof STARDEW_INTEGRATION_LAUNCHER.launch>> | undefined;
  let runtime: Awaited<ReturnType<typeof createGameCompanionRuntime>> | undefined;
  let host: CompanionHostService | undefined;

  try {
    await waitForLine(helper, "farmhand_bridge_interop_ready", observed);
    launch = await beforeDeadline(
      connectAfterPipeListen(pipeName, async () =>
        await STARDEW_INTEGRATION_LAUNCHER.launch({
          identity: { playerId: scope.playerId, companionId: scope.companionId, saveId: scope.saveId, worldId: scope.worldId },
          config: { pipeName, bridgeToken: token, expectedPresentationLocale: "zh-CN" },
        }),
      ),
      "interop_preview_runtime_adapter_launch",
      observed,
    );
    runtime = await createGameCompanionRuntime(
      {
        playerId: scope.playerId,
        companionId: scope.companionId,
        saveId: scope.saveId,
        worldId: scope.worldId,
      },
      root,
      launch.connection,
      "preview_runtime_interop_01",
      undefined,
      undefined,
      {
        modelConfig: DEFAULT_COMPANION_MODEL_CONFIG,
        gameplaySubagentEnabled: false,
        disableMagicContextMemory: true,
        hostBindingFactory: () => undefined,
      },
    );
    assert.deepEqual(runtime.extensions, []);
    // This loop accepts the Host-enqueued input without calling a provider. The
    // receipt still requires the production adapter to synchronously invoke Host.
    const loop = new CompanionLoop({ sendUserMessage: async () => undefined });
    host = new CompanionHostService(
      loop,
      launch.events,
      undefined,
      runtime.interruption,
      runtime.cancelIntegrationEpoch,
      undefined,
      new GameTurnLineageTracker(),
      runtime.bindIntegrationReceipt,
    );
    await beforeDeadline(
      waitForLine(helper, "farmhand_bridge_interop_player_input_host_accepted", observed),
      "interop_preview_runtime_host_acceptance",
      observed,
    );
  } finally {
    host?.close();
    runtime?.session.dispose();
    launch?.close();
    await exit(helper);
    await rm(root, { recursive: true, force: true });
  }

  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
});

test("Farmhand adapter acknowledges a startup-buffered player_input only after its Host listener returns", async () => {
  assert.equal(existsSync(helperPath), true, "build the FarmhandBridgeInterop.Contract before this test");
  const pipeName = `gamebuddy_interop_receipt_buffered_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const helper = spawn("dotnet", [helperPath, pipeName, "50", "await-player-control-receipt"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr: Buffer[] = [];
  const observed: string[] = [];
  helper.stdout.on("data", (chunk: Buffer) => observed.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean)));
  helper.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  try {
    await waitForLine(helper, "farmhand_bridge_interop_ready", observed);
    const launch = await beforeDeadline(
      connectAfterPipeListen(pipeName, async () =>
        await STARDEW_INTEGRATION_LAUNCHER.launch({
          identity: { playerId: scope.playerId, companionId: scope.companionId, saveId: scope.saveId, worldId: scope.worldId },
          config: { pipeName, bridgeToken: token, expectedPresentationLocale: "zh-CN" },
        }),
      ),
      "interop_receipt_buffered_adapter_launch",
      observed,
    );
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 200));
    const delivered: string[] = [];
    launch.events.onFact((fact) => {
      if (fact.kind === "semantic_event" && fact.payload.kind === "player_input") delivered.push("listener");
    });
    await beforeDeadline(
      waitForLine(helper, "farmhand_bridge_interop_player_input_host_accepted", observed),
      "interop_receipt_buffered_host_acceptance",
      observed,
    );
    assert.deepEqual(delivered, ["listener"]);
    launch.close();
  } finally {
    await exit(helper);
  }

  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
});

test("Farmhand adapter acknowledges player_input after every current Host listener returns", async () => {
  assert.equal(existsSync(helperPath), true, "build the FarmhandBridgeInterop.Contract before this test");
  const pipeName = `gamebuddy_interop_receipt_listeners_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const helper = spawn("dotnet", [helperPath, pipeName, "50", "await-player-control-receipt"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr: Buffer[] = [];
  const observed: string[] = [];
  helper.stdout.on("data", (chunk: Buffer) => observed.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean)));
  helper.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  try {
    await waitForLine(helper, "farmhand_bridge_interop_ready", observed);
    const launch = await beforeDeadline(
      connectAfterPipeListen(pipeName, async () =>
        await STARDEW_INTEGRATION_LAUNCHER.launch({
          identity: { playerId: scope.playerId, companionId: scope.companionId, saveId: scope.saveId, worldId: scope.worldId },
          config: { pipeName, bridgeToken: token, expectedPresentationLocale: "zh-CN" },
        }),
      ),
      "interop_receipt_listeners_adapter_launch",
      observed,
    );
    const delivered: string[] = [];
    launch.events.onFact((fact) => {
      if (fact.kind === "semantic_event" && fact.payload.kind === "player_input") delivered.push("first");
    });
    launch.events.onFact((fact) => {
      if (fact.kind === "semantic_event" && fact.payload.kind === "player_input") delivered.push("second");
    });
    await beforeDeadline(
      waitForLine(helper, "farmhand_bridge_interop_player_input_host_accepted", observed),
      "interop_receipt_listeners_host_acceptance",
      observed,
    );
    assert.deepEqual(delivered, ["first", "second"]);
    launch.close();
  } finally {
    await exit(helper);
  }

  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
});

test("Farmhand adapter fails closed without acknowledging player_input when a Host listener throws", { timeout: 20_000 }, async () => {
  assert.equal(existsSync(helperPath), true, "build the FarmhandBridgeInterop.Contract before this test");
  const pipeName = `gamebuddy_interop_receipt_listener_failure_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const helper = spawn("dotnet", [helperPath, pipeName, "50", "await-player-control-receipt"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr: Buffer[] = [];
  const observed: string[] = [];
  helper.stdout.on("data", (chunk: Buffer) => observed.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean)));
  helper.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  try {
    await waitForLine(helper, "farmhand_bridge_interop_ready", observed);
    const launch = await beforeDeadline(
      connectAfterPipeListen(pipeName, async () =>
        await STARDEW_INTEGRATION_LAUNCHER.launch({
          identity: { playerId: scope.playerId, companionId: scope.companionId, saveId: scope.saveId, worldId: scope.worldId },
          config: { pipeName, bridgeToken: token, expectedPresentationLocale: "zh-CN" },
        }),
      ),
      "interop_receipt_listener_failure_adapter_launch",
      observed,
    );
    launch.events.onFact((fact) => {
      if (fact.kind === "semantic_event" && fact.payload.kind === "player_input") throw new Error("listener_failure");
    });
    const [code] = await beforeDeadline(once(helper, "close"), "interop_receipt_listener_failure_helper_close", observed, 15_000);
    assert.notEqual(code, 0);
    assert.equal(observed.includes("farmhand_bridge_interop_player_input_host_accepted"), false);
    launch.close();
  } finally {
    await exit(helper);
  }

  assert.equal(Buffer.concat(stderr).toString("utf8"), "interop_timeout\r\n");
});

test("Farmhand adapter does not acknowledge player_input when the Host listener closes its bridge", { timeout: 20_000 }, async () => {
  assert.equal(existsSync(helperPath), true, "build the FarmhandBridgeInterop.Contract before this test");
  const pipeName = `gamebuddy_interop_receipt_write_failure_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const helper = spawn("dotnet", [helperPath, pipeName, "50", "await-player-control-receipt"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr: Buffer[] = [];
  const observed: string[] = [];
  helper.stdout.on("data", (chunk: Buffer) => observed.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean)));
  helper.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  try {
    await waitForLine(helper, "farmhand_bridge_interop_ready", observed);
    const launch = await beforeDeadline(
      connectAfterPipeListen(pipeName, async () =>
        await STARDEW_INTEGRATION_LAUNCHER.launch({
          identity: { playerId: scope.playerId, companionId: scope.companionId, saveId: scope.saveId, worldId: scope.worldId },
          config: { pipeName, bridgeToken: token, expectedPresentationLocale: "zh-CN" },
        }),
      ),
      "interop_receipt_write_failure_adapter_launch",
      observed,
    );
    launch.events.onFact((fact) => {
      if (fact.kind === "semantic_event" && fact.payload.kind === "player_input") launch.close();
    });
    const [code] = await beforeDeadline(once(helper, "close"), "interop_receipt_write_failure_helper_close", observed, 15_000);
    assert.notEqual(code, 0);
    assert.equal(observed.includes("farmhand_bridge_interop_player_input_host_accepted"), false);
  } finally {
    await exit(helper);
  }

  assert.equal(Buffer.concat(stderr).toString("utf8"), "interop_timeout\r\n");
});

test("Farmhand C# player_input reaches the production adapter from an independent immutable Node process", { timeout: 100_000 }, async () => {
  assert.equal(existsSync(helperPath), true, "build the FarmhandBridgeInterop.Contract before this test");
  const pipeName = `gamebuddy_interop_artifact_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const helper = spawn("dotnet", [helperPath, pipeName, "70000"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const helperStderr: Buffer[] = [];
  const helperObserved: string[] = [];
  helper.stdout.on("data", (chunk: Buffer) => helperObserved.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean)));
  helper.stderr.on("data", (chunk: Buffer) => helperStderr.push(chunk));
  const launcherUrl = await artifactLauncherUrl();
  const childScript = [
    "const [launcherUrl, pipeName, token] = process.argv.slice(1);",
    "if (!launcherUrl || !pipeName || !token) throw new Error('interop_artifact_child_config_required');",
    "const { STARDEW_INTEGRATION_LAUNCHER } = await import(launcherUrl);",
    "const identity = { playerId: 'farmhand_01', companionId: 'companion_01', saveId: 'save_01', worldId: 'world_01' };",
    "let launch; const deadline = Date.now() + 5_000;",
    "for (;;) {",
    "  try { launch = await STARDEW_INTEGRATION_LAUNCHER.launch({ identity, config: { pipeName, bridgeToken: token, expectedPresentationLocale: 'zh-CN' } }); break; }",
    "  catch (error) { if (error?.code !== 'ENOENT' || Date.now() >= deadline) throw error; await new Promise((resolve) => setTimeout(resolve, 25)); }",
    "}",
    "const timeout = setTimeout(() => { launch.close(); process.exit(1); }, 85_000);",
    "launch.events.onFact((fact) => {",
    "  if (fact.kind !== 'semantic_event' || fact.payload.kind !== 'player_input') return;",
    "  clearTimeout(timeout);",
    "  process.stdout.write('artifact_child_player_input_observed\\n', () => { launch.close(); process.exit(0); });",
    "});",
    "process.stdout.write('artifact_child_adapter_ready\\n');",
  ].join("\n");
  const artifact = spawn(process.execPath, ["--input-type=module", "--eval", childScript, launcherUrl, pipeName, token], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const artifactObserved: string[] = [];
  const artifactStderr: Buffer[] = [];
  artifact.stdout.on("data", (chunk: Buffer) => artifactObserved.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean)));
  artifact.stderr.on("data", (chunk: Buffer) => artifactStderr.push(chunk));

  try {
    await waitForLine(helper, "farmhand_bridge_interop_ready", helperObserved);
    await beforeDeadline(
      waitForLine(artifact, "artifact_child_adapter_ready", artifactObserved),
      "interop_artifact_child_ready",
      helperObserved,
    );
    const [code] = await beforeDeadline(
      once(artifact, "close"),
      "interop_artifact_child_player_input",
      helperObserved,
      85_000,
    );
    assert.equal(code, 0, Buffer.concat(artifactStderr).toString("utf8"));
    assert.equal(artifactObserved[0], "artifact_child_adapter_ready");
    assert.ok(
      artifactObserved.filter((stage) => stage === "GameBuddy native chat ingress stage=native_chat_pipe_data_received:received").length >= 1,
    );
    const nonChunkStages = artifactObserved.filter(
      (stage) => stage !== "GameBuddy native chat ingress stage=native_chat_pipe_data_received:received",
    );
    assert.equal(nonChunkStages[0], "artifact_child_adapter_ready");
    assert.equal(
      nonChunkStages.filter((stage) => stage === "GameBuddy native chat ingress stage=native_chat_bridge_inbound_frame_received:received").length,
      1,
    );
    assert.equal(
      nonChunkStages.filter((stage) => stage === "GameBuddy native chat ingress stage=native_chat_bridge_player_control_validated:accepted").length,
      1,
    );
    assert.equal(nonChunkStages.filter((stage) => stage === "GameBuddy native chat ingress stage=native_chat_adapter_fact_forwarded").length, 1);
    assert.equal(nonChunkStages.filter((stage) => stage === "artifact_child_player_input_observed").length, 1);
  } finally {
    await exit(artifact);
    await exit(helper);
  }

  assert.equal(Buffer.concat(helperStderr).toString("utf8"), "");
});

test("Farmhand C# player_input survives a live-equivalent idle interval before the production adapter", async () => {
  assert.equal(existsSync(helperPath), true, "build the FarmhandBridgeInterop.Contract before this test");
  const pipeName = `gamebuddy_interop_idle_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const helper = spawn("dotnet", [helperPath, pipeName, "70000"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr: Buffer[] = [];
  const observed: string[] = [];
  helper.stdout.on("data", (chunk: Buffer) => observed.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean)));
  helper.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const originalDebug = console.debug;
  const stages: string[] = [];
  console.debug = (value: unknown) => {
    if (typeof value === "string") stages.push(value);
  };

  try {
    await waitForLine(helper, "farmhand_bridge_interop_ready", observed);
    const launch = await beforeDeadline(
      connectAfterPipeListen(pipeName, async () =>
        await STARDEW_INTEGRATION_LAUNCHER.launch({
          identity: {
            playerId: scope.playerId,
            companionId: scope.companionId,
            saveId: scope.saveId,
            worldId: scope.worldId,
          },
          config: { pipeName, bridgeToken: token, expectedPresentationLocale: "zh-CN" },
        }),
      ),
      "interop_idle_adapter_launch",
      observed,
    );
    const received = new Promise<void>((resolvePromise) => {
      launch.events.onFact((fact) => {
        if (fact.kind === "semantic_event" && fact.payload.kind === "player_input") resolvePromise();
      });
    });
    await beforeDeadline(received, "interop_idle_adapter_player_input", observed, 85_000);
    assert.ok(
      stages.filter((stage) => stage === "GameBuddy native chat ingress stage=native_chat_pipe_data_received:received").length >= 1,
      "the socket must publish at least one raw-data observation before frame handling",
    );
    assert.deepEqual(
      stages.filter((stage) => stage !== "GameBuddy native chat ingress stage=native_chat_pipe_data_received:received"),
      [
        "GameBuddy native chat ingress stage=native_chat_bridge_inbound_frame_received:received",
        "GameBuddy native chat ingress stage=native_chat_bridge_player_control_validated:accepted",
        "GameBuddy native chat ingress stage=native_chat_adapter_fact_forwarded",
      ],
    );
    launch.close();
  } finally {
    console.debug = originalDebug;
    await exit(helper);
  }

  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
});
