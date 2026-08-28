import { createStardewPrivateBootstrapComposition } from "./stardew-private-bootstrap-composer.internal.js";
import type {
  StopOwnedAiClientResult,
  StardewAiClientProcessOwner,
} from "./stardew-ai-client-process-owner.js";
import type {
  StopOwnedPlayerHostResult,
  StardewPlayerHostProcessOwner,
} from "./stardew-player-host-process-owner.js";
import {
  createStardewRoleLifecycleFacade,
  type StardewRoleLifecycleFacade,
  type StardewRoleLifecycleReader,
} from "./stardew-role-lifecycle-facade.js";

/** The production lifecycle surface deliberately exposes reads only. */
export type StardewProductionLifecycleCoordinator = Readonly<{
  readonly lifecycleReader: StardewRoleLifecycleReader;
  close(): Promise<void>;
}>;

type CloseState = "open" | "closing" | "closed";

/**
 * A close failure never converts an uncertain owner into a successful stop.
 * The next close may retry the exact owner operation that did not produce a
 * terminal result.
 */
class StardewProductionLifecycleCloseError extends Error {
  public constructor() {
    super("stardew_lifecycle_close_incomplete");
    this.name = "StardewProductionLifecycleCloseError";
  }
}

function isSuccessfulAiStop(result: StopOwnedAiClientResult): boolean {
  return (
    result.kind === "no_owned_ai_client" ||
    result.kind === "already_stopped" ||
    result.kind === "terminated"
  );
}

function isSuccessfulPlayerHostStop(result: StopOwnedPlayerHostResult): boolean {
  return (
    result.kind === "no_owned_player_host" ||
    result.kind === "already_stopped" ||
    result.kind === "terminated"
  );
}

function closeIncomplete(): StardewProductionLifecycleCloseError {
  return new StardewProductionLifecycleCloseError();
}

type ProductionBootstrapComposition = ReturnType<typeof createStardewPrivateBootstrapComposition>["composition"];

function createCoordinatorFromComposition(
  composition: ProductionBootstrapComposition,
): StardewProductionLifecycleCoordinator {
  const facade: StardewRoleLifecycleFacade = createStardewRoleLifecycleFacade(
    null,
    composition.aiClientProcessOwner,
  );

  // Keep the read-only projection separate from the facade so no consumer can
  // reach either role's stop authority through the coordinator result.
  let state: CloseState = "open";
  let brokerClosed = false;
  let aiClientStopped = false;
  let playerHostStopped = false;
  let closePromise: Promise<void> | undefined;

  const lifecycleReader: StardewRoleLifecycleReader = Object.freeze({
    async readRoleLifecycleView() {
      if (state === "closed") throw new Error("stardew_lifecycle_closed");
      return facade.readRoleLifecycleView();
    },
  });

  const closeImpl = async (): Promise<void> => {
    if (state === "closed") return;
    state = "closing";

    if (!brokerClosed) {
      try {
        composition.broker.close();
        brokerClosed = true;
      } catch {
        throw closeIncomplete();
      }
    }

    if (!aiClientStopped) {
      let result: StopOwnedAiClientResult;
      try {
        result = composition.aiClientProcessOwner.stopOwnedAiClient();
      } catch {
        throw closeIncomplete();
      }
      if (!isSuccessfulAiStop(result)) throw closeIncomplete();
      aiClientStopped = true;
    }

    if (!playerHostStopped) {
      let result: StopOwnedPlayerHostResult;
      try {
        result = composition.playerHostProcessOwner.stopOwnedPlayerHost();
      } catch {
        throw closeIncomplete();
      }
      if (!isSuccessfulPlayerHostStop(result)) throw closeIncomplete();
      playerHostStopped = true;
    }

    state = "closed";
  };

  const close = (): Promise<void> => {
    if (state === "closed") return closePromise ?? Promise.resolve();
    if (closePromise !== undefined) return closePromise;

    const attempt = closeImpl();
    closePromise = attempt;
    void attempt.then(
      () => undefined,
      () => {
        // A failed close retains all unproven owner authority. Clear only the
        // in-flight promise so a later caller can retry the failed operation.
        if (state !== "closed") closePromise = undefined;
      },
    );
    return attempt;
  };

  return Object.freeze({ lifecycleReader, close });
}

/**
 * Constructs the production coordinator from the closed first-party
 * composition. No caller-supplied dependency can become lifecycle authority.
 */
export function createStardewProductionLifecycleCoordinator(): StardewProductionLifecycleCoordinator {
  const internal = createStardewPrivateBootstrapComposition();
  return createCoordinatorFromComposition(internal.composition);
}
