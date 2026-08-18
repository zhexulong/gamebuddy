#!/usr/bin/env node
/**
 * P1c live gate for the isolated single-player Portfolio topology.
 *
 * This runner is deliberately observe-only. It never launches Stardew, edits
 * a save, starts Host/AI-client/Farmhand provisioning, selects a target, or
 * manufactures P0b evidence. A missing/stale P0b attestation or an absent
 * native lifecycle invalidation is BLOCKED.
 *
 * Usage (the native process must already be running):
 *   node tools/run-stardew-portfolio-observe-smoke.mjs --lifecycle-event saving
 *   node tools/run-stardew-portfolio-observe-smoke.mjs --lifecycle-event title
 *   node tools/run-stardew-portfolio-observe-smoke.mjs --lifecycle-event disconnect
 *
 * `saving` and `title` wait for the Mod's unsolicited invalidated snapshot
 * followed by pipe close. `disconnect` closes the Host side and proves that
 * the old binding scope is rejected on a reconnect attempt; it does not use a
 * client-side close as a substitute for native evidence.
 */
import { computePortfolioBindingHash, inspectPortfolioP0b } from "./lib/stardew-portfolio-p0b.mjs";
import { PORTFOLIO_TOPOLOGY } from "./lib/stardew-portfolio-profile.mjs";
import { PortfolioStardewBridgeClient } from "../host/dist-portfolio/portfolio-stardew-bridge.js";

const P1C_PHASE = "P1c_live_observe_only";
const lifecycleEvent = readOption("--lifecycle-event");
const timeoutMs = readTimeout();
const required = [
  "GAMEBUDDY_STARDEW_GAME_PATH",
  "GAMEBUDDY_PORTFOLIO_PROFILE_ROOT",
  "GAMEBUDDY_PORTFOLIO_DATA_ROOT",
  "GAMEBUDDY_PORTFOLIO_SAVE_ROOT",
  "GAMEBUDDY_PORTFOLIO_SAVE_NAME",
  "GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT",
  "GAMEBUDDY_PORTFOLIO_INSTALLATION_ATTESTATION",
  "GAMEBUDDY_PORTFOLIO_START_MANIFEST",
  "GAMEBUDDY_PORTFOLIO_HOST_ARTIFACT",
  "GAMEBUDDY_PORTFOLIO_START_MANIFEST_KEY",
  "GAMEBUDDY_PORTFOLIO_PIPE_NAME",
  "GAMEBUDDY_PORTFOLIO_BRIDGE_TOKEN",
  "GAMEBUDDY_PORTFOLIO_SAVE_ID",
  "GAMEBUDDY_PORTFOLIO_WORLD_ID",
  "GAMEBUDDY_PORTFOLIO_LOCAL_PLAYER_ID",
  "GAMEBUDDY_PORTFOLIO_COMPANION_ID",
  "GAMEBUDDY_PORTFOLIO_BINDING_GENERATION",
];

if (!["saving", "title", "disconnect"].includes(lifecycleEvent ?? "")) {
  emit({
    state: "BLOCKED",
    phase: P1C_PHASE,
    topology: PORTFOLIO_TOPOLOGY,
    reasons: ["portfolio_lifecycle_event_required:saving|title|disconnect"],
  });
  process.exitCode = 2;
} else {
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    emit({
      state: "BLOCKED",
      phase: P1C_PHASE,
      topology: PORTFOLIO_TOPOLOGY,
      reasons: missing.map((name) => `portfolio_environment_missing:${name}`),
    });
    process.exitCode = 2;
  } else {
    await run();
  }
}

async function run() {
  const bindingGeneration = Number(process.env.GAMEBUDDY_PORTFOLIO_BINDING_GENERATION);
  const nativeScope = {
    saveId: process.env.GAMEBUDDY_PORTFOLIO_SAVE_ID,
    worldId: process.env.GAMEBUDDY_PORTFOLIO_WORLD_ID,
    localPlayerId: process.env.GAMEBUDDY_PORTFOLIO_LOCAL_PLAYER_ID,
    companionId: process.env.GAMEBUDDY_PORTFOLIO_COMPANION_ID,
    bindingGeneration,
  };
  try {
    if (!Number.isSafeInteger(bindingGeneration) || bindingGeneration <= 0)
      throw new Error("portfolio_binding_generation_invalid");
    const bindingHash = computePortfolioBindingHash(nativeScope);
    const expectedNativeScope = { ...nativeScope, bindingHash, singlePlayer: true, masterGame: true };
    const p0b = await inspectPortfolioP0b({
      gamePath: process.env.GAMEBUDDY_STARDEW_GAME_PATH,
      profileRoot: process.env.GAMEBUDDY_PORTFOLIO_PROFILE_ROOT,
      dataRoot: process.env.GAMEBUDDY_PORTFOLIO_DATA_ROOT,
      saveRoot: process.env.GAMEBUDDY_PORTFOLIO_SAVE_ROOT,
      saveName: process.env.GAMEBUDDY_PORTFOLIO_SAVE_NAME,
      observedSaveSlot: process.env.GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT,
      installationAttestationPath: process.env.GAMEBUDDY_PORTFOLIO_INSTALLATION_ATTESTATION,
      startManifestPath: process.env.GAMEBUDDY_PORTFOLIO_START_MANIFEST,
      hostArtifactPath: process.env.GAMEBUDDY_PORTFOLIO_HOST_ARTIFACT,
      signingKey: process.env.GAMEBUDDY_PORTFOLIO_START_MANIFEST_KEY,
      nativeScope: expectedNativeScope,
    });
    if (p0b.state !== "PASS") {
      emit({
        state: "BLOCKED",
        phase: P1C_PHASE,
        topology: PORTFOLIO_TOPOLOGY,
        reasons: ["portfolio_p0b_not_passed"],
        p0b: { state: p0b.state, reasons: p0b.reasons },
      });
      process.exitCode = 2;
      return;
    }

    // The live process must already be running the target-version Mod. The
    // runner only attaches to its isolated observe pipe; it never launches or
    // provisions a game process.
    const client = await PortfolioStardewBridgeClient.connect(
      {
        integrationId: "stardew_portfolio",
        topology: PORTFOLIO_TOPOLOGY,
        ...nativeScope,
        bindingHash,
      },
      process.env.GAMEBUDDY_PORTFOLIO_PIPE_NAME,
      process.env.GAMEBUDDY_PORTFOLIO_BRIDGE_TOKEN,
    );
    const first = await client.observe();
    assertReady(first, nativeScope, bindingHash);

    if (lifecycleEvent === "disconnect") {
      const rejection = await proveOldScopeRejectedAfterDisconnect(client, nativeScope, bindingHash, timeoutMs);
      emit({
        state: "PASS",
        phase: P1C_PHASE,
        topology: PORTFOLIO_TOPOLOGY,
        evidence: {
          hello: true,
          observeCount: 1,
          mutationSurface: "absent",
          p0b: "PASS",
          invalidation: "PASS",
          disconnect_invalidation: "observed_old_scope_rejected",
          reconnectRejection: rejection,
        },
      });
      return;
    }

    const invalidation = await waitForNativeInvalidation(client, lifecycleEvent, timeoutMs);
    emit({
      state: "PASS",
      phase: P1C_PHASE,
      topology: PORTFOLIO_TOPOLOGY,
      evidence: {
        hello: true,
        observeCount: 1,
        mutationSurface: "absent",
        p0b: "PASS",
        invalidation: "PASS",
        title_invalidation: lifecycleEvent === "title" ? "observed" : "not_targeted",
        saving_invalidation: lifecycleEvent === "saving" ? "observed" : "not_targeted",
        disconnect_invalidation: "pipe_closed_after_native_invalidation",
        invalidationSnapshot: invalidation.snapshot,
        closeReason: invalidation.closeReason,
      },
    });
  } catch (error) {
    emit({ state: "BLOCKED", phase: P1C_PHASE, topology: PORTFOLIO_TOPOLOGY, reasons: [boundedReason(error)] });
    process.exitCode = 2;
  }
}

async function waitForNativeInvalidation(client, event, timeout) {
  const expectedReason = event === "saving" ? "portfolio_saving" : "portfolio_returned_to_title";
  return await new Promise((resolve, reject) => {
    let snapshot = null;
    let closeReason = null;
    const finish = () => {
      if (snapshot !== null && closeReason !== null) {
        cleanup();
        resolve({ snapshot, closeReason });
      }
    };
    const onSnapshot = (candidate) => {
      if (candidate.state === "invalidated" && candidate.reasonCode === expectedReason) {
        snapshot = candidate;
        finish();
      }
    };
    const onClose = (reason) => {
      closeReason = reason;
      finish();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`portfolio_${event}_invalidation_timeout`));
    }, timeout);
    const cleanup = () => {
      clearTimeout(timer);
      unsubscribeSnapshot();
      unsubscribeClose();
    };
    const unsubscribeSnapshot = client.onSnapshot(onSnapshot);
    const unsubscribeClose = client.onClose(onClose);
  });
}

async function proveOldScopeRejectedAfterDisconnect(client, scope, bindingHash, timeout) {
  client.close("p1c_disconnect_probe");
  const deadline = Date.now() + timeout;
  let lastError = "portfolio_disconnect_rejection_timeout";
  while (Date.now() < deadline) {
    try {
      const reconnect = await PortfolioStardewBridgeClient.connect(
        {
          integrationId: "stardew_portfolio",
          topology: PORTFOLIO_TOPOLOGY,
          ...scope,
          bindingHash,
        },
        process.env.GAMEBUDDY_PORTFOLIO_PIPE_NAME,
        process.env.GAMEBUDDY_PORTFOLIO_BRIDGE_TOKEN,
      );
      reconnect.close("p1c_reconnect_probe");
      lastError = "portfolio_old_scope_still_accepted";
    } catch (error) {
      return boundedReason(error);
    }
    await delay(100);
  }
  throw new Error(lastError);
}

function assertReady(snapshot, scope, bindingHash) {
  if (
    snapshot.state !== "ready" ||
    snapshot.worldReady !== true ||
    snapshot.singlePlayer !== true ||
    snapshot.currentLocalPlayerMatches !== true
  )
    throw new Error(`portfolio_observe_not_ready:${snapshot.reasonCode}`);
  if (
    snapshot.saveId !== scope.saveId ||
    snapshot.worldId !== scope.worldId ||
    snapshot.localPlayerId !== scope.localPlayerId ||
    snapshot.companionId !== scope.companionId ||
    snapshot.bindingGeneration !== scope.bindingGeneration ||
    snapshot.bindingHash !== bindingHash
  )
    throw new Error("portfolio_observe_scope_mismatch");
}
function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}
function readTimeout() {
  const value = Number(readOption("--timeout-ms") ?? 60_000);
  return Number.isSafeInteger(value) && value >= 1_000 && value <= 300_000 ? value : 60_000;
}
function boundedReason(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/\s+/g, " ")
    .slice(0, 256);
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function emit(value) {
  console.log(JSON.stringify(value));
}
