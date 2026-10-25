/**
 * Whether a turn should be abandoned because the transport underneath it is gone.
 *
 * Kept as its own function because the decision has to be the same wherever it is asked, and because the failure it
 * prevents is an attribution error rather than a hang: a run that keeps waiting after the bridge closes does not merely
 * waste time, it reports the world's subsequent behaviour as the companion's.
 */
export function shouldAbandonTurnForTransport(disconnections) {
  if (!Array.isArray(disconnections) || disconnections.length === 0) {
    return Object.freeze({ abandon: false, reasonCode: null });
  }
  const reason = disconnections[0]?.reasonCode;
  return Object.freeze({
    abandon: true,
    reasonCode: `turn_ended_by_transport_loss:${String(reason ?? "unknown")}`,
  });
}
