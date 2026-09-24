/**
 * System-level RL signal aggregation for live agent runs.
 *
 * A live run is feedback for the SYSTEM (its observation design, action
 * contracts, verifier, orchestration), not only for the model. This module
 * turns the raw per-action trace into a small set of "system findings": each
 * finding names a component, a category, a count, and a recommendation — so a
 * run yields a system health report instead of just pass/blocked.
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
});

function componentOf(reasonCode) {
  return REASON_COMPONENT[reasonCode] ?? "unclassified";
}

/**
 * @param {readonly {action?: string, args?: unknown, state?: string, reasonCode?: string}[]} actionTrace
 * @param {readonly {reasonCode?: string}[]} receipts receipts with reasonCode
 * @returns {Readonly<{findings: readonly any[], summaries: Readonly<Record<string, number>>, rejectedCount: number, acceptedCount: number}>}
 */
export function summarizeSystemFindings(actionTrace, receipts = []) {
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
        detail: `same action rejected ${entries.length}x with ${signatures.size} different args under ${codes.size} reason code(s) — the snapshot likely lacks enough targets`,
        recommendation: "check discoverable targets for this action (radius/fields) before blaming the model",
        sampleCodes: [...codes],
      });
    }
  }

  // Finding 2: exact retry of an identical rejected request (no new info).
  const identicalRetries = {};
  for (const entry of rejected) {
    const key = `${entry?.action ?? "?"}|${JSON.stringify(entry?.args ?? null)}|${entry?.reasonCode ?? "?"}`;
    identicalRetries[key] = (identicalRetries[key] ?? 0) + 1;
  }
  for (const [key, count] of Object.entries(identicalRetries)) {
    if (count < 2) continue;
    const [action] = key.split("|");
    findings.push({
      id: "identical_retry",
      component: "orchestration",
      severity: "medium",
      action,
      count,
      detail: "the exact same rejected request was re-issued — the agent saw no new information between attempts",
      recommendation: "rejected requests should carry actionable next-step hints so a retry is never information-free",
    });
  }

  // Finding 3: dominant rejection reason (>=50% of all rejections, >=3 total).
  for (const [code, count] of Object.entries(reasonSummaries)) {
    if (count >= 3 && totalRejected >= 3 && count / totalRejected >= 0.5) {
      findings.push({
        id: "dominant_rejection",
        component: componentOf(code),
        severity: "high",
        action: code,
        count,
        detail: `${code} is ${Math.round((count / totalRejected) * 100)}% of ${totalRejected} rejections`,
        recommendation: `a single reason dominating the rejection stream usually means a systemic precondition — audit ${componentOf(code)} layer`,
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

  return Object.freeze({
    findings: findings.sort((a, b) => (b.severity === "high" ? 1 : 0) - (a.severity === "high" ? 1 : 0)),
    reasonSummaries,
    rejectedCount: totalRejected,
    acceptedCount: accepted.length,
    totalCount: total,
  });
}