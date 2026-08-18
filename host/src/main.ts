import { isAbsolute } from "node:path";

import {
  GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA,
  validateGameOperationalGateEvidence,
  type GameOperationalGateEvidence,
} from "./game-operational-gate-evidence.js";

import {
  createKnownSemanticGameDeadOwnerRecoveryFacadeFromOperatorConfig,
  createKnownSemanticGameFacadeFromOperatorConfig,
} from "./continuity-semantic-game-operator-selection/continuity-semantic-game-operator-selection.internal.js";
import { loadSemanticVoiceConfig, parseSemanticMainCommand } from "./semantic-main-config.js";
import { connectHealthyVoiceGateway } from "./voice-bootstrap.js";
import { createHostShutdownLifecycle, createVoicePollingSupervisor } from "./voice-polling.js";
import {
  readProductControlLaunch,
  startCompanionControlServer,
  type CompanionControlServer,
} from "./companion-control-server.js";
import { createCompanionBootstrapEvidence, deliverCompanionBootstrapEvidence } from "./companion-bootstrap-evidence.js";
import { createLiveSourceAttester } from "./companion-live-source-attestation.js";
import { createCompanionLiveEvidenceArtifact } from "./companion-live-evidence-artifact.js";

const command = parseSemanticMainCommand(process.argv.slice(2), process.env.GAMEBUDDY_SEMANTIC_GAME_OPERATOR_CONFIG);
if (command.kind === "recover_dead_owner") {
  const recoveryFacade = await createKnownSemanticGameDeadOwnerRecoveryFacadeFromOperatorConfig(
    command.operatorConfigPath,
  );
  let recoveryError: unknown;
  try {
    await recoveryFacade.recoverDeadOwner({ request: "recover_dead_owner", operationId: command.operationId });
  } catch (error) {
    recoveryError = error;
  }
  try {
    await recoveryFacade.close();
  } catch (closeError) {
    if (recoveryError === undefined) throw closeError;
  }
  if (recoveryError !== undefined) throw recoveryError;
  process.stdout.write("GameBuddy semantic Game dead-owner recovery completed.\n");
} else await enterSemanticGame(command.operatorConfigPath, readGameOperationalGateNonceSha256());

async function emitGameOperationalGateEvidence(
  lease: Readonly<{
    piSessionId: string;
    nextOperationalGateEvidence?(): Promise<Omit<GameOperationalGateEvidence, "nonceSha256" | "piSessionId">>;
  }>,
  nonceSha256: string,
): Promise<void> {
  const projection = await lease.nextOperationalGateEvidence!();
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

function createPreviewLiveSourceAttester(launchBindingSha256: string | undefined) {
  const artifact = createCompanionLiveEvidenceArtifact(
    process.env.GAMEBUDDY_COMPANION_LIVE_EVIDENCE_ARTIFACT,
    process.env.GAMEBUDDY_COMPANION_LIVE_EVIDENCE_MANIFEST_SHA256,
  );
  // A real native-chat run has no harness parent. Its only output is the
  // configured append-only artifact; no control endpoint is added.
  if (launchBindingSha256 === undefined) {
    const manifestSha256 = process.env.GAMEBUDDY_COMPANION_LIVE_EVIDENCE_MANIFEST_SHA256;
    if (artifact === undefined && manifestSha256 === undefined) return undefined;
    if (artifact === undefined || manifestSha256 === undefined) throw new Error("live_source_attestation_unavailable");
    return createLiveSourceAttester({
      launchBindingSha256: manifestSha256,
      send: (message) => {
        artifact.append(message.evidence);
        return true;
      },
    });
  }
  if (!/^[a-f0-9]{64}$/.test(launchBindingSha256) || typeof process.send !== "function" || process.connected !== true)
    throw new Error("live_source_attestation_unavailable");
  return createLiveSourceAttester({
    launchBindingSha256,
    send: (message) => {
      artifact?.append(message.evidence);
      return process.send!(message);
    },
  });
}

async function emitDeterministicBootstrapEvidence(
  launch: Readonly<{ pipeName: string; launchToken: string }>,
  runtimeInstanceId: string,
): Promise<void> {
  const challengeSha256 = process.env.GAMEBUDDY_D0_BOOTSTRAP_CHALLENGE_SHA256;
  if (challengeSha256 === undefined) return;
  if (!/^[a-f0-9]{64}$/.test(challengeSha256) || typeof process.send !== "function" || process.connected !== true)
    throw new Error("deterministic_bootstrap_evidence_unavailable");
  const evidence = createCompanionBootstrapEvidence({
    challengeSha256,
    launchBinding: `${launch.pipeName}:${launch.launchToken}`,
    runtimeInstanceId,
  });
  await deliverCompanionBootstrapEvidence(
    (message, callback) => process.send!(message, undefined, undefined, callback),
    evidence,
  );
}

function readGameOperationalGateNonceSha256(): string | undefined {
  const nonce = process.env.GAMEBUDDY_GAME_OPERATIONAL_GATE_NONCE_SHA256;
  if (nonce !== undefined && !/^[a-f0-9]{64}$/.test(nonce)) throw new Error("invalid_game_operational_gate_nonce");
  return nonce;
}

async function enterSemanticGame(operatorConfigPath: string, gameOperationalGateNonceSha256?: string): Promise<void> {
  const liveSourceAttester = createPreviewLiveSourceAttester(
    process.env.GAMEBUDDY_LIVE_SOURCE_ATTESTATION_LAUNCH_BINDING_SHA256,
  );
  const voiceConfigPath = process.env.GAMEBUDDY_SEMANTIC_VOICE_CONFIG;
  if (
    voiceConfigPath !== undefined &&
    (voiceConfigPath.length === 0 || voiceConfigPath.includes("\0") || !isAbsolute(voiceConfigPath))
  ) {
    throw new Error("semantic_voice_config_path_invalid");
  }

  const voiceConfig = voiceConfigPath === undefined ? undefined : await loadSemanticVoiceConfig(voiceConfigPath);
  let voice = await connectHealthyVoiceGateway(voiceConfig?.voiceGateway, voiceConfig?.voiceProfile);
  // The Gateway session identity must be receipt-owned. A preconfigured voice
  // session is only an expected value to compare after durable Game enter; it
  // never chooses the Host/Pi session or presentation session id.
  if (voiceConfig !== undefined && voice === undefined) throw new Error("voice_stop_authority_unavailable");
  let voiceClosed = false;
  const closeVoiceOnce = async (): Promise<void> => {
    if (voice === undefined || voiceClosed) return;
    voiceClosed = true;
    await voice.close();
  };
  // These per-launch secrets are consumed only here, after command parsing, and
  // never flow into a manifest, authority record, artifact output, or stdout.
  const controlLaunch = readProductControlLaunch();
  let facade: Awaited<ReturnType<typeof createKnownSemanticGameFacadeFromOperatorConfig>> | undefined;
  let controlServer: CompanionControlServer | undefined;
  let detachVoice: (() => Promise<void>) | undefined;
  let voicePoll: ReturnType<typeof createVoicePollingSupervisor> | undefined;
  try {
    // The Game runtime never receives an entry-selected session id or epoch:
    // its materializer supplies both from the receipt-backed Game binding.
    // When the independently authenticated voice surface is present, this is
    // the real player-facing presentation port—not a trace sink. Without it,
    // no presentation tools are mounted.
    facade = await createKnownSemanticGameFacadeFromOperatorConfig(operatorConfigPath, {
      ...(gameOperationalGateNonceSha256 === undefined ? {} : { gameOperationalGateNonceSha256 }),
      ...(voice === undefined || voiceConfig === undefined
        ? {}
        : { gameVoicePresentation: voice.createGameVoicePresentationAttachment(voiceConfig.voiceProfile) }),
      ...(liveSourceAttester === undefined ? {} : { liveSourceAttester }),
    });
    // Bootstrap is a post-receipt, pre-ingress admission boundary: the durable
    // Game session is compared to the independently configured Gateway session
    // before any initial fact can reach Pi or enqueue speech.
    const lease = await facade.runEnter();
    if (voice !== undefined && voiceConfig !== undefined) {
      if (voiceConfig.voiceSessionId !== lease.gameSessionId) throw new Error("voice_session_receipt_mismatch");
      await voice.bootstrapSession(lease.gameSessionId);
    }
    // The materializer bound the real voice STOP authority before it activated
    // launch ingress after durable enter. Only transcript ingress/polling need
    // attach here, after the committed Host is available.
    if (voice !== undefined && voiceConfig !== undefined) {
      detachVoice = lease.host.attachFinalVoiceSource(voice, lease.gameSessionId);
      voicePoll = createVoicePollingSupervisor(voice);
      voicePoll.start();
    } else {
      lease.host.attachVoiceStopper(async () => undefined);
    }
    // All pre-Pi admission boundaries are now complete: the receipt-owned
    // voice session is bootstrapped, durable enter committed, and STOP is
    // attached. Release the launch-owned initial facts exactly once.
    lease.activateCommittedIngress();
    // Durable semantic commit, Host mount, and STOP authority precede control ingress publication.
    controlServer = startCompanionControlServer(controlLaunch, lease.host);
    liveSourceAttester?.activate(controlServer.runtimeInstanceId);
    await emitDeterministicBootstrapEvidence(controlLaunch, controlServer.runtimeInstanceId);
    if (gameOperationalGateNonceSha256 !== undefined) {
      if (typeof process.send !== "function" || lease.nextOperationalGateEvidence === undefined)
        throw new Error("game_operational_gate_evidence_unavailable");
      void emitGameOperationalGateEvidence(lease, gameOperationalGateNonceSha256).catch(async () => {
        // The gate has no fallback channel or synthetic evidence. Tear down the
        // exact semantic facade so an unavailable IPC path cannot remain live.
        try {
          await facade?.close();
        } finally {
          process.exitCode = 1;
        }
      });
    }
  } catch (error) {
    if (controlServer !== undefined) {
      try {
        await controlServer.close();
      } catch {
        // Preserve startup failure while sealing control ingress first.
      }
    }
    if (detachVoice !== undefined) {
      try {
        await detachVoice();
      } catch {
        // Preserve startup failure while closing every acquired resource.
      }
    }
    if (facade !== undefined) {
      try {
        await facade.close();
      } catch {
        // Preserve startup failure while attempting semantic runtime teardown.
      }
    }
    voicePoll = undefined;
    try {
      await closeVoiceOnce();
    } catch {
      // Preserve startup failure after attempting voice teardown.
    }
    throw error;
  }
  if (facade === undefined) throw new Error("semantic_game_facade_missing");
  const shutdown = createHostShutdownLifecycle({
    closeControlIngress: () => controlServer!.close(),
    stopPolling: voicePoll === undefined ? undefined : () => voicePoll.close(),
    detachVoice,
    closeVoice: voice === undefined ? undefined : closeVoiceOnce,
    closeConnected: () => facade.close(),
  });
  process.stdout.write("GameBuddy semantic Game facade entered. Press Ctrl+C to stop.\n");
  let primaryError: unknown;
  let cleanupErrors: unknown[] = [];
  try {
    await new Promise<void>((resolveStop) => {
      const stop = () => resolveStop();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    const preparationErrors = await shutdown.prepareForReturn();
    if (preparationErrors.length > 0) throw new AggregateError(preparationErrors, "host_shutdown_prepare_failed");
  } catch (error) {
    primaryError = error;
  } finally {
    cleanupErrors.push(...(await shutdown.cleanup()));
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "host_cleanup_failed");
}
