import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createKnownSemanticGameProductionAuthorityFromDeploymentManifest } from "./continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import { loadHostDeploymentManifest } from "./deployment-manifest.js";
import {
  GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA,
  type GameOperationalGateEvidence,
  validateGameOperationalGateEvidence,
} from "./game-operational-gate-evidence.js";
import { createProductionGameTaskIngressController } from "./production-game-task-ingress.internal.js";
import { parseSemanticMainCommand } from "./semantic-main-config.js";
import {
  createStardewProductionLifecycleCoordinator,
  type HeadlessOperationalGameLease,
} from "./stardew-production-lifecycle-coordinator.internal.js";
import { createPublishedWindowsStardewFolderPicker } from "./windows-stardew-folder-picker/index.js";

const command = parseSemanticMainCommand(process.argv.slice(2));
if (command.kind === "recover_dead_owner") {
  await recoverDeadOwner(command.deploymentManifestRef, command.operationId);
} else {
  await runOperationalGate(command.deploymentManifestRef, command.operationalNonceSha256);
}

async function emitGameOperationalGateEvidence(
  lease: Readonly<{ piSessionId: string }>,
  nonceSha256: string,
  projectionPromise: Promise<Omit<GameOperationalGateEvidence, "nonceSha256" | "piSessionId">>,
): Promise<void> {
  const projection = await projectionPromise;
  const evidence = validateGameOperationalGateEvidence(
    Object.freeze({ ...projection, nonceSha256, piSessionId: lease.piSessionId }),
  );
  if (evidence === null || evidence.schema !== GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA) {
    throw new Error("game_operational_gate_evidence_invalid");
  }
  if (typeof process.send !== "function" || !process.send(evidence)) {
    throw new Error("game_operational_gate_evidence_ipc_unavailable");
  }
}

async function recoverDeadOwner(deploymentManifestRef: string, operationId: string): Promise<void> {
  const manifest = await loadHostDeploymentManifest(deploymentManifestRef);
  const game = await createKnownSemanticGameProductionAuthorityFromDeploymentManifest(manifest);
  try {
    await game.recoverDeadOwner({ request: "recover_dead_owner", operationId });
  } finally {
    await game.close();
  }
  process.stdout.write("GameBuddy semantic Game dead-owner recovery completed.\n");
}

/**
 * Main operational-gate entry. This is the only production entry besides the
 * CLI-only recovery form: it loads a verified deployment-manifest reference,
 * constructs the existing production Game composition, invokes the
 * coordinator-private headless admission, arms durable enter/ingress, and then
 * accepts one nonce-bound dispatch over Node IPC. It deliberately does not
 * import a bridge client, the Design 99 materializer, Preview, Portfolio,
 * browser composition, or operator selection; lifecycle authority stays inside
 * the coordinator.
 */
async function runOperationalGate(deploymentManifestRef: string, operationalNonceSha256: string): Promise<void> {
  const manifest = await loadHostDeploymentManifest(deploymentManifestRef);
  // The immutable generation root is the artifact root: main.js sits at the
  // generation root, and the picker pair lives under native/… in that same
  // root. `.. ` would escape to the generations pool and fail closed.
  const artifactRoot = resolve(dirname(fileURLToPath(import.meta.url)));
  const folderPicker = await createPublishedWindowsStardewFolderPicker(artifactRoot);
  const game = await createKnownSemanticGameProductionAuthorityFromDeploymentManifest(manifest);
  const coordinator = createStardewProductionLifecycleCoordinator(manifest, folderPicker, game);

  let lease: HeadlessOperationalGameLease;
  try {
    lease = await coordinator.headlessOperationalGame.activateHeadlessOperationalGame(manifest);
  } catch (error) {
    await coordinator.close().catch(() => undefined);
    throw error;
  }

  let taskIngress: ReturnType<typeof createProductionGameTaskIngressController> | undefined;
  let operationalGateEvidencePromise: Promise<Omit<GameOperationalGateEvidence, "nonceSha256" | "piSessionId">> | undefined;
  try {
    // Arm durable enter/ingress: the headless lease releases its committed
    // ingress only now, after the coordinated Player Host/AI attach completed.
    lease.activateCommittedIngress();
    if (
      typeof process.send !== "function" ||
      process.connected !== true ||
      lease.nextOperationalGateEvidence === undefined
    ) {
      throw new Error("game_operational_gate_evidence_unavailable");
    }
    operationalGateEvidencePromise = lease.nextOperationalGateEvidence();
    taskIngress = createProductionGameTaskIngressController({
      nonceSha256: operationalNonceSha256,
      gameSessionId: lease.gameSessionId,
      piSessionId: lease.piSessionId,
      dispatchTask: lease.dispatchPromptDefinedTask,
    });
    // Readiness is not visible to the parent until the Node IPC send callback
    // succeeds; a task received during this barrier is fatal, never queued.
    await taskIngress.start();
  } catch (error) {
    taskIngress?.close();
    await lease.close().catch(() => undefined);
    await coordinator.close().catch(() => undefined);
    throw error;
  }

  const signalStop = new Promise<void>((resolveStop) => {
    const stop = () => {
      taskIngress?.close();
      lease.cancelPromptDefinedTask();
      resolveStop();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  let primaryError: unknown;
  try {
    const completeTask = (async () => {
      await taskIngress!.task;
      await emitGameOperationalGateEvidence(
        { piSessionId: lease.piSessionId },
        operationalNonceSha256,
        operationalGateEvidencePromise!,
      );
    })();
    let signalObserved = false;
    const observedSignalStop = signalStop.then(() => {
      signalObserved = true;
    });
    try {
      await Promise.race([taskIngress!.fatal, completeTask, observedSignalStop]);
    } finally {
      if (signalObserved || taskIngress!.state() === "closing") {
        taskIngress!.close();
        lease.cancelPromptDefinedTask();
      }
    }
    if (!signalObserved) await signalStop;
  } catch (error) {
    primaryError = error;
  } finally {
    // Close ingress then the coordinator lease in existing reverse order.
    try {
      await lease.close();
    } catch (error) {
      if (primaryError === undefined) primaryError = error;
    }
    try {
      await coordinator.close();
    } catch (error) {
      if (primaryError === undefined) primaryError = error;
    }
  }
  if (primaryError !== undefined) throw primaryError;
}