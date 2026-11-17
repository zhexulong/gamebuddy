/**
 * When a closed bridge stops being a stall and becomes the end of the run.
 *
 * <p>
 * MEASURED 2026-11-17 (`round66`): `BRIDGE_DISCONNECTED reasonCode=fact_listener_failed` at 1006833 ms, and then
 * thirty-two `GAME_CLOCK_STALLED` lines over the next sixteen minutes - every one of them carrying
 * `solicit: "not_attempted:bridge_closed"`, `readingsSeen` frozen at 32 and `sinceLastSnapshotMs` climbing from 249440
 * to 1179640 - before the log simply stopped. `round65` is the same shape (to 1326166 ms). The first reading of
 * round67 was "it hung", and sixteen minutes of stalling is why: nothing in the log said the harness had decided
 * anything, because it had not.
 * </p>
 * <p>
 * A closed bridge is not a slow world. Once the pipe is gone this run makes no further observation, dispatches nothing,
 * and cannot see a night cross: there is no state to wait for and no bound that waiting could reach. So the reading
 * ENDS the wait, at the first one, with the reason printed - not with a stall counter that keeps counting.
 * </p>
 * <p>
 * The two inputs are the two places the run can learn it. `bridgeDisconnections` is the transport's own statement, and
 * the day loop holds it before it polls. `solicit` is the game clock's token, and it is the reading round66 actually
 * published thirty-two times; it is accepted here too so the beat and the loop cannot disagree about what "closed"
 * means.
 * </p>
 */

/** The token prefix every reading of a closed bridge carries, in the log and in this decision. */
export const BRIDGE_CLOSED = "bridge_closed";

/** The token the game clock publishes when it can no longer ask: `not_attempted:<reason>`. */
export const BRIDGE_CLOSED_SOLICIT = `not_attempted:${BRIDGE_CLOSED}`;

/**
 * The stop this run's own transport answers with, or `null` when there is still something to wait for.
 *
 * A `null` here is a claim: the transport is open, so the world can still change and a wait is a wait. Everything that
 * returns a record is a claim the other way, and the caller must end its wait rather than poll again.
 */
export function bridgeClosureStop({ bridgeDisconnections = [], solicit = null } = {}) {
  const first = Array.isArray(bridgeDisconnections) ? bridgeDisconnections[0] : undefined;
  if (first !== undefined && first !== null)
    return Object.freeze({
      // ONE SPELLING: the code the transport published travels inside the stop, so a result naming
      // `bridge_closed:fact_listener_failed` can be traced to the line that closed it.
      reasonCode: `${BRIDGE_CLOSED}:${String(first.reasonCode ?? "unknown")}`,
      cause: "bridge_disconnected",
      atMs: Number.isFinite(first.atMs) ? first.atMs : null,
    });
  if (solicit === BRIDGE_CLOSED_SOLICIT)
    return Object.freeze({
      reasonCode: `${BRIDGE_CLOSED}:clock_could_not_ask`,
      cause: "clock_could_not_ask",
      atMs: null,
    });
  return null;
}

/**
 * How many stall readings a closed bridge would have cost, and where the run would have ended.
 *
 * This is the gate's own arithmetic, and it lives beside the decision so the number reported is the number the
 * decision produces: feed it the stall payloads a run published and it answers the index of the reading that ends the
 * wait (`endedAt`) and the ones that were allowed to repeat after it (`repeatedAfterEnd`). A run that has not seen a
 * closed bridge answers `endedAt: null` with every reading examined - "waiting is still waiting" - which is the other
 * half of the same property.
 */
export function countStallsAfterClosure(stallPayloads) {
  if (!Array.isArray(stallPayloads)) throw new Error("countStallsAfterClosure needs the stall readings");
  const examined = stallPayloads.length;
  let endedAt = null;
  for (const [index, payload] of stallPayloads.entries()) {
    const stop = bridgeClosureStop({ solicit: payload?.solicit ?? null });
    if (stop !== null) {
      endedAt = index;
      break;
    }
  }
  return Object.freeze({
    examined,
    endedAt,
    // Every reading after the one that ended the wait is a repeat this rule refuses. On round66 that number is 31: the
    // 32 lines the run published, minus the one that should have ended it.
    repeatedAfterEnd: endedAt === null ? 0 : examined - endedAt - 1,
  });
}
