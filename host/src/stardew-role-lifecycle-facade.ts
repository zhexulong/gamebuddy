/**
 * Frozen Task 5: two-role lifecycle reduction kernel.
 *
 * Composes `StardewAttachmentFlow` (player-Host evidence) and
 * `StardewAiClientProcessOwner` (AI-client ownership) into a single redacted,
 * immutable view. The facade is a projector only — it creates no connection,
 * role attestation, process control, or session validation authority.
 *
 * Authorities:
 *   `StardewAttachmentFlow.readCompatibilityOutcome()` — sole player-host
 *       evidence. The facade maps this to a categorical slot.
 *   `StardewAiClientProcessOwner` — sole direct-spawn child ownership/stop
 *       authority. The facade delegates the stop path and maps `readStatus()`
 *       to the redacted aiClient slot. Launching is reserved: a child may only
 *       spawn through `reserveAiClientLaunch()` + `reservation.launch()` once
 *       the durable owner record exists, never through a facade launch route.
 *
 * No field/value/string may claim `connected`, `connecting`, `attached`,
 * `ready`, `active`, capability or companion role attestation.
 */

import type { StardewCompatibilityStatus } from "./stardew-compatibility.js";
import { StardewAttachmentFlow } from "./stardew-attachment.js";
import type {
  StardewAiClientProcessOwner,
  StopOwnedAiClientResult,
} from "./stardew-ai-client-process-owner.js";
import type { StardewPlayerHostProcessOwner } from "./stardew-player-host-process-owner.js";

// ── Public view types ───────────────────────────────────────────────────────

type StardewPlayerHostSlot =
  | Readonly<{ state: "not_started"; ownership: "none" }>
  | Readonly<{ state: "pending"; ownership: "gamebuddy_direct_spawn" }>
  | Readonly<{ state: "awaiting_attestation"; ownership: "gamebuddy_direct_spawn" }>
  | Readonly<{ state: "stopped"; ownership: "gamebuddy_direct_spawn" }>
  | Readonly<{ state: "unknown"; ownership: "player_external" }>
  | Readonly<{ state: "unavailable"; ownership: "player_external" }>
  | Readonly<{
      state: "authenticated";
      ownership: "player_external";
      compatibility: StardewCompatibilityStatus;
      attachmentAllowed: boolean;
    }>;

type StardewAiClientSlot =
  | Readonly<{ state: "not_started"; ownership: "none" }>
  | Readonly<{
      state: "awaiting_attestation";
      ownership: "gamebuddy_direct_spawn";
      lastStopOutcome: "none" | "identity_unverified" | "termination_failed";
    }>
  | Readonly<{ state: "stopped"; ownership: "gamebuddy_direct_spawn" }>;

export type StardewRoleLifecycleView = Readonly<{
  schemaVersion: 1;
  playerHost: StardewPlayerHostSlot;
  aiClient: StardewAiClientSlot;
}>;

export type StardewRoleLifecycleReader = Readonly<{
  /** Refresh player evidence and return the composed redacted view. */
  readRoleLifecycleView(): Promise<StardewRoleLifecycleView>;
}>;

export type StardewRoleLifecycleFacade = StardewRoleLifecycleReader & Readonly<{
  /** Narrow process owner delegation: stop the owned AI-client child. */
  stopOwnedAiClient(): StopOwnedAiClientResult;
}>;

type LastStopOutcome = "none" | "identity_unverified" | "termination_failed";

// ── Facade implementation ──────────────────────────────────────────────────

class StardewRoleLifecycleFacadeImpl implements StardewRoleLifecycleFacade {
  readonly #attachment: StardewAttachmentFlow | null;
  readonly #processOwner: StardewAiClientProcessOwner;
  readonly #playerHostProcessOwner: StardewPlayerHostProcessOwner | null;
  #lastStopOutcome: LastStopOutcome = "none";

  public constructor(
    attachment: StardewAttachmentFlow | null,
    processOwner: StardewAiClientProcessOwner,
    playerHostProcessOwner: StardewPlayerHostProcessOwner | null,
  ) {
    this.#attachment = attachment;
    this.#processOwner = processOwner;
    this.#playerHostProcessOwner = playerHostProcessOwner;
  }

  async readRoleLifecycleView(): Promise<StardewRoleLifecycleView> {
    // Refresh player evidence. Failure maps player slot to unavailable and
    // must not alter the ai slot.
    let playerHost: StardewPlayerHostSlot;
    try {
      const outcome = this.#attachment === null
        ? undefined
        : await this.#attachment.readCompatibilityOutcome();
      playerHost = outcome === undefined
        ? this.#composeOwnedPlayerHostSlot()
        : Object.freeze({
            state: "authenticated",
            ownership: "player_external",
            compatibility: outcome.status,
            attachmentAllowed: outcome.attachmentAllowed,
          });
    } catch {
      // No raw error — only categorical projection.
      playerHost = Object.freeze({ state: "unavailable", ownership: "player_external" });
    }

    const aiClient = this.#composeAiClientSlot();

    return Object.freeze({ schemaVersion: 1, playerHost, aiClient });
  }

  stopOwnedAiClient(): StopOwnedAiClientResult {
    const result = this.#processOwner.stopOwnedAiClient();
    switch (result.kind) {
      case "terminated":
        this.#lastStopOutcome = "none";
        break;
      case "identity_probe_failed":
      case "identity_mismatch":
        this.#lastStopOutcome = "identity_unverified";
        break;
      case "termination_failed":
        this.#lastStopOutcome = "termination_failed";
        break;
      // no_owned_ai_client and already_stopped do not change lastStopOutcome
    }
    return result;
  }

  #composeOwnedPlayerHostSlot(): StardewPlayerHostSlot {
    const status = this.#playerHostProcessOwner?.readStatus();
    switch (status?.kind) {
      case undefined:
      case "idle":
        return Object.freeze({ state: "not_started", ownership: "none" });
      case "player_host_launch_pending":
        return Object.freeze({ state: "pending", ownership: "gamebuddy_direct_spawn" });
      case "awaiting_player_host_attestation":
        return Object.freeze({ state: "awaiting_attestation", ownership: "gamebuddy_direct_spawn" });
      case "player_host_stopped":
        return Object.freeze({ state: "stopped", ownership: "gamebuddy_direct_spawn" });
    }
  }

  #composeAiClientSlot(): StardewAiClientSlot {
    const status = this.#processOwner.readStatus();
    switch (status.kind) {
      case "idle":
        return Object.freeze({ state: "not_started", ownership: "none" });
      case "ai_client_launch_pending":
        return Object.freeze({ state: "not_started", ownership: "none" });
      case "awaiting_ai_client_attestation":
        return Object.freeze({
          state: "awaiting_attestation",
          ownership: "gamebuddy_direct_spawn",
          lastStopOutcome: this.#lastStopOutcome,
        });
      case "ai_client_stopped":
        return Object.freeze({ state: "stopped", ownership: "gamebuddy_direct_spawn" });
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createStardewRoleLifecycleFacade(
  attachment: StardewAttachmentFlow | null,
  processOwner: StardewAiClientProcessOwner,
  playerHostProcessOwner: StardewPlayerHostProcessOwner | null = null,
): StardewRoleLifecycleFacade {
  return new StardewRoleLifecycleFacadeImpl(attachment, processOwner, playerHostProcessOwner);
}
