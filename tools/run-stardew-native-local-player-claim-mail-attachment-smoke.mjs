// claim_mail_attachment live contract: production native client, bounded scope,
// revision-bound requests, exact receipt identity, terminal wait, and owned teardown come
// from the shared harness. Action-specific logic (mailbox discovery, the claim
// postcondition, the attachment delivery, the negative case) stays in this runner.
//
// The receipt is not the proof. `GameLocation.mailbox()` is `void`, so the claim is read
// from the WORLD after the terminal: the mailbox's own published pending count drops by
// one, the letter's `%item` attachment reaches the pack, and the target identity -- which
// binds the pending count and the head letter -- moves with the state it names.

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

const ACTION = "claim_mail_attachment";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/** Claim one pending letter and prove the claim plus its attachment delivery. */
export async function runClaimMailAttachmentSmoke(
  client,
  receipts,
  _config,
  { terminalTimeoutMs = 5_000 } = {},
) {
  const trace = [];
  try {
    const snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const mailbox = chooseMailboxWithPending(snapshot);

    const requestId = `native_local_claim_mail_attachment_${Date.now()}`;
    const submitted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { x: mailbox.x, y: mailbox.y, expectedTargetId: mailbox.targetId },
      snapshot,
      timeoutMs: 30_000,
    });
    trace.push({
      step: "claim_letter",
      action: ACTION,
      mailbox: `${mailbox.x},${mailbox.y}`,
      pendingBefore: mailbox.pendingCount,
      receipt: summarizeReceipt(submitted),
    });

    // Either shape is legal: native work that resolves synchronously answers with an
    // immediate terminal instead of `accepted`. The terminal is what this contract asserts.
    const terminal = await waitForTerminal(receipts, submitted, terminalTimeoutMs);
    if (terminal.requestId !== requestId || terminal.executionId !== submitted.executionId)
      throw new Error(`claim_mail_attachment_terminal_identity_mismatch:${terminal.requestId}:${terminal.executionId}`);
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "mail_claimed") {
      // The action's own "the seam ran but the claim was not observed" terminal is named
      // here, so a live failure says which world fact was missing rather than only that
      // the receipt was not green.
      if (terminal.reasonCode === "mail_claim_not_observed")
        throw new Error(`claim_mail_attachment_not_observed:${summarizeEvidence(terminal.evidence)}`);
      throw new Error(
        `claim_mail_attachment_failed:${terminal.state}/${terminal.reasonCode};${summarizeEvidence(terminal.evidence)}`,
      );
    }

    const evidence = parseEvidence(terminal.evidence);
    assertEvidence(evidence, "target", mailbox.targetId);
    assertEvidence(evidence, "pending_before", String(mailbox.pendingCount));
    // The claim's own world write: the head letter left the queue and was recorded.
    assertEvidence(evidence, "mail_removed", "true");
    assertEvidence(evidence, "mail_recorded", "true");
    if (Number(evidence.pending_after) !== Number(evidence.pending_before) - 1)
      throw new Error(
        `claim_mail_attachment_queue_unchanged:before=${evidence.pending_before};after=${evidence.pending_after}`,
      );
    // The letter the seam opened must be finished the way its own exit path does, or the
    // `%item` attachment is silently discarded.
    if (evidence.letter_opened !== "true" || evidence.letter_closed !== "true")
      throw new Error(
        `claim_mail_attachment_letter_not_settled:opened=${evidence.letter_opened};closed=${evidence.letter_closed}`,
      );
    if (evidence.mail_has_attachment === "true") {
      const overflow = evidence.collection_overflow_pending === "true";
      if (!overflow && !(Number(evidence.inventory_units_after) > Number(evidence.inventory_units_before)))
        throw new Error(
          `claim_mail_attachment_attachment_not_delivered:units_before=${evidence.inventory_units_before};units_after=${evidence.inventory_units_after};mail_id=${evidence.mail_id}`,
        );
    }

    // The world change, re-read after the terminal: the same mailbox now publishes the
    // consumed count, and the identity moved with the state it names.
    const after = await observeFresh(client);
    if (after.revision < terminal.revision)
      throw new Error(`claim_mail_attachment_stale_reread:${after.revision}:${terminal.revision}`);
    const claimed = mailboxAt(after, mailbox.x, mailbox.y);
    if (claimed == null)
      throw new Error(`claim_mail_attachment_mailbox_gone:tile=${mailbox.x},${mailbox.y};mailboxTargets=${JSON.stringify(after.mailboxTargets ?? [])}`);
    if (claimed.pendingCount !== mailbox.pendingCount - 1)
      throw new Error(
        `claim_mail_attachment_world_unchanged:tile=${mailbox.x},${mailbox.y};before=${mailbox.pendingCount};after=${claimed.pendingCount}`,
      );
    if (claimed.targetId === mailbox.targetId)
      throw new Error(`claim_mail_attachment_world_identity_stale:${claimed.targetId}`);

    // Negative case. The stale id named the letter that has now been claimed, so the same
    // request must be REFUSED and nothing may change: a second `mail_claimed`, or a silent
    // claim of the NEXT letter, fails the run rather than passing on a green receipt.
    const negativeRequestId = `native_local_claim_mail_attachment_stale_${Date.now()}`;
    const negativeSubmitted = await executeFresh(client, {
      requestId: negativeRequestId,
      idempotencyKey: `${negativeRequestId}_idem`,
      action: ACTION,
      args: { x: mailbox.x, y: mailbox.y, expectedTargetId: mailbox.targetId },
      snapshot: after,
      timeoutMs: 30_000,
    });
    trace.push({
      step: "claim_stale_letter",
      action: ACTION,
      mailbox: `${mailbox.x},${mailbox.y}`,
      receipt: summarizeReceipt(negativeSubmitted),
    });
    const negativeTerminal = await waitForTerminal(receipts, negativeSubmitted, terminalTimeoutMs);
    if (negativeTerminal.state !== "rejected")
      throw new Error(
        `claim_mail_attachment_stale_not_refused:${negativeTerminal.state}/${negativeTerminal.reasonCode}`,
      );
    const REFUSALS = ["mail_target_changed", "mailbox_empty"];
    if (!REFUSALS.includes(negativeTerminal.reasonCode))
      throw new Error(`claim_mail_attachment_stale_unexpected_refusal:${negativeTerminal.reasonCode}`);

    const unchanged = await observeFresh(client);
    const stillThere = mailboxAt(unchanged, mailbox.x, mailbox.y);
    if (stillThere == null)
      throw new Error(`claim_mail_attachment_stale_mailbox_gone:tile=${mailbox.x},${mailbox.y}`);
    if (stillThere.pendingCount !== claimed.pendingCount)
      throw new Error(
        `claim_mail_attachment_stale_moved_world:before=${claimed.pendingCount};after=${stillThere.pendingCount}`,
      );

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "mail_claimed",
      mailbox: { x: mailbox.x, y: mailbox.y, targetId: mailbox.targetId },
      pending: { before: mailbox.pendingCount, after: stillThere.pendingCount },
      targetAfter: stillThere.targetId,
      evidence,
      negative: { reasonCode: negativeTerminal.reasonCode, pendingCount: stillThere.pendingCount },
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

/**
 * The mailbox the fixture armed, taken from the Mod's own discovery projection. This
 * runner never picks a mailbox tile: the Mod finds it through the location's own map layer
 * and re-resolves the identity on the game thread.
 */
function chooseMailboxWithPending(snapshot) {
  const targets = snapshot.mailboxTargets;
  if (targets == null || !Array.isArray(targets) || targets.length === 0)
    throw new Error(`claim_mail_attachment_no_mailbox:location=${snapshot.location}`);
  const pending = targets.filter(
    (entry) =>
      typeof entry?.targetId === "string" &&
      entry.targetId.length > 0 &&
      Number.isInteger(entry.x) &&
      Number.isInteger(entry.y) &&
      Number.isInteger(entry.pendingCount) &&
      entry.pendingCount >= 1,
  );
  if (pending.length === 0)
    throw new Error(
      `claim_mail_attachment_declared_given_absent:mailboxTargets=${JSON.stringify(targets)}`,
    );
  return pending[0];
}

/** The named tile's own mailbox projection, read from a fresh observation. */
function mailboxAt(snapshot, x, y) {
  const targets = snapshot.mailboxTargets;
  if (targets == null || !Array.isArray(targets)) return null;
  return targets.find((entry) => entry?.x === x && entry?.y === y) ?? null;
}

function assertEvidence(evidence, key, expected) {
  if (evidence[key] !== expected)
    throw new Error(`claim_mail_attachment_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
}

function summarizeEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  return detail.length > 0 ? detail : "no_evidence";
}

function parseEvidence(evidence) {
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

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runClaimMailAttachmentSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
