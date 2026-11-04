import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The two headers that name the turn an outbound provider request belongs to.
 *
 * A captured wire body could not be attributed to a turn before this: a live run could only
 * count bodies in arrival order, so a `/models` probe, a transport retry or a second surface
 * shifted every reading after it and one driver reported another's prompt. Arrival order is
 * not turn order, and nothing on the wire said which turn a body was.
 *
 * Two identities, because the two parties that must agree know different things. The Host knows
 * `turn_<uuid>`, and nothing else does. A browser knows the idempotency key it submitted the turn
 * under (`newIdempotencyKey()`, an opaque 16-byte token), and the Host deliberately never gives it
 * back the raw turn id - the browser only ever sees an HMAC turn handle. The store maps the two, so
 * either identity alone is enough to *find* the turn, but only the key lets a reader that holds a
 * page's marks name the request that page caused. Recording both means the join needs no knowledge
 * of the store's schema, and a support engineer can correlate a player's report with a wire request
 * without opening a database.
 *
 * Both values are opaque identities: no prompt text, no credential, no path.
 */
export const PROVIDER_TURN_HEADER_NAME = "X-GameBuddy-Turn-Id";
export const PROVIDER_IDEMPOTENCY_KEY_HEADER_NAME = "X-GameBuddy-Idempotency-Key";

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
export type ProviderTurnNaming = Readonly<{ turnId: string; idempotencyKey: string }>;

export type ProviderTurnHeaderScope = Readonly<{
  setTurn(naming: ProviderTurnNaming): void;
  /** Clears only the turn it names, so a successor turn's value is never erased by this one. */
  clearTurn(turnId: string): void;
  /** The turn in flight, or `undefined` when the request belongs to no turn at all. */
  turnInFlight(): ProviderTurnNaming | undefined;
}>;

export function createProviderTurnHeaderScope(): ProviderTurnHeaderScope {
  let naming: ProviderTurnNaming | undefined;
  return Object.freeze({
    setTurn(next: ProviderTurnNaming): void {
      naming = Object.freeze({ turnId: next.turnId, idempotencyKey: next.idempotencyKey });
    },
    clearTurn(clearing: string): void {
      if (naming?.turnId === clearing) naming = undefined;
    },
    turnInFlight: () => naming,
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
    const naming = scope.turnInFlight();
    if (naming === undefined) return;
    event.headers[PROVIDER_TURN_HEADER_NAME] = naming.turnId;
    event.headers[PROVIDER_IDEMPOTENCY_KEY_HEADER_NAME] = naming.idempotencyKey;
  });
}
