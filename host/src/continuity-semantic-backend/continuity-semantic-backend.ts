import type {
  ArchiveLifecycleCommand,
  AuthenticatedContinuityPrincipal,
  ChatCommandReadback,
  ChatSelectionCommand,
  ContinuitySemanticStore,
  GameAbortReason,
  GameCommand,
  GameCommandReadback,
  GameEffectFailureReason,
  GamePermit,
  GameTerminalReceipt,
} from "../continuity-semantic-store/continuity-semantic-store.js";
import type {
  ContinuityAuthorityBackend,
  ContinuityAuthorityBackendResult,
  ContinuityAuthorityCommand,
  ContinuityAuthorityEffect,
  ContinuityAuthorityEffectFailureResult,
} from "../continuity-authority-coordinator/continuity-authority-coordinator.js";

/** The deliberately narrow, unmounted semantic-store surface used by the authority coordinator. */
export type ContinuitySemanticBackendStore = Pick<
  ContinuitySemanticStore,
  | "selectOpenExactChat"
  | "transitionArchiveLifecycle"
  | "prepareGameOperation"
  | "commitGameOperation"
  | "abortGameOperation"
  | "failGameOperation"
>;

/**
 * Adapts exact semantic-store operations to the coordinator's durable authority
 * protocol. It owns no runtime, database lifecycle, adoption, or cache.
 */
export function createContinuitySemanticBackend(store: ContinuitySemanticBackendStore): ContinuityAuthorityBackend {
  return Object.freeze({
    authority: "SEMANTIC",
    prepare(command): ContinuityAuthorityBackendResult {
      if (command.kind === "chat_select_open") return completedChat(store.selectOpenExactChat(command.input));
      if (command.kind === "archive_lifecycle") return completedChat(store.transitionArchiveLifecycle(command.input));
      const outcome = store.prepareGameOperation(command.input);
      if (outcome.outcome === "effect_owned") {
        const permit = outcome.permit;
        return Object.freeze({ state: "effect_owned", permit, effect: effectForPermit(permit) });
      }
      if (outcome.outcome === "effect_pending")
        return Object.freeze({ state: "effect_pending", result: outcome.readback });
      return Object.freeze({ state: "completed", result: outcome.readback });
    },
    commit(permit: GamePermit, receipt: GameTerminalReceipt): GameCommandReadback {
      return store.commitGameOperation({ principal: principalForPermit(permit), permit, receipt });
    },
    abort(permit: GamePermit, reason: GameAbortReason): GameCommandReadback {
      return store.abortGameOperation({ principal: principalForPermit(permit), permit, reason });
    },
    effectFailed(
      _principal: AuthenticatedContinuityPrincipal,
      permit: GamePermit,
      reason: GameEffectFailureReason,
    ): ContinuityAuthorityEffectFailureResult {
      return Object.freeze({
        state: "effect_failed",
        result: store.failGameOperation({ principal: principalForPermit(permit), permit, reason }),
      });
    },
  });
}

function completedChat(result: ChatCommandReadback): ContinuityAuthorityBackendResult {
  return Object.freeze({ state: "completed", result });
}
function principalForPermit(permit: GamePermit): AuthenticatedContinuityPrincipal {
  return Object.freeze({
    continuityId: permit.origin.continuityId,
    companionId: permit.origin.companionId,
    playerId: permit.origin.playerId,
  });
}
function effectForPermit(permit: GamePermit): ContinuityAuthorityEffect {
  const kind =
    permit.kind === "game_enter"
      ? "bootstrap_game_runtime"
      : permit.kind === "game_return"
        ? "teardown_game_runtime"
        : permit.kind === "lease_release"
          ? "release_game_runtime"
          : "recover_game_runtime";
  return Object.freeze({ kind, permit });
}

export type { ArchiveLifecycleCommand, ChatSelectionCommand, GameCommand };
