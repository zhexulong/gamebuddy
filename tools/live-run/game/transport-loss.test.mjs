/**
 * A dead transport is not a turn to wait for.
 *
 * Measured 2026-10-25: the pipe closed at in-game 22:00, in the same second the companion's own reasoning said "Time is
 * 2200 … I'm inside the house. Should I sleep?". Its tool calls show `advance_day` **zero times**, because the next thing
 * it received was a fact batch triggered by `host_local_transport:lifecycle:transport_disconnected`.
 *
 * The harness kept waiting through the rest of the evening. The world ran on to a 2:00 AM pass-out, and the run reported
 * `companion_did_not_sleep` - the consequences of a transport loss, attributed to her behaviour. Every minute after the
 * disconnect was evidence about a bridge that was not there.
 *
 * These cases pin the three properties that matter:
 *
 *   - a dead bridge ends the wait, immediately rather than at the turn budget;
 *   - the stop is NAMED for the transport, so a reader does not have to infer it;
 *   - a live bridge is unaffected, which is the half that keeps this from becoming "stop whenever anything is missing".
 */
import assert from "node:assert/strict";
import test from "node:test";

import { shouldAbandonTurnForTransport } from "./transport-loss.mjs";

test("a recorded disconnection ends the wait", () => {
  const verdict = shouldAbandonTurnForTransport([{ reasonCode: "pipe_closed", atMs: 1792937724433 }]);
  assert.equal(verdict.abandon, true);
  assert.equal(verdict.reasonCode, "turn_ended_by_transport_loss:pipe_closed");
});

test("no disconnection leaves the turn alone", () => {
  assert.deepEqual(shouldAbandonTurnForTransport([]), { abandon: false, reasonCode: null });
});

test("the reason code carries why the bridge went, not just that it did", () => {
  // A bare "transport lost" would be the same blanket code this project keeps removing.
  const verdict = shouldAbandonTurnForTransport([{ reasonCode: "pipe_error:ECONNRESET" }]);
  assert.match(verdict.reasonCode, /pipe_error:ECONNRESET$/);
});

test("a disconnection with no reason still names itself", () => {
  const verdict = shouldAbandonTurnForTransport([{ atMs: 1 }]);
  assert.equal(verdict.reasonCode, "turn_ended_by_transport_loss:unknown");
});
