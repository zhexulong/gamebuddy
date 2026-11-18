/**
 * What the companion could actually do with the surface it was given, derived from one run's own records.
 *
 * Two readings of the same executions: `summarizeExecutionOutcomes` answers per execution (a receipt's identity is
 * `(executionId, reasonCode)`, because one execution legally emits several receipts and only one of them ends it), and
 * `buildCapabilityAudit` folds those outcomes back onto the dispatches the trace recorded. The audit exists because
 * "it was admitted" and "it finished" are different facts: an admission is not an outcome, and a receipt that only
 * progressed an action is not its terminal.
 */

/**
 * Per-execution receipt outcomes, derived from the run's own facts.
 *
 * Deduplicating receipts by `executionId` alone was WRONG and hid real failures: one execution legally
 * emits several receipts (`accepted` -> `controller_started` -> `tool_approach_completed` ->
 * `target_out_of_reach`), so the first one seen claimed the execution and every later code — including
 * its authoritative terminal failure — was dropped. Measured on a real run: three harvest executions
 * ended in `target_out_of_reach`, `capabilityAudit` still reported `harvest_crop.verdict: "succeeded"`
 * with `unresolved: []`, and `target_out_of_reach` appeared nowhere in the audit.
 *
 * A receipt's identity is therefore `(executionId, reasonCode)`: the bridge's legitimate redelivery
 * repeats the same pair, while a different code is a different fact about the same execution. Codes that
 * cannot end an execution are progress; anything else is a terminal claim, classified against the
 * action's registered success terminal from the published gate table.
 */
export function summarizeExecutionOutcomes({ facts, actionOfRequest, terminalReasonCodes }) {
  // Codes that cannot END an execution: anything else is a terminal claim. Declared here so this
  // function is self-contained and can be evaluated (and tested) on its own.
  const progressCodes = new Set(["accepted", "controller_started", "tool_approach_completed", "tile_advanced"]);
  const byExecution = new Map();
  const seen = new Set();
  for (const fact of facts ?? []) {
    if (fact?.type !== "execution_receipt") continue;
    const actionId = typeof fact.requestId === "string" ? actionOfRequest.get(fact.requestId) : undefined;
    if (actionId === undefined) continue;
    const executionId =
      typeof fact.executionId === "string" && fact.executionId.length > 0
        ? fact.executionId
        : `${fact.requestId}:${fact.reasonCode}`;
    const code = typeof fact.reasonCode === "string" && fact.reasonCode.length > 0 ? fact.reasonCode : "unknown";
    const key = `${executionId}\u001f${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const current = byExecution.get(executionId) ?? { actionId, terminals: [] };
    if (!progressCodes.has(code)) current.terminals.push(code);
    byExecution.set(executionId, current);
  }
  const perAction = new Map();
  for (const entry of byExecution.values()) {
    const registered = terminalReasonCodes[entry.actionId];
    const succeeded = entry.terminals.includes(registered);
    const failures = entry.terminals.filter((code) => code !== registered);
    const current = perAction.get(entry.actionId) ?? {
      executions: { succeeded: 0, failed: 0, inFlight: 0 },
      failedTerminalReasonCodes: {},
    };
    if (succeeded) current.executions.succeeded += 1;
    else if (failures.length > 0) current.executions.failed += 1;
    else current.executions.inFlight += 1;
    for (const code of failures)
      current.failedTerminalReasonCodes[code] = (current.failedTerminalReasonCodes[code] ?? 0) + 1;
    perAction.set(entry.actionId, current);
  }
  return perAction;
}

/**
 * the self-directed scenario's capability/stall audit.
 *
 * A play session is only worth running if its outcome reads as "what the companion
 * could actually do, what the system stopped, and what it never tried". Two
 * authorities make that answerable from the trace alone:
 *
 *   - `actionTrace` records one entry per DISPATCH the Agent sent: the action, its
 *     requestId, the admission state, or the throw when the dispatch was refused.
 *     An admission (`accepted`) is NOT an outcome — the terminal arrives later as a
 *     receipt fact, so counting admissions as failures invents stalls.
 *   - `STARDEW_PUBLISHED_ACTION_GATES` names each action's terminal reason code, so
 *     receipts can be joined to the action that caused them (by requestId, deduped
 *     by executionId) and judged against the registered terminal rather than
 *     against a heuristic list of "success-sounding" codes.
 *
 * Per action the audit therefore reports dispatches (with admission and rejection
 * histograms) plus terminal receipts, and classifies:
 *   blockedBySystem  dispatched, never reached its terminal, and the trace shows a
 *                    refusal or a terminal failure — the stalls to attribute
 *   unresolved       dispatched, never reached its terminal, and NO terminal or
 *                    refusal was observed — a gap to report, never a claimed stall
 *   failed           dispatched, reached a terminal failure code
 *   succeeded        reached its registered terminal
 *   notAttempted     advertised actions the session never dispatched, sampled from
 *                    the LIVE surface (sampled while the session ran, not after it)
 */
export function buildCapabilityAudit({
  actionTrace,
  facts,
  visibleActionIds,
  sessionTurns,
  terminalReasonCodes = {},
  advertisedSampleCount = 0,
  advertisedSampleMaxSize = 0,
}) {
  const byAction = new Map();
  const actionOfRequest = new Map();
  const stateOf = (value) => (typeof value === "string" && value.length > 0 ? value : "unknown");
  const bump = (table, key) => {
    if (typeof key !== "string" || key.length === 0) return;
    table[key] = (table[key] ?? 0) + 1;
  };
  for (const entry of actionTrace ?? []) {
    if (typeof entry?.action !== "string") continue;
    const current = byAction.get(entry.action) ?? {
      actionId: entry.action,
      dispatches: 0,
      admissionStates: {},
      rejections: {},
      terminalReceipts: 0,
      terminalReasonCodes: {},
      // Non-terminal receipts are PROGRESS (accepted/controller_started/
      // tile_advanced...). They are recorded for the reader but never counted as
      // failures: only a dispatch refusal is unambiguous evidence of a stop, and
      // claiming more than that would be the audit inventing a stall.
      progressReceipts: 0,
      receiptReasonCodes: {},
    };
    current.dispatches += 1;
    const state = stateOf(entry.state);
    bump(current.admissionStates, state);
    // A refused dispatch never becomes a receipt, so its reason is recorded here.
    if (state === "rejected" || state === "failed" || state === "uncertain")
      bump(current.rejections, stateOf(entry.reasonCode));
    if (typeof entry.requestId === "string" && entry.requestId.length > 0)
      actionOfRequest.set(entry.requestId, entry.action);
    byAction.set(entry.action, current);
  }

  // Join receipts back to the action that caused them. The fact log carries no
  // actionId, but it does carry requestId/executionId; see summarizeExecutionOutcomes for why
  // the identity is (executionId, reasonCode) and not executionId alone.
  const seenReceipt = new Set();
  for (const fact of facts ?? []) {
    if (fact?.type !== "execution_receipt") continue;
    const actionId = typeof fact.requestId === "string" ? actionOfRequest.get(fact.requestId) : undefined;
    if (actionId === undefined) continue;
    const current = byAction.get(actionId);
    if (current === undefined) continue;
    const executionId =
      typeof fact.executionId === "string" && fact.executionId.length > 0
        ? fact.executionId
        : `${fact.requestId}:${fact.reasonCode}`;
    const code = stateOf(fact.reasonCode);
    const key = `${executionId}\u001f${code}`;
    if (seenReceipt.has(key)) continue;
    seenReceipt.add(key);
    bump(current.receiptReasonCodes, code);
    if (code === terminalReasonCodes[actionId]) {
      current.terminalReceipts += 1;
      bump(current.terminalReasonCodes, code);
    } else {
      current.progressReceipts += 1;
    }
  }

  // A receipt the audit calls "progress" may still be an execution's END, and that is how three
  // authoritative failures (target_out_of_reach) disappeared from a real run's audit. Per-execution
  // outcomes are therefore derived separately, from the same facts, and folded back in below.
  const executionOutcomes = summarizeExecutionOutcomes({
    facts,
    actionOfRequest,
    terminalReasonCodes,
  });

  const reachedTerminal = (entry) => entry.terminalReceipts > 0;
  const sawFailure = (entry) => Object.keys(entry.rejections).length > 0;
  const attempted = [...byAction.values()]
    .map((entry) => {
      const outcomes = executionOutcomes.get(entry.actionId) ?? {
        executions: { succeeded: 0, failed: 0, inFlight: 0 },
        failedTerminalReasonCodes: {},
      };
      const failed = outcomes.executions.failed;
      return Object.freeze({
        ...entry,
        admissionStates: Object.freeze({ ...entry.admissionStates }),
        rejections: Object.freeze({ ...entry.rejections }),
        terminalReasonCodes: Object.freeze({ ...entry.terminalReasonCodes }),
        receiptReasonCodes: Object.freeze({ ...entry.receiptReasonCodes }),
        executionOutcomes: Object.freeze({
          ...outcomes.executions,
        }),
        failedTerminalReasonCodes: Object.freeze({ ...outcomes.failedTerminalReasonCodes }),
        // `succeeded` now means EVERY execution of this action finished on its registered terminal;
        // one success next to a failure is `partial`, and failures are never folded into success.
        verdict:
          reachedTerminal(entry) && failed === 0
            ? "succeeded"
            : reachedTerminal(entry)
              ? "partial"
              : failed > 0
                ? "failed"
                : sawFailure(entry)
                  ? "blocked"
                  : "unresolved",
      });
    })
    .sort((left, right) => right.dispatches - left.dispatches || left.actionId.localeCompare(right.actionId));
  const advertised = Array.isArray(visibleActionIds) ? visibleActionIds.filter((id) => typeof id === "string") : [];
  return Object.freeze({
    schema: "gamebuddy_stardew_play_session_capability_audit/v1",
    sessionTurnCount: (sessionTurns ?? []).length,
    attempts: Object.freeze(attempted),
    attemptedCount: attempted.length,
    succeededCount: attempted.filter((entry) => entry.verdict === "succeeded").length,
    // "The system blocked it" is a claim that needs evidence behind it: an action
    // is only reported as a system stall when the trace shows a refusal or an execution
    // that ended on a non-success terminal, and as `unresolved` when nothing terminal was observed at
    // all. An audit that over-claims is worse than one that admits a gap.
    blockedBySystem: Object.freeze(
      attempted.filter((entry) => entry.verdict === "blocked" || entry.verdict === "failed"),
    ),
    // Actions that succeeded at least once AND failed at least once. Their failures are the
    // interesting ones (a retry that never worked), so they must not hide behind the success.
    partialFailures: Object.freeze(
      attempted
        .filter((entry) => entry.verdict === "partial")
        .map((entry) =>
          Object.freeze({ actionId: entry.actionId, failedTerminalReasonCodes: entry.failedTerminalReasonCodes }),
        ),
    ),
    unresolved: Object.freeze(
      attempted.filter((entry) => entry.verdict === "unresolved").map((entry) => entry.actionId),
    ),
    notAttempted: Object.freeze(advertised.filter((actionId) => !byAction.has(actionId)).sort()),
    advertisedCount: advertised.length,
    // Proof that the axis above was actually sampled while the session ran.
    advertisedSampleCount,
    advertisedSampleMaxSize,
    advertisedAxisUsable: advertisedSampleCount > 0 && advertised.length > 0,
  });
}
