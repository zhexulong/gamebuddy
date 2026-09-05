import assert from "node:assert/strict";
import { type ChildProcess, fork, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test, { before } from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalTestRootSync } from "../test-support/canonical-test-root.test-support.js";
import { createUnmountedDialogueSemanticFacade } from "../continuity-semantic-deployment-composition/continuity-semantic-deployment-composition.js";
import { createCanonicalProductionAuthorityAdmission } from "../continuity-semantic-provisioning/continuity-semantic-provisioning.internal.js";
import {
  openProductionContinuityStore,
  type ProductionBootstrapInput,
  type ProductionChatRuntimeOwner,
  type ProductionChatRuntimeRequest,
  type TavernExactContentReceipt,
} from "../continuity-semantic-store/continuity-semantic-production-store.js";
import { loadHostDeploymentManifest } from "../deployment-manifest.js";
import { createManifestDerivedInitialChatExactContentPort } from "../tavern/initial-chat-exact-content-port.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { authorityRootMutexName } from "../windows-partition-mutex.js";
import * as internalCoordinator from "./continuity-semantic-production-coordinator.internal.js";
import { createInitialChatResumeSemanticProductionAuthorityFromDeploymentManifest } from "./continuity-semantic-production-coordinator.internal.js";
import * as publicCoordinator from "./continuity-semantic-production-coordinator.js";
import {
  createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest,
  createKnownSemanticGameProductionAuthorityFromDeploymentManifest,
  type SemanticGameProductionAuthority,
} from "./continuity-semantic-production-coordinator.js";
import { createTestSemanticChatRuntimeCoordinator } from "./continuity-semantic-production-coordinator.test-support.js";

// The compiled test artifact is not a production artifact; give this test
// module the explicit test-only reclaimer required by path-lock before it
// constructs a runtime that writes its identity profile.
before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

const principal = Object.freeze({ continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" });
function cleanup(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* Windows SQLite cleanup is best effort */
  }
}
const PROCESS_TIMEOUT_MS = 30_000;
const timeout = (ms = PROCESS_TIMEOUT_MS) =>
  new Promise<never>((_resolve, reject) =>
    setTimeout(() => reject(new Error("semantic_known_game_process_timeout")), ms),
  );
type WorkerReply = Readonly<{
  type: "ready" | "prepared" | "rejected" | "terminalized" | "closed" | "fatal";
  code?: string;
}>;
async function next(child: ChildProcess): Promise<WorkerReply> {
  return Promise.race([once(child, "message").then(([message]) => message as WorkerReply), timeout()]);
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null && child.connected) {
    // Cleanup owns only the process, not its semantic lifecycle; an already
    // exited IPC pipe is expected after a rejected independent admission.
    child.send({ type: "close" }, (error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "EPIPE") process.emitWarning(error);
    });
  }
  await Promise.race([
    once(child, "exit").then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
function worker(): ChildProcess {
  return fork(
    join(dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures", "semantic-known-game-process-worker.js"),
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
}
function initialChatWorker(mode: "crash-after-register" | "resume", manifestPath: string): ChildProcess {
  return fork(
    join(dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures", "semantic-initial-chat-process-worker.js"),
    [mode, manifestPath],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
}
async function retainedAbandon(name: string): Promise<ChildProcess> {
  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures", "windows-named-mutex-retained-abandon.ps1"),
      "-Name",
      name,
    ],
    { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
  );
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  await Promise.race([once(lines, "line").then(([line]) => assert.equal(line, "ready")), timeout()]);
  return child;
}
async function releaseRetained(child: ChildProcess): Promise<void> {
  child.stdin?.end();
  await Promise.race([
    once(child, "exit").then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
function manifest(root: string): string {
  const runtimeRoot = join(root, "runtime");
  mkdirSync(runtimeRoot);
  const manifestPath = join(root, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot,
      principal,
      bootstrapOperationId: "bootstrap_01",
      authorityGeneration: 1,
    }),
  );
  return manifestPath;
}

test("v38 coordinator Chat request boundary reaches the actual store with an exact writable vector copy", () => {
  const root = canonicalTestRootSync("semantic-chat-runtime-store-boundary-");
  const bootstrap: ProductionBootstrapInput = {
    principal,
    bootstrapOperationId: "bootstrap_01",
    authorityGeneration: 1,
    authorityRootIdentity: "a".repeat(64),
  };
  let control: ReturnType<typeof openProductionContinuityStore> | undefined;
  try {
    control = openProductionContinuityStore({ runtimeRoot: root });
    const metadata = control.bootstrapFresh(bootstrap);
    const store = control.bindBootstrapContext({ bootstrap, metadata });
    const claim = store.claim({
      holderBindingDigest: "b".repeat(64),
      operationId: "claim_01",
      expected: { partitionRevision: 1, fenceEpoch: 1, selectionRevision: 0 },
    });
    const registered = store.register({
      holderBindingDigest: "b".repeat(64),
      operationId: "register_01",
      expected: claim.vector,
    });
    const receipt: TavernExactContentReceipt = {
      chatThreadId: registered.chatThreadId!,
      chatSurfaceSessionId: registered.chatSurfaceSessionId!,
      continuityId: principal.continuityId,
      companionId: principal.companionId,
      digest: "c".repeat(64),
    };
    const verified = store.verify(
      {
        holderBindingDigest: "b".repeat(64),
        operationId: "verify_01",
        expected: registered.vector,
      },
      receipt,
    );
    const selected = store.select({
      holderBindingDigest: "b".repeat(64),
      operationId: "select_01",
      expected: verified.vector,
    });
    const catalog = store.readChatCatalog();
    assert.equal(Object.isFrozen(catalog), true);
    assert.equal(Object.isFrozen(catalog.vector), true);
    assert.throws(() => {
      (catalog.vector as { partitionRevision: number }).partitionRevision = 999;
    }, TypeError);
    const owner: ProductionChatRuntimeOwner = {
      ownerToken: "owner-token",
      runtimeInstanceId: "runtime-01",
      ownerPid: process.pid,
      ownerProcessStartIdentity: "process-start-01",
    };
    // This is the production coordinator's request shape: freeze only the
    // outer request while copying the exact catalog vector as writable data.
    const request: ProductionChatRuntimeRequest = Object.freeze({
      principal,
      operationId: "chat-runtime-01",
      requestId: "chat-request-01",
      chatThreadId: selected.chatThreadId!,
      chatSurfaceSessionId: selected.chatSurfaceSessionId!,
      runtimeBindingDigest: "d".repeat(64),
      owner: Object.freeze({ ...owner }),
      deadlineAtMs: Date.now() + 30_000,
      expected: { ...catalog.vector },
    });
    assert.equal(Object.isFrozen(request), true);
    assert.equal(Object.isFrozen(request.expected), false);
    const prepared = store.prepareChatRuntime(request);
    assert.equal(prepared.outcome, "effect_owned");
    if (!prepared.permit) throw new Error("missing_chat_runtime_permit");
    assert.deepEqual(prepared.permit.expected, catalog.vector);

    const forgedVectors: unknown[] = [
      Object.defineProperties(
        {},
        {
          partitionRevision: { enumerable: true, get: () => catalog.vector.partitionRevision },
          fenceEpoch: { enumerable: true, value: catalog.vector.fenceEpoch, writable: true },
          selectionRevision: { enumerable: true, value: catalog.vector.selectionRevision, writable: true },
        },
      ),
      { ...catalog.vector, unexpected: true },
      { ...catalog.vector, partitionRevision: 1.5 },
      Object.assign(Object.create({ partitionRevision: catalog.vector.partitionRevision }), {
        fenceEpoch: catalog.vector.fenceEpoch,
        selectionRevision: catalog.vector.selectionRevision,
      }),
      Object.assign({ ...catalog.vector }, { [Symbol("unexpected")]: true }),
    ];
    for (const expected of forgedVectors) {
      const forged = Object.freeze({ ...request, operationId: `forged-${forgedVectors.indexOf(expected)}`, expected });
      assert.throws(
        () => store.prepareChatRuntime(forged as ProductionChatRuntimeRequest),
        /invalid_chat_runtime_operation/,
      );
    }
  } finally {
    try {
      control?.close();
    } catch {
      /* preserve test assertion */
    }
    cleanup(root);
  }
});

test("production coordinator exports only the known Game constructor and its safe authority surface", () => {
  assert.deepEqual(Object.keys(publicCoordinator).sort(), [
    "SemanticProductionCoordinatorError",
    "createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest",
    "createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest",
    "createKnownSemanticGameProductionAuthorityFromDeploymentManifest",
    "isCurrentMountedChatRuntimeLease",
    "stopMountedChatPresentationEpoch",
  ]);
  const authorityType: SemanticGameProductionAuthority | undefined = undefined;
  assert.equal(authorityType, undefined);
  assert.deepEqual(Object.keys(internalCoordinator).sort(), [
    "PROVIDER_INVOCATION_ADMISSION_DEADLINE_MS",
    "SemanticProductionCoordinatorError",
    "acceptMountedDurableTurn",
    "claimMountedAttempt",
    "consumeMountedAttemptAdmission",
    "consumeMountedAttemptInvocationAdmission",
    "consumeMountedDurableAdmission",
    "createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest",
    "createFreshSemanticProductionAuthorityFromDeploymentManifest",
    "createInitialChatResumeSemanticProductionAuthorityFromDeploymentManifest",
    "createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest",
    "createKnownSemanticGameProductionAuthorityFromDeploymentManifest",
    "isCurrentMountedChatRuntimeLease",
    "orchestrateExplicitGameRecovery",
    "startMountedAttempt",
    "stopMountedChatPresentationEpoch",
  ]);
  assert.equal(typeof createTestSemanticChatRuntimeCoordinator, "function");
  const productionSource = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "src",
      "continuity-semantic-production-coordinator",
      "continuity-semantic-production-coordinator.internal.ts",
    ),
    "utf8",
  );
  assert.doesNotMatch(productionSource, /createSemanticChatRuntimeCoordinator|SemanticChatRuntimeCoordinatorOptions/);
});

test("unmounted composition owns its genuine mutex and exposes only the narrow Dialogue facade", async () => {
  const root = canonicalTestRootSync("semantic-s4-compose-");
  try {
    const authority = await createUnmountedDialogueSemanticFacade(Object.freeze({ manifestPath: manifest(root) }));
    assert.deepEqual(Object.keys(authority).sort(), [
      "authority",
      "close",
      "initializeInitialChat",
      "resumeInitialChat",
    ]);
    const initialized = await authority.initializeInitialChat();
    assert.equal(initialized.phase, "selected");
    const resumed = await authority.resumeInitialChat();
    assert.deepEqual(resumed, initialized);
    const first = authority.close(),
      second = authority.close();
    assert.strictEqual(first, second);
    await first;
    await assert.rejects(authority.resumeInitialChat(), /authority_closed/);
  } finally {
    cleanup(root);
  }
});

test("production Dialogue exposes close-drained manifest-bound Chat commands without caller IDs or vectors", async () => {
  const root = canonicalTestRootSync("semantic-chat-commands-");
  try {
    const manifestPath = manifest(root),
      deployment = await loadHostDeploymentManifest(manifestPath);
    const authority =
      await internalCoordinator.createFreshSemanticProductionAuthorityFromDeploymentManifest(deployment);
    try {
      assert.deepEqual(Object.keys(authority).sort(), [
        "authority",
        "close",
        "initializeInitialChat",
        "readChatCatalog",
        "registerChat",
        "registerInitialChat",
        "reselectTerminalChatRuntimeSuccessor",
        "resumeInitialChat",
        "resumeInitialChatWithContent",
        "selectInitialChat",
        "selectVerifiedChat",
        "startInitialChat",
        "transitionNonSelectedChatLifecycle",
        "verifyInitialChat",
        "verifyRegisteredChatContent",
      ]);
      await authority.initializeInitialChat(createManifestDerivedInitialChatExactContentPort(deployment));
      const registered = await authority.registerChat();
      assert.equal(registered.kind, "register_chat");
      const catalog = await authority.readChatCatalog();
      const candidate = catalog.threads.find((thread) => thread.chatThreadId === registered.chatThreadId);
      assert.equal(candidate?.contentState, "registered");
      await assert.rejects(authority.selectVerifiedChat(), /semantic_chat_target_unavailable/);
    } finally {
      await authority.close();
    }
  } finally {
    cleanup(root);
  }
});

test("production Dialogue authorizes post-initial Tavern materialization outside the semantic mutex, then selects and archives", async () => {
  const root = canonicalTestRootSync("semantic-chat-flow-");
  try {
    const manifestPath = manifest(root),
      deployment = await loadHostDeploymentManifest(manifestPath);
    const authority =
      await internalCoordinator.createFreshSemanticProductionAuthorityFromDeploymentManifest(deployment);
    try {
      const content = createManifestDerivedInitialChatExactContentPort(deployment);
      await authority.initializeInitialChat(content);
      const registered = await authority.registerChat();
      const receipt = await content.createExplicit(
        Object.freeze({
          chatThreadId: registered.chatThreadId,
          chatSurfaceSessionId: registered.chatSurfaceSessionId,
          companionId: principal.companionId,
          continuityId: principal.continuityId,
          opening: "blank",
        }),
      );
      const verified = await authority.verifyRegisteredChatContent(receipt);
      assert.equal(verified.kind, "verify_chat_content");
      const selected = await authority.selectVerifiedChat();
      assert.equal(selected.activeSelection?.chatThreadId, registered.chatThreadId);
      const archived = await authority.transitionNonSelectedChatLifecycle("archive");
      assert.equal(archived.lifecycle, "archived");
      const trashed = await authority.transitionNonSelectedChatLifecycle("trash");
      assert.equal(trashed.lifecycle, "trashed");
      const restored = await authority.transitionNonSelectedChatLifecycle("restore");
      assert.equal(restored.lifecycle, "archived");
      const catalog = await authority.readChatCatalog();
      assert.equal(catalog.activeSelection?.chatThreadId, registered.chatThreadId);
      assert.equal(catalog.threads.filter((thread) => thread.lifecycle === "archived").length, 1);
    } finally {
      await authority.close();
    }
  } finally {
    cleanup(root);
  }
});

test("production Dialogue Chat operations reject forged Tavern receipt and retain no caller-selected capability", async () => {
  const root = canonicalTestRootSync("semantic-chat-receipt-");
  try {
    const manifestPath = manifest(root),
      deployment = await loadHostDeploymentManifest(manifestPath);
    const authority =
      await internalCoordinator.createFreshSemanticProductionAuthorityFromDeploymentManifest(deployment);
    try {
      await authority.initializeInitialChat(createManifestDerivedInitialChatExactContentPort(deployment));
      const registered = await authority.registerChat();
      await assert.rejects(
        authority.verifyRegisteredChatContent(
          Object.freeze({
            chatThreadId: registered.chatThreadId,
            chatSurfaceSessionId: registered.chatSurfaceSessionId,
            companionId: principal.companionId,
            continuityId: principal.continuityId,
            digest: "0".repeat(64),
          }),
        ),
        /untrusted_tavern_exact_content_receipt|binding_rejected/,
      );
      const catalog = await authority.readChatCatalog();
      assert.equal(
        catalog.threads.find((thread) => thread.chatThreadId === registered.chatThreadId)?.contentState,
        "registered",
      );
    } finally {
      await authority.close();
    }
  } finally {
    cleanup(root);
  }
});

test(
  "known Chat resume rejects an absent saga and a terminal selected saga",
  { skip: process.platform !== "win32" ? "requires real WindowsNamedMutexBroker" : false },
  async () => {
    const absentRoot = canonicalTestRootSync("semantic-known-absent-");
    try {
      const absentPath = manifest(absentRoot);
      const absentManifest = await loadHostDeploymentManifest(absentPath);
      const fresh =
        await internalCoordinator.createFreshSemanticProductionAuthorityFromDeploymentManifest(absentManifest);
      await fresh.close();
      await assert.rejects(
        createInitialChatResumeSemanticProductionAuthorityFromDeploymentManifest(absentManifest),
        /initial_chat_known_open_saga_absent/,
      );
    } finally {
      cleanup(absentRoot);
    }
    const selectedRoot = canonicalTestRootSync("semantic-known-selected-");
    try {
      const selectedPath = manifest(selectedRoot);
      const selectedManifest = await loadHostDeploymentManifest(selectedPath);
      const fresh =
        await internalCoordinator.createFreshSemanticProductionAuthorityFromDeploymentManifest(selectedManifest);
      const content = createManifestDerivedInitialChatExactContentPort(selectedManifest);
      await fresh.initializeInitialChat(content);
      await fresh.close();
      await assert.rejects(
        createInitialChatResumeSemanticProductionAuthorityFromDeploymentManifest(selectedManifest),
        /initial_chat_known_open_saga_selected/,
      );
    } finally {
      cleanup(selectedRoot);
    }
  },
);

test(
  "public known Game authority constructor owns fresh store transitions without exposing its store or mutex",
  { skip: process.platform !== "win32" ? "requires real WindowsNamedMutexBroker" : false },
  async () => {
    const root = canonicalTestRootSync("semantic-known-game-");
    try {
      const manifestPath = manifest(root);
      const deployment = await loadHostDeploymentManifest(manifestPath);
      const chat = await internalCoordinator.createFreshSemanticProductionAuthorityFromDeploymentManifest(deployment);
      await chat.close();
      const game = await createKnownSemanticGameProductionAuthorityFromDeploymentManifest(deployment);
      try {
        assert.deepEqual(Object.keys(game).sort(), [
          "authority",
          "close",
          "commitClose",
          "commitEnter",
          "failClose",
          "failEnter",
          "prepareClose",
          "prepareEnter",
          "recoverDeadOwner",
        ]);
        const facts = Object.freeze({
          world: Object.freeze({ integrationId: "stardew", saveId: "save_01", worldId: "world_01" }),
          bindingDigest: "a".repeat(64),
          owner: Object.freeze({
            ownerToken: "owner_01",
            runtimeInstanceId: "runtime_01",
            ownerPid: process.pid,
            ownerProcessStartIdentity: "creation_01",
          }),
        });
        const enter = await game.prepareEnter(facts);
        const enterReceipt = Object.freeze({
          kind: "runtime_bootstrapped" as const,
          operationId: enter.operationId,
          requestId: enter.requestId,
          gameSessionId: enter.gameSessionId,
          bindingDigest: enter.bindingDigest,
          world: enter.world,
          owner: enter.owner,
          fenceToken: enter.fenceToken,
          occurredAtMs: Date.now(),
        });
        const entered = await game.commitEnter(enter, enterReceipt);
        assert.strictEqual(await game.commitEnter(enter, enterReceipt), entered);
        const closing = await game.prepareClose(entered);
        const closed = await game.commitClose(
          entered,
          closing,
          Object.freeze({
            kind: "runtime_torn_down",
            operationId: closing.operationId,
            requestId: closing.requestId,
            gameSessionId: closing.gameSessionId,
            bindingDigest: closing.bindingDigest,
            world: closing.world,
            owner: closing.owner,
            fenceToken: closing.fenceToken,
            occurredAtMs: Date.now(),
          }),
        );
        assert.equal(closed.gameState, "ended");
      } finally {
        await game.close();
      }
    } finally {
      cleanup(root);
    }
  },
);

test(
  "independent known-open processes serialize Game admission and a closed terminal permits the next process",
  { skip: process.platform !== "win32" ? "requires real Windows named mutex and child processes" : false },
  async () => {
    const root = canonicalTestRootSync("semantic-known-game-process-");
    let first: ChildProcess | undefined;
    let contender: ChildProcess | undefined;
    let successor: ChildProcess | undefined;
    try {
      const manifestPath = manifest(root);
      const deployment = await loadHostDeploymentManifest(manifestPath);
      const chat = await internalCoordinator.createFreshSemanticProductionAuthorityFromDeploymentManifest(deployment);
      await chat.close();
      first = worker();
      assert.deepEqual(await next(first), { type: "ready" });
      first.send({ type: "attempt", manifestPath });
      assert.deepEqual(await next(first), { type: "prepared" });
      contender = worker();
      assert.deepEqual(await next(contender), { type: "ready" });
      contender.send({ type: "attempt", manifestPath });
      const rejected = await next(contender);
      assert.equal(rejected.type, "rejected");
      assert.match(
        rejected.code ?? "",
        /production_authority_artifact_present|semantic_game_enter_not_effect_owned|game_origin_unavailable|game_transition_invalid/,
      );
      first.send({ type: "terminalize" });
      assert.deepEqual(await next(first), { type: "terminalized" });
      first.send({ type: "close" });
      assert.deepEqual(await next(first), { type: "closed" });
      successor = worker();
      assert.deepEqual(await next(successor), { type: "ready" });
      successor.send({ type: "attempt", manifestPath });
      assert.deepEqual(await next(successor), { type: "prepared" });
      successor.send({ type: "terminalize" });
      assert.deepEqual(await next(successor), { type: "terminalized" });
      successor.send({ type: "close" });
      assert.deepEqual(await next(successor), { type: "closed" });
    } finally {
      await Promise.all(
        [first, contender, successor].filter((child): child is ChildProcess => child !== undefined).map(stop),
      );
      cleanup(root);
    }
  },
);

test(
  "independent initial Chat crash after registration fails closed when explicit creation did not complete",
  { skip: process.platform !== "win32" ? "requires real Windows named mutex and child processes" : false },
  async () => {
    const root = canonicalTestRootSync("semantic-initial-process-");
    let crashed: ChildProcess | undefined;
    let successor: ChildProcess | undefined;
    try {
      const manifestPath = manifest(root);
      crashed = initialChatWorker("crash-after-register", manifestPath);
      assert.deepEqual(await next(crashed), { type: "registered" });
      await Promise.race([once(crashed, "exit").then(() => undefined), timeout()]);
      successor = initialChatWorker("resume", manifestPath);
      assert.deepEqual(await next(successor), { type: "fatal", code: "chat_thread_not_found" });
      await Promise.race([once(successor, "exit").then(() => undefined), timeout()]);
      const deployment = await loadHostDeploymentManifest(manifestPath);
      const reopened = await createInitialChatResumeSemanticProductionAuthorityFromDeploymentManifest(deployment);
      try {
        await assert.rejects(
          reopened.resumeInitialChatWithContent(createManifestDerivedInitialChatExactContentPort(deployment)),
          /chat_thread_not_found/,
        );
      } finally {
        await reopened.close();
      }
    } finally {
      await Promise.all([crashed, successor].filter((child): child is ChildProcess => child !== undefined).map(stop));
      cleanup(root);
    }
  },
);

test(
  "an abandoned root mutex quarantines durably across independent known-open processes",
  { skip: process.platform !== "win32" ? "requires real Windows named mutex and child processes" : false },
  async () => {
    const root = canonicalTestRootSync("semantic-known-game-abandoned-");
    let abandoned: ChildProcess | undefined;
    let first: ChildProcess | undefined;
    let second: ChildProcess | undefined;
    try {
      const manifestPath = manifest(root);
      const deployment = await loadHostDeploymentManifest(manifestPath);
      const chat = await internalCoordinator.createFreshSemanticProductionAuthorityFromDeploymentManifest(deployment);
      await chat.close();
      const admission = createCanonicalProductionAuthorityAdmission(deployment.runtimeRoot);
      abandoned = await retainedAbandon(authorityRootMutexName(admission.authorityRootIdentity));
      first = worker();
      assert.deepEqual(await next(first), { type: "ready" });
      first.send({ type: "attempt", manifestPath });
      const quarantined = await next(first);
      assert.equal(quarantined.type, "rejected");
      assert.match(quarantined.code ?? "", /semantic_production_abandoned_mutex_quarantined/);
      second = worker();
      assert.deepEqual(await next(second), { type: "ready" });
      second.send({ type: "attempt", manifestPath });
      const reopened = await next(second);
      assert.equal(reopened.type, "rejected");
      assert.match(
        reopened.code ?? "",
        /production_continuity_quarantined|production_store_materialization_invalid|semantic_production_abandoned_mutex_quarantined/,
      );
    } finally {
      await Promise.all([first, second].filter((child): child is ChildProcess => child !== undefined).map(stop));
      if (abandoned) await releaseRetained(abandoned);
      cleanup(root);
    }
  },
);

test(
  "production mounted lease mints browser projections from its verified record without exposing durable identifiers",
  { skip: process.platform !== "win32" ? "requires real Windows production mount construction" : false },
  async () => {
    const firstRoot = canonicalTestRootSync("semantic-browser-projection-first-");
    const secondRoot = canonicalTestRootSync("semantic-browser-projection-second-");
    const mountInIsolatedProductionProcess = async (manifestPath: string) => {
      const coordinatorUrl = new URL("./continuity-semantic-production-coordinator.internal.js", import.meta.url).href;
      const manifestUrl = new URL("../deployment-manifest.js", import.meta.url).href;
      const pathLockUrl = new URL("../path-lock.js", import.meta.url).href;
      const reclaimerUrl = new URL("../windows-stale-lock-reclaimer/index.js", import.meta.url).href;
      const script = `
        const [coordinatorUrl, manifestUrl, pathLockUrl, reclaimerUrl, manifestPath] = process.argv.slice(1);
        const { createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest } = await import(coordinatorUrl);
        const { loadHostDeploymentManifest } = await import(manifestUrl);
        const { bindWindowsStaleLockReclaimer } = await import(pathLockUrl);
        const { createBuildWindowsStaleLockReclaimer } = await import(reclaimerUrl);
        bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
        const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(await loadHostDeploymentManifest(manifestPath));
        const lease = await authority.startMountedChatRuntime();
        const projection = lease.browserProjection;
        process.stdout.write(JSON.stringify({
          chatThreadId: lease.chatThreadId,
          chatSurfaceSessionId: lease.chatSurfaceSessionId,
          projection: {
            chatHandle: projection.chatHandle,
            selectionGeneration: projection.selectionGeneration,
            selectionStateRevision: projection.selectionStateRevision,
            messageHandle: projection.projectMessageHandle("message_01"),
            repeatedMessageHandle: projection.projectMessageHandle("message_01"),
          },
        }));
        await authority.close();
      `;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "--eval", script, coordinatorUrl, manifestUrl, pathLockUrl, reclaimerUrl, manifestPath],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
      const [code] = (await once(child, "exit")) as [number | null];
      assert.equal(code, 0, Buffer.concat(errors).toString("utf8"));
      return JSON.parse(Buffer.concat(output).toString("utf8")) as Readonly<{
        chatThreadId: string;
        chatSurfaceSessionId: string;
        projection: Readonly<{
          chatHandle: string;
          selectionGeneration: number;
          selectionStateRevision: string;
          messageHandle: string;
          repeatedMessageHandle: string;
        }>;
      }>;
    };
    try {
      const first = await mountInIsolatedProductionProcess(manifest(firstRoot));
      const firstProjection = first.projection;
      assert.equal(firstProjection.selectionGeneration, 1);
      for (const handle of [
        firstProjection.chatHandle,
        firstProjection.selectionStateRevision,
        firstProjection.messageHandle,
        firstProjection.repeatedMessageHandle,
      ])
        assert.match(handle, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(firstProjection.repeatedMessageHandle, firstProjection.messageHandle);
      assert.notEqual(firstProjection.chatHandle, first.chatThreadId);
      assert.notEqual(firstProjection.selectionStateRevision, first.chatSurfaceSessionId);
      assert.notEqual(firstProjection.messageHandle, "message_01");
      assert.notEqual(firstProjection.chatHandle, firstProjection.selectionStateRevision);
      assert.notEqual(firstProjection.chatHandle, firstProjection.messageHandle);
      assert.notEqual(firstProjection.selectionStateRevision, firstProjection.messageHandle);

      const second = await mountInIsolatedProductionProcess(manifest(secondRoot));
      const secondProjection = second.projection;
      assert.equal(secondProjection.selectionGeneration, 1);
      assert.notEqual(secondProjection.chatHandle, firstProjection.chatHandle);
      assert.notEqual(secondProjection.selectionStateRevision, firstProjection.selectionStateRevision);
      assert.notEqual(secondProjection.messageHandle, firstProjection.messageHandle);
    } finally {
      cleanup(firstRoot);
      cleanup(secondRoot);
    }
  },
);

test(
  "mounted lease lifecycle tears down successfully, revokes its predicate, and rejects mount starts after authority close",
  { skip: process.platform !== "win32" ? "requires real Windows production coordinator mount" : false },
  async () => {
    const leaseRoot = canonicalTestRootSync("semantic-mounted-lease-lifecycle-");
    const closeRoot = canonicalTestRootSync("semantic-mounted-authority-close-");
    try {
      const leaseManifest = await loadHostDeploymentManifest(manifest(leaseRoot));
      const leaseAuthority =
        await publicCoordinator.createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(leaseManifest);
      const lease = await leaseAuthority.startMountedChatRuntime();
      assert.equal(publicCoordinator.isCurrentMountedChatRuntimeLease(lease), true);
      const leaseClose = lease.close();
      // close() synchronously revokes even while teardown awaits durable work.
      assert.equal(publicCoordinator.isCurrentMountedChatRuntimeLease(lease), false);
      await assert.rejects(leaseAuthority.startMountedChatRuntime(), /semantic_chat_runtime_authority_closed/);
      await leaseClose;

      const closeManifest = await loadHostDeploymentManifest(manifest(closeRoot));
      const closeAuthority =
        await publicCoordinator.createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(closeManifest);
      await closeAuthority.startChatRuntime();
      const authorityClose = closeAuthority.close();
      await assert.rejects(closeAuthority.startMountedChatRuntime(), /semantic_chat_runtime_authority_closed/);
      await authorityClose;
    } finally {
      cleanup(leaseRoot);
      cleanup(closeRoot);
    }
  },
);

test(
  "known-root Chat successor mounts only after terminal teardown and preserves the exact selected Chat",
  { skip: process.platform !== "win32" ? "requires real Windows production coordinator mount" : false },
  async () => {
    const root = canonicalTestRootSync("semantic-known-chat-successor-");
    let first:
      | Awaited<
          ReturnType<typeof publicCoordinator.createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest>
        >
      | undefined;
    let successor:
      | Awaited<ReturnType<typeof createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest>>
      | undefined;
    try {
      const deployment = await loadHostDeploymentManifest(manifest(root));
      first =
        await publicCoordinator.createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(deployment);
      const firstLease = await first.startMountedChatRuntime();
      const firstIdentity = Object.freeze({
        chatThreadId: firstLease.chatThreadId,
        chatSurfaceSessionId: firstLease.chatSurfaceSessionId,
        selectionGeneration: firstLease.browserProjection.selectionGeneration,
      });
      await firstLease.close();
      await first.close();
      first = undefined;

      successor = await createKnownSemanticChatRuntimeProductionAuthorityFromDeploymentManifest(deployment);
      const successorLease = await successor.startMountedChatRuntime();
      assert.equal(successorLease.chatThreadId, firstIdentity.chatThreadId);
      assert.equal(successorLease.chatSurfaceSessionId, firstIdentity.chatSurfaceSessionId);
      assert.equal(successorLease.browserProjection.selectionGeneration, firstIdentity.selectionGeneration + 1);
      await successorLease.close();
      await successor.close();
      successor = undefined;
    } finally {
      await successor?.close().catch(() => undefined);
      await first?.close().catch(() => undefined);
      cleanup(root);
    }
  },
);

test("production construction derives admission from the deployment manifest and refuses duplicate fresh authority", async () => {
  const root = canonicalTestRootSync("semantic-s4-manifest-");
  try {
    const manifestPath = manifest(root);
    const authority = await createUnmountedDialogueSemanticFacade(Object.freeze({ manifestPath }));
    await authority.close();
    await assert.rejects(
      createUnmountedDialogueSemanticFacade(Object.freeze({ manifestPath })),
      /production_authority_artifact_present/,
    );
  } finally {
    cleanup(root);
  }
});

test("Game coordinator source constructs independent enter and close requests without Chat origin lookup", () => {
  const source = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "src",
      "continuity-semantic-production-coordinator",
      "continuity-semantic-production-coordinator.internal.ts",
    ),
    "utf8",
  );
  for (const forbidden of [
    "readExactSelectedGameOrigin",
    "prepareReturn",
    "commitReturn",
    "failReturn",
    "GameOrigin",
    "origin:",
  ])
    assert.equal(source.includes(forbidden), false, `forbidden Game coordinator semantic: ${forbidden}`);
  assert.match(source, /readGameAdmission\(\)/);
  assert.match(source, /kind: "enter" as const/);
  assert.match(source, /kind: "close" as const/);
});
