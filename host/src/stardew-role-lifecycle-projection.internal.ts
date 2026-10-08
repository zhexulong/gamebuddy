/**
 * The coordinator's Player Host projection rule for the redacted role lifecycle
 * view. `game.state.read` (`game-browser-state-provider.ts`) is the only
 * consumer of that view, and it derives `instance.status` from this slot.
 *
 * Why this rule exists rather than plain facade delegation: the coordinator is
 * the only component that knows whether a Player Host launch has been
 * requested. Activation reserves a durable owner and mints a Player Host launch
 * reservation; the separate admitted `game/launch` operation consumes that
 * reservation later. An outstanding reservation is therefore an *authorization*,
 * not a running role: the process owner reports `player_host_launch_pending`
 * for the whole activated-but-not-launched window, and the facade faithfully
 * renders that as `{ state: "pending", ownership: "gamebuddy_direct_spawn" }`.
 * Passing that through in `staged` makes `game.state.read` announce
 * `instance.status === "launching"` while no launch is in flight, which hides
 * both controls from the player: activation is already done and the launch gate
 * requires `instance.status === "none"`.
 *
 * So `pending`/`awaiting_attestation` are reserved here for the states in which
 * a launch really is in flight or a child really did spawn, and every state in
 * which the coordinator knows no launch was requested answers for itself:
 * `staged` is "ready to start, nothing running", which the browser contract
 * reads as `instance.status === "none"` carrying the exact expected generation
 * from the coordinator's launch-readiness reader.
 *
 * Every other state (inactive, reserving, staging, failed, closing, closed) is
 * left to the facade's process-owner projection. In `reserving`/`staging` that
 * projection still reports the reservation minted by activation as `pending`,
 * which the browser reads as `launching`; that window lasts only while the
 * activation command is in flight and the client shows its own
 * activation-in-progress status there.
 */

import type { StardewPrivateActivationSnapshot } from "./stardew-production-lifecycle-coordinator.internal.js";
import type { StardewRoleLifecycleView } from "./stardew-role-lifecycle-facade.js";

/** Coordinator-authoritative Player Host slot, or `undefined` when the facade is authoritative. */
export function projectCoordinatorPlayerHostSlot(
  activationState: StardewPrivateActivationSnapshot["state"],
): StardewRoleLifecycleView["playerHost"] | undefined {
  switch (activationState) {
    case "launching_player_host":
      return Object.freeze({ state: "pending", ownership: "gamebuddy_direct_spawn" });
    case "awaiting_player_host_attestation":
      return Object.freeze({ state: "awaiting_attestation", ownership: "gamebuddy_direct_spawn" });
    case "staged":
      // Activated and ready to launch; no Player Host process exists yet, so the
      // composed slot must not claim GameBuddy-owned launch activity.
      return Object.freeze({ state: "not_started", ownership: "none" });
    default:
      return undefined;
  }
}

/** Composes the coordinator-owned slot into the facade's redacted view. */
export function composeCoordinatorRoleLifecycleView(
  activationState: StardewPrivateActivationSnapshot["state"],
  facadeView: StardewRoleLifecycleView,
): StardewRoleLifecycleView {
  const playerHost = projectCoordinatorPlayerHostSlot(activationState);
  if (playerHost === undefined) return facadeView;
  return Object.freeze({ schemaVersion: 1, playerHost, aiClient: facadeView.aiClient });
}
