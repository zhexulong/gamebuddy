import assert from "node:assert/strict";
import test from "node:test";

import { runClaimMailAttachmentSmoke } from "./run-stardew-native-local-player-claim-mail-attachment-smoke.mjs";

const ACTION = "claim_mail_attachment";
const MAILBOX_TILE = { x: 68, y: 15 };
const MAIL_ID = "fixture_mail_with_attachment";

/**
 * The Mod's own identity rule: the target binds the location, the tile, the pending count
 * AND the head letter, so the id moves with the state it names.
 */
const mailboxTargetId = (pendingCount) => `mailbox_state_${pendingCount}`;

/**
 * The Mod's own discovery projection: one mailbox with one pending letter. The head letter
 * id is hashed INTO the opaque target and never published, so the projection carries the
 * count only.
 */
function snapshotWith({ revision, pendingCount = 1 }) {
  return {
    revision,
    location: "Farm",
    tile: { x: MAILBOX_TILE.x, y: MAILBOX_TILE.y + 1 },
    actionable: true,
    activeExecution: null,
    capabilities: ["cancel_active_execution", "inspect_self", ACTION],
    mailboxTargets: [
      {
        targetId: mailboxTargetId(pendingCount),
        location: "Farm",
        x: MAILBOX_TILE.x,
        y: MAILBOX_TILE.y,
        pendingCount,
      },
    ],
  };
}

function claimEvidence({
  pendingAfter = 0,
  unitsAfter = 3,
  letterClosed = true,
  hasAttachment = true,
  overflow = false,
} = {}) {
  return {
    detail:
      `target=${mailboxTargetId(1)};tile=${MAILBOX_TILE.x},${MAILBOX_TILE.y};location=Farm;mail_id=${MAIL_ID};` +
      `mail_content_known=true;mail_has_attachment=${hasAttachment};mail_attachment_commands=1;` +
      `mail_recorded_natively=true;pending_before=1;pending_after=${pendingAfter};mail_removed=true;mail_recorded=true;` +
      `letter_opened=true;letter_closed=${letterClosed};collection_overflow_pending=${overflow};` +
      `inventory_slots_before=2;inventory_slots_after=3;inventory_units_before=2;inventory_units_after=${unitsAfter}`,
  };
}

/**
 * A real client in shape: it claims only when the request named the mailbox state the world
 * actually holds, and moves the published pending count with it.
 */
function makeClient({ pendingCount = 1 } = {}) {
  const receipts = [];
  const client = {
    state: { snapshot: snapshotWith({ revision: 1, pendingCount }) },
    observe: async () => client.state.snapshot,
    execute: async (request) => {
      const live = client.state.snapshot.mailboxTargets[0] ?? null;
      const matches = live != null && live.targetId === request.args.expectedTargetId && live.pendingCount >= 1;
      const accepted = {
        requestId: request.requestId,
        executionId: matches ? "claim-mail-execution" : "claim-mail-refused",
        state: "accepted",
        reasonCode: "accepted",
        revision: client.state.snapshot.revision,
      };
      const terminal = matches
        ? {
            requestId: request.requestId,
            executionId: accepted.executionId,
            state: "succeeded",
            reasonCode: "mail_claimed",
            revision: client.state.snapshot.revision + 1,
            evidence: claimEvidence(),
          }
        : {
            requestId: request.requestId,
            executionId: accepted.executionId,
            state: "rejected",
            reasonCode: live == null || live.pendingCount === 0 ? "mailbox_empty" : "mail_target_changed",
            revision: client.state.snapshot.revision + 1,
            evidence: {
              detail: `tile=${MAILBOX_TILE.x},${MAILBOX_TILE.y};published=${request.args.expectedTargetId};live=${live?.targetId ?? "none"};pending=${live?.pendingCount ?? 0}`,
            },
          };
      if (matches) {
        client.state.snapshot = snapshotWith({ revision: terminal.revision, pendingCount: 0 });
      }
      receipts.push(terminal);
      return accepted;
    },
  };
  return { client, receipts };
}

const run = (options) => {
  const session = makeClient(options);
  return {
    ...session,
    result: () => runClaimMailAttachmentSmoke(session.client, session.receipts, {}, { terminalTimeoutMs: 1_000 }),
  };
};

test("claim_mail_attachment: the claim is asserted from the queue and the identity moves with it", async () => {
  const session = run();
  const result = await session.result();
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "mail_claimed");
  assert.equal(result.pending.before, 1);
  assert.equal(result.pending.after, 0);
  // The published identity names the pending state, so the target the run claimed is
  // replaced by the empty-mailbox target at the same tile.
  assert.notEqual(result.targetAfter, result.mailbox.targetId);
  assert.equal(result.negative.reasonCode, "mailbox_empty");
});

test("claim_mail_attachment: an attachment that never reached the pack fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const accepted = await original(request);
    const terminal = session.receipts.at(-1);
    if (terminal.state === "succeeded") terminal.evidence = claimEvidence({ unitsAfter: 2 });
    return accepted;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /claim_mail_attachment_attachment_not_delivered/);
});

test("claim_mail_attachment: a letter left unsettled fails the run", async () => {
  // The seam opens the letter it claimed; a receipt that never reports the letter closed
  // means the `%item` attachment was discarded, which is the difference this action exists
  // to catch.
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const accepted = await original(request);
    const terminal = session.receipts.at(-1);
    if (terminal.state === "succeeded") terminal.evidence = claimEvidence({ letterClosed: false });
    return accepted;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /claim_mail_attachment_letter_not_settled/);
});

test("claim_mail_attachment: a receipt that claims success while the queue still holds the letter fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const accepted = await original(request);
    session.client.state.snapshot = snapshotWith({ revision: session.client.state.snapshot.revision, pendingCount: 1 });
    return accepted;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /claim_mail_attachment_world_unchanged/);
});

test("claim_mail_attachment: the stale target is refused, and a refusal that claimed the NEXT letter fails the run", async () => {
  // Both halves of the negative case are asserted: the honest refusal, and a refusal that
  // nevertheless moved the queue -- which is exactly the silent second claim the identity
  // binding exists to prevent.
  const honest = run();
  const honestResult = await honest.result();
  assert.equal(honestResult.state, "passed");

  const moved = run();
  const original = moved.client.execute;
  moved.client.execute = async (request) => {
    const accepted = await original(request);
    const terminal = moved.receipts.at(-1);
    if (terminal.state === "rejected") {
      moved.client.state.snapshot = snapshotWith({ revision: terminal.revision, pendingCount: -1 });
    }
    return accepted;
  };
  const movedResult = await moved.result();
  assert.equal(movedResult.state, "blocked");
  assert.match(movedResult.reasonCode, /claim_mail_attachment_stale_moved_world/);
});

test("claim_mail_attachment: a forged success on the stale target fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const accepted = await original(request);
    const terminal = session.receipts.at(-1);
    if (terminal.state === "rejected") {
      terminal.state = "succeeded";
      terminal.reasonCode = "mail_claimed";
    }
    return accepted;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /claim_mail_attachment_stale_not_refused/);
});

test("claim_mail_attachment: an empty mailbox is not the declared Given", async () => {
  const session = run({ pendingCount: 0 });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /claim_mail_attachment_declared_given_absent/);
});

test("claim_mail_attachment: evidence that omits the observed queue move fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const accepted = await original(request);
    const terminal = session.receipts.at(-1);
    if (terminal.state === "succeeded")
      terminal.evidence = { detail: `target=${mailboxTargetId(1)};tile=${MAILBOX_TILE.x},${MAILBOX_TILE.y};pending_before=1` };
    return accepted;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /claim_mail_attachment_evidence_mail_removed/);
});
