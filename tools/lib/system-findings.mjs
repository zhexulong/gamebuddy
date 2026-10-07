/**
 * System-level diagnostics for live agent runs.
 *
 * A live run is evidence about the SYSTEM (its observation design, action
 * contracts, verifier, orchestration), not only about the model. This module
 * turns the raw per-action trace into a small set of "system findings": each
 * finding names a component, a category, a count, and a recommendation — so a
 * run yields a system health report instead of just pass/blocked.
 *
 * There is no score here and none should be added: the findings are facts to
 * read and act on. To judge whether a system change helped, compare two runs
 * with tools/compare-live-run-findings.mjs.
 *
 * Game-agnostic: it knows nothing about Stardew or any specific action; the
 * reason-to-component table is the only game-tuned extension point.
 */

/** Maps a rejection reasonCode to the system component most likely at fault. */
const REASON_COMPONENT = Object.freeze({
  // Observation layer: the snapshot did not expose enough to pick a valid target.
  soil_not_diggable: "observation",
  no_native_path: "observation",
  target_out_of_reach: "observation",
  target_out_of_range: "observation",
  warp_out_of_range: "observation",
  target_mismatch: "observation",
  // Action contract layer: the request shape/fields did not satisfy the contract.
  invalid_deadline: "contract",
  invalid_argument: "contract",
  unknown_action: "contract",
  unsupported_argument: "contract",
  // Native execution state: the game world was not in a state that allows acting.
  player_not_actionable: "native_state",
  player_cannot_move: "native_state",
  player_menu_open: "native_state",
  world_not_ready: "native_state",
  // Orchestration: concurrent/duplicate/lifecycle ownership.
  body_owned: "orchestration",
  duplicate_request: "orchestration",
  lifecycle_invalidated: "orchestration",
  // Delivery/handoff: the Mod never ran the action, or its receipt could not be
  // reconciled with what the Host already admitted. These are *not* native-state
  // or contract failures and must stay visible as their own component.
  stale_snapshot: "delivery",
  execution_receipt_replay_rejected: "delivery",
  integration_not_ready: "delivery",
  expired_deadline: "delivery",
});

/**
 * Reasons whose component depends on the EVIDENCE the refusal carried, not on the code alone.
 *
 * Measured this time, not inferred: `move_to_tile(3,9 -> 4,8)` was refused as `no_native_path`, and the
 * envelope blamed a budget (`route_exists=true; component_tiles=2404; probe_says_reachable=true;
 * path_search=native_budget_exhausted; budget=40000`). Both halves of that story were wrong, and a live
 * measurement settled it — with the actor really standing at 3,9, the exact-goal search returned null at
 * 10000, 40000 AND 400000 expansions, while the CARDINAL neighbour 3,10 resolved with a 2-node path at every
 * limit. The native planner expands cardinally only (`PathFindController.cs:45-51`); the destination's
 * cardinal approaches were both blocked, so no route existed for the planner and the limit was never the
 * variable. The refusal is the world's geometry (`native_state`), and a planner that returned null while its
 * own cardinal component DOES contain the target is the case worth an observation review.
 */
function componentOf(reasonCode, evidence) {
  if (typeof reasonCode !== "string" || reasonCode.length === 0) return "unclassified";
  const head = reasonCode.split(":", 1)[0];
  const defaultComponent = REASON_COMPONENT[head] ?? "unclassified";
  if (head === "no_native_path" && typeof evidence === "string") {
    if (/path_search=planner_null_with_cardinal_route/.test(evidence)) return "observation";
    if (/path_search=no_cardinal_route/.test(evidence)) return "native_state";
    if (/path_search=undecided/.test(evidence)) return "observation";
  }
  return defaultComponent;
}

/**
 * @param {readonly {action?: string, args?: unknown, state?: string, reasonCode?: string}[]} actionTrace every
dispatch the run issued, including refusals that threw instead of returning a receipt
 * @returns {Readonly<{findings: readonly any[], summaries: Readonly<Record<string, number>>, rejectedCount: number, acceptedCount: number}>}
 */
export function summarizeSystemFindings(actionTrace, executionFailures = {}) {
  // Evidence per reason code, so a finding can attribute by what the refusal SAID rather than by its name
  // alone.
  const evidenceByCode = {};
  for (const entry of actionTrace) {
    const code = entry?.reasonCode;
    if (typeof code !== "string" || typeof entry?.evidence !== "string") continue;
    (evidenceByCode[code] ??= []).push(entry.evidence);
  }
  const rejected = actionTrace.filter((entry) => entry?.state === "rejected");
  const accepted = actionTrace.filter((entry) => entry?.state === "accepted" || entry?.state === "succeeded");

  // Reason coverage: which rejection reasons appeared, and how dominant.
  const reasonCounts = {};
  for (const entry of rejected) {
    const code = entry?.reasonCode ?? "unknown";
    reasonCounts[code] = (reasonCounts[code] ?? 0) + 1;
  }
  const reasonSummaries = Object.fromEntries(
    Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]),
  );

  const findings = [];
  const totalRejected = rejected.length;
  const total = actionTrace.length;

  // Finding 1: blind-guess enumeration — the same action rejected many times
  // with DIFFERENT coordinates/args. This is the classic observation-gap
  // signature (the agent cannot see where it should aim).
  const byAction = {};
  for (const entry of rejected) {
    const action = entry?.action ?? "?";
    (byAction[action] ??= []).push(entry);
  }
  for (const [action, entries] of Object.entries(byAction)) {
    if (entries.length < 3) continue;
    const signatures = new Set(
      entries.map((entry) => JSON.stringify(entry?.args ?? null)),
    );
    const codes = new Set(entries.map((entry) => entry?.reasonCode));
    if (signatures.size >= 3 && (codes.size === 1 || codes.size === 2)) {
      findings.push({
        id: "blind_guess_enumeration",
        component: "observation",
        severity: codes.size === 1 ? "high" : "medium",
        action,
        count: entries.length,
        detail: `same action rejected ${entries.length}x with ${signatures.size} different args under ${codes.size} reason code(s)`,
        // The mechanism below is a HYPOTHESIS, not a conclusion: a real ladder run
        // falsified the "the snapshot lacks targets" reading (8 of 10 refusals were
        // within 2.24 tiles of the actor and the refusal envelope reported
        // target_enclosed=false; the named tile was simply not a standable
        // position). Findings must therefore state what would falsify them rather
        // than assert the observation layer is at fault.
        mechanismHypothesis:
          "the observation layer may not expose a standable approach tile for the named target, or the target set may be too sparse to aim at",
        falsificationCheck:
          "falsified if refusals cluster within a few tiles of the actor while the refusal envelope reports the target is reachable/not enclosed (then the seam is the refusal cause, not discovery)",
        recommendation: "compare refusal distances with the refusal envelope before attributing this to discovery",
        sampleCodes: [...codes],
      });
    }
  }

  // Finding 2: exact retry of an identical rejected request (no new info).
  // Aggregated PER ACTION: the earlier per-(action,args,reason) emission produced
  // findings that were byte-identical for one action while carrying different
  // counts, which made run-to-run comparison meaningless.
  const identicalRetries = {};
  for (const entry of rejected) {
    const action = entry?.action ?? "?";
    const bucket = (identicalRetries[action] ??= { total: 0, keys: new Set(), codes: new Set() });
    bucket.keys.add(JSON.stringify(entry?.args ?? null));
    bucket.codes.add(entry?.reasonCode ?? "?");
  }
  for (const entry of rejected) {
    const action = entry?.action ?? "?";
    const key = `${JSON.stringify(entry?.args ?? null)}|${entry?.reasonCode ?? "?"}`;
    const bucket = identicalRetries[action];
    (bucket.counts ??= new Map()).set(key, (bucket.counts?.get(key) ?? 0) + 1);
  }
  for (const [action, bucket] of Object.entries(identicalRetries)) {
    const repeated = [...(bucket.counts ?? new Map()).entries()].filter(([, count]) => count >= 2);
    if (repeated.length === 0) continue;
    const count = repeated.reduce((total, [, value]) => total + value, 0);
    findings.push({
      id: "identical_retry",
      component: "orchestration",
      severity: "medium",
      action,
      count,
      detail: `${repeated.length} identical rejected request(s) re-issued (${[...bucket.codes].join(",")}) — the agent saw no new information between attempts`,
      recommendation: "rejected requests should carry actionable next-step hints so a retry is never information-free",
    });
  }

  // Finding 2b: an action dispatched repeatedly whose executions END in a failure terminal. The
  // dispatch itself says `accepted`, so a refusal-only reading sees nothing; meanwhile the caller
  // retried a request that had already failed authoritatively. Measured: three harvest executions ended
  // in `target_out_of_reach` (two of them minutes apart) while the run's findings mentioned no retry at
  // all.
  for (const [action, failures] of Object.entries(executionFailures ?? {})) {
    const codes = Object.entries(failures?.failedTerminalReasonCodes ?? {});
    if (codes.length === 0) continue;
    const count = codes.reduce((total, [, value]) => total + value, 0);
    const component = componentOf(codes[0][0], evidenceByCode[codes[0][0]]?.[0]);
    findings.push({
      id: "accepted_then_failed",
      component,
      severity: count >= 2 ? "high" : "medium",
      action,
      count,
      detail: `${count} execution(s) of ${action} were admitted and then ended in ${codes.map(([code, value]) => `${code} x${value}`).join(", ")}`,
      mechanismHypothesis:
        "the refusal/terminal envelope may not carry an actionable next step, so the caller has no gradient to change its approach",
      falsificationCheck:
        "falsified if the same action later succeeds from the same observation without any new information",
      recommendation:
        "treat an admitted-then-failed execution as a first-class outcome: report it, and check whether the terminal envelope names a reachable alternative",
      sampleCodes: codes.map(([code]) => code),
    });
  }

  // Finding 3: dominant rejection reason (>=50% of all rejections, >=3 total).
  for (const [code, count] of Object.entries(reasonSummaries)) {
    if (count >= 3 && totalRejected >= 3 && count / totalRejected >= 0.5) {
      findings.push({
        id: "dominant_rejection",
        component: componentOf(code, evidenceByCode[code]?.[0]),
        severity: "high",
        // `action` is an action id everywhere else in this shape; a reason code
        // here was a type lie that a reader (and any comparison tool) would take
        // for an action name.
        action: null,
        reasonCode: code,
        count,
        detail: `${code} is ${Math.round((count / totalRejected) * 100)}% of ${totalRejected} rejections`,
        recommendation: `a single reason dominating the rejection stream usually means a systemic precondition — audit ${componentOf(code, evidenceByCode[code]?.[0])} layer`,
      });
    }
  }

  // Finding 4: overall rejection rate for context (>=50% is a strong signal).
  if (total >= 4 && totalRejected / total >= 0.5) {
    findings.push({
      id: "high_rejection_rate",
      component: "unclassified",
      severity: "medium",
      action: null,
      count: totalRejected,
      detail: `${Math.round((totalRejected / total) * 100)}% of ${total} actions were rejected`,
      recommendation: "enough rejections to warrant a system-side audit before more live attempts",
    });
  }

  // Finding 5: delivery-layer rejections are always reported, however few. A
  // rejection attributed to delivery means the Mod never ran the action, or its
  // admitted receipt could not be reconciled with what the Host already has —
  // either way the caller is told "not created" while the world may have moved.
  // Counting thresholds must never hide this: one such rejection in a run is a
  // system defect, and the live trace that motivated this module showed exactly
  // this being reported as a clean run.
  const deliveryRejections = rejected.filter((entry) => componentOf(entry?.reasonCode ?? "", entry?.evidence) === "delivery");
  if (deliveryRejections.length > 0) {
    const codes = [...new Set(deliveryRejections.map((entry) => entry?.reasonCode ?? "unknown"))];
    findings.push({
      id: "delivery_rejection",
      component: "delivery",
      severity: "high",
      action: null,
      count: deliveryRejections.length,
      detail: `${deliveryRejections.length} request(s) were rejected at the delivery boundary (${codes.join(", ")}) — the action may have run natively while the caller was told it was not created`,
      recommendation: "distinguish a genuine pre-admission rejection from a lost/duplicated receipt before reporting failure",
      sampleCodes: codes,
    });
  }

  // Finding 6: any rejected request is reported, however few. Thresholds are for
  // ranking severity, never for hiding a rejection: a live run that reported
  // "findings: []" while a third of its actions were rejected is exactly the
  // false-clean signal this module exists to prevent. Each distinct reason code
  // stays individually visible so the reader sees what actually happened.
  if (totalRejected > 0 && findings.every((finding) => finding.id !== "rejection_observed")) {
    const componentCounts = {};
    for (const [code, count] of Object.entries(reasonSummaries)) {
      const component = componentOf(code);
      componentCounts[component] = (componentCounts[component] ?? 0) + count;
    }
    findings.push({
      id: "rejection_observed",
      // The summary inherits the dominant component so it is never a useless
      // "unclassified"; the per-code detail below still names every reason.
      component: Object.entries(componentCounts).sort((a, b) => b[1] - a[1])[0][0],
      severity: "medium",
      action: null,
      count: totalRejected,
      detail: `${totalRejected} of ${total} actions were rejected (${Object.entries(reasonSummaries).map(([c, n]) => `${c} x${n}`).join(", ")}) across ${Object.keys(componentCounts).join(", ")}`,
      recommendation: "read each reason code above; a rejection is information, not noise",
      sampleCodes: Object.keys(reasonSummaries),
    });
  }

  return Object.freeze({
    findings: findings.sort((a, b) => (b.severity === "high" ? 1 : 0) - (a.severity === "high" ? 1 : 0)),
    reasonSummaries,
    rejectedCount: totalRejected,
    acceptedCount: accepted.length,
    totalCount: total,
  });
}