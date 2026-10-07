// dismount_transport live contract.
//
// The action carries NO arguments: its subject is the actor's own mount and its readiness is
// native state, so `args` must be the empty object and nothing in the request names a horse,
// a tile or a slot.
//
// The receipt is not the proof. Three things are asserted:
//   1. the declared Given is a RIDING actor (the fixture establishes exactly that pair of native
//      facts: `Farmer.mount` set and `Horse.rider` pointing back at the actor). A receipt that
//      answers `dismount_transport_not_riding` means the fixture did not establish the Given, and
//      the run says so instead of reading it as a product failure;
//   2. the postcondition is the Mod's own re-read of the world after the call — `!isRidingHorse()`
//      and `mount is null` — reported as evidence. `Horse.dismount` is `void`, so no return value
//      could carry it. This snapshot revision publishes no "is riding" projection (the actor's own
//      mount is not part of any discovered target list), so the runner's independent half of that
//      fact is the repeat below;
//   3. the repeat. A second submission on the same session can only be refused with
//      `dismount_transport_not_riding` if the actor really has no mount any more — that refusal is
//      a fresh game-thread read of `Farmer.mount`, which is exactly the fact the first receipt
//      claims. A success there would mean the first receipt lied, and the run fails on it.
//
// Shared harness helpers (bounded scope, revision-bound requests, exact receipt identity,
// terminal wait, owned teardown) come from `stardew-native-smoke-harness-v1.mjs`.

import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "dismount_transport";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

export async function runDismountTransportSmoke(client, receipts, _config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  try {
    const snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const horsesBefore = Array.isArray(snapshot.horseTargets) ? snapshot.horseTargets.length : null;

    const requestId = `native_local_dismount_transport_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: {},
      snapshot,
      timeoutMs: 30_000,
    });
    trace.push({ step: "dismount", action: ACTION, receipt: summarizeReceipt(accepted) });
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.requestId !== requestId || terminal.executionId !== accepted.executionId)
      throw new Error("dismount_transport_terminal_identity_mismatch");
    if (terminal.state === "rejected" && terminal.reasonCode === "dismount_transport_not_riding")
      throw new Error(
        `dismount_transport_declared_given_absent:location=${snapshot.location ?? "?"};` +
          `tile=${snapshot.tile?.x ?? "?"},${snapshot.tile?.y ?? "?"};actionable=${snapshot.actionable}`,
      );
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "transport_dismounted")
      throw new Error(
        `dismount_transport_failed:${terminal.state}/${terminal.reasonCode};` +
          `tile=${snapshot.tile?.x ?? "?"},${snapshot.tile?.y ?? "?"}`,
      );

    const evidence = parseEvidence(terminal.evidence);
    assertEvidence(evidence, "riding_before", "true");
    assertEvidence(evidence, "riding_after", "false");
    assertEvidence(evidence, "mount_after", "false");

    // The world after the terminal: nothing owns the body, and the actor is free again. Observed
    // WITHOUT the harness's actionable assertion so that a busy world is this run's own, named
    // failure rather than a generic harness rejection.
    const after = await observeFresh(client);
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    // Loose comparison on purpose: the wire OMITS a null member, so "no active execution" arrives
    // as `undefined` and `undefined !== null` would fail a correct run.
    if (after.activeExecution != null)
      throw new Error(
        `dismount_transport_world_still_busy:${JSON.stringify({
          activeExecution: after.activeExecution,
          actionable: after.actionable,
          location: after.location,
          tile: after.tile,
        })}`,
      );
    if (after.actionable !== true) throw new Error(`dismount_transport_world_not_actionable:${after.actionable}`);

    // The repeat: only a real, mount-less actor can be refused here.
    const repeatRequestId = `native_local_dismount_transport_repeat_${Date.now()}`;
    const repeatAccepted = await executeFresh(client, {
      requestId: repeatRequestId,
      idempotencyKey: `${repeatRequestId}_idem`,
      action: ACTION,
      args: {},
      snapshot: after,
      timeoutMs: 30_000,
    });
    trace.push({ step: "repeat_while_unmounted", action: ACTION, receipt: summarizeReceipt(repeatAccepted) });
    const repeatTerminal = await waitForTerminal(receipts, repeatAccepted, terminalTimeoutMs);
    if (repeatTerminal.state === "succeeded")
      throw new Error(`dismount_transport_repeat_still_riding:${repeatTerminal.reasonCode}`);
    if (repeatTerminal.reasonCode !== "dismount_transport_not_riding")
      throw new Error(
        `dismount_transport_repeat_not_refused:${repeatTerminal.state}/${repeatTerminal.reasonCode};` +
          `body_slot=n/a;tile=${after.tile?.x ?? "?"},${after.tile?.y ?? "?"}`,
      );

    const horsesAfter = Array.isArray(after.horseTargets) ? after.horseTargets.length : null;
    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "transport_dismounted",
      horseId: evidence.horse_id ?? null,
      riding: { before: evidence.riding_before, after: evidence.riding_after, mountAfter: evidence.mount_after },
      horses: { before: horsesBefore, after: horsesAfter },
      repeat: { reasonCode: repeatTerminal.reasonCode, state: repeatTerminal.state },
      evidence,
      receipt: summarizeReceipt(terminal),
      trace,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
    };
  }
}

/** The wire carries the Mod's evidence string as `{ detail: "..." }`. */
export function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error("native_local_evidence_empty");
  return Object.fromEntries(
    detail
      .split(";")
      .map((pair) => {
        const index = pair.indexOf("=");
        return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
      })
      .filter(Boolean),
  );
}

function assertEvidence(evidence, key, expected) {
  if (evidence[key] !== expected)
    throw new Error(`dismount_transport_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runDismountTransportSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
