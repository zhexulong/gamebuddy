import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The header that names the Chat turn an outbound provider request belongs to.
 *
 * A captured wire body could not be attributed to a turn before this: a live run could only
 * count bodies in arrival order, so a `/models` probe, a transport retry or a second surface
 * shifted every reading after it and one driver reported another's prompt. Arrival order is
 * not turn order, and nothing on the wire said which turn a body was.
 *
 * The value is the Host's own turn identity (`ProviderInvocationScope.facts.turnId`) and
 * nothing else: no prompt text, no credential, no path.
 */
export const PROVIDER_TURN_HEADER_NAME = "X-GameBuddy-Turn-Id";

/** The name the loader publishes this extension under, as `<inline:gamebuddy-provider-turn-header>`. */
export const PROVIDER_TURN_HEADER_EXTENSION_NAME = "gamebuddy-provider-turn-header";

/**
 * The turn whose provider request is in flight, held for the session that will send it.
 *
 * One holder per mounted runtime session, set by the provider-start runner immediately before
 * `session.prompt()` and cleared once that prompt has drained. A stale value is worse than
 * none - it would attribute a request to the previous turn, which is the defect this replaces -
 * so the runner clears in a `finally` and clearing names the turn it clears.
 */
export type ProviderTurnHeaderScope = Readonly<{
  setTurn(turnId: string): void;
  /** Clears only the turn it names, so a successor turn's value is never erased by this one. */
  clearTurn(turnId: string): void;
  /** The turn in flight, or `undefined` when the request belongs to no turn at all. */
  turnInFlight(): string | undefined;
}>;

export function createProviderTurnHeaderScope(): ProviderTurnHeaderScope {
  let turnId: string | undefined;
  return Object.freeze({
    setTurn(next: string): void {
      turnId = next;
    },
    clearTurn(clearing: string): void {
      if (turnId === clearing) turnId = undefined;
    },
    turnInFlight: () => turnId,
  });
}

/**
 * The inline Pi extension that stamps every outbound provider request with the turn in flight.
 *
 * `before_provider_headers` is the only per-request seam Pi exposes to its embedding Host:
 * `PromptOptions` carries no headers, `CreateAgentSessionOptions` has neither `headers` nor
 * `streamFn`, and a `models.json` header belongs to a provider entry and is therefore fixed for
 * the life of the process. The hook fires after Pi has assembled the request's headers and
 * before the provider call, and it mutates them in place, so what is stamped here is what the
 * transport sends.
 *
 * A request that belongs to no turn is left alone: absence is a fact a reader can state, and an
 * empty value is not.
 */
export function providerTurnHeaderExtension(pi: ExtensionAPI, scope: ProviderTurnHeaderScope): void {
  pi.on("before_provider_headers", (event) => {
    const turnId = scope.turnInFlight();
    if (turnId === undefined) return;
    event.headers[PROVIDER_TURN_HEADER_NAME] = turnId;
  });
}
