/**
 * The run's delivery account, reconciled against the pieces the run actually presented.
 *
 * <p>
 * The Host prints one `NATIVE_COMPANION_TURN_DELIVERY` line per turn that had anything to deliver
 * (`host/src/companion-loop.ts`): the assistant text PARTS that turn produced, how many reached the player, every part
 * withheld with its reason, and the PIECES the presentation port committed. The runner counts the pieces itself, in
 * `presentation.pieceCount`, from the port that committed them.
 * </p>
 * <p>
 * MEASURED 2026-11-09 (round41 `multiday_routine`): `presentation.pieceCount` 59, `AGENT_PRESENTATION_PIECE` 59 lines,
 * `sessionTurns[].spokenLines` 59, and thirteen delivery records accounting `textParts` 46 / `presented` 46 /
 * `unaccounted` 0. Both numbers were right, and nothing in the bundle explained the difference: the 59 pieces were 11
 * reaction sounds (one per paced turn), 46 paragraphs, and 2 extra pieces from a paragraph the length budget split, so
 * 13 pieces were not assistant text parts. A reader comparing the two could only report thirteen pieces - a whole
 * turn's worth - with no record at all, which is the failure this account exists to make impossible: every committed
 * piece is either a presented paragraph, a piece the surface emitted ahead of one, or a named remainder.
 * </p>
 */

/** One parsed `NATIVE_COMPANION_TURN_DELIVERY` record, as the Host published it. */
export const TURN_DELIVERY_PREFIX = "NATIVE_COMPANION_TURN_DELIVERY ";

/**
 * The Host's own stall line (`host/src/host-service.ts` `#publishStallFact`): an execution that stopped making
 * progress.
 *
 * <p>
 * It travels stderr beside the delivery line, which is why it reached no bundle for as long as nothing parsed it:
 * MEASURED 2026-11-09 (round44), ten stall facts existed in the Host's own log and `presentation` in the run's
 * `result.json` carried no trace of any of them. A fact that describes a stuck body is not a log detail - it is the
 * answer to "why did nothing happen for half an hour" - so the bundle keeps it.
 * </p>
 */
export const EXECUTION_STALL_PREFIX = "EXECUTION_STALL ";

/**
 * Stall facts one bundle keeps. The parser owns the cap AND the count of what it dropped.
 *
 * A stall re-arms at 120 s, 480 s, 840 s, ... (`EXECUTION_STALL_REARM_MULTIPLE`), so a long refusal is a handful of
 * facts, not one per bound; the cap is the bound on a pathological run, and `omitted` is what it hid.
 */
export const MAX_BUNDLE_STALL_FACTS = 20;

/**
 * The one line a reader and a log grep can act on when the three measured part populations do not agree.
 *
 * It is a fixed shape rather than prose because it is the run's delivery VERDICT: every number names the population it
 * counted, so the difference cannot be mistaken for a rounding of one of them. `missing` is the residual and is
 * REPORTED here - it is never what the reconciliation is computed from.
 */
export function describeDeliveryMismatch(parts) {
  return `delivery_mismatch:produced=${String(parts.produced)};presented=${String(parts.presented)};suppressed=${String(sumSuppressed(parts.suppressed))};missing=${String(parts.missing)}`;
}

/**
 * Every delivery record in a run's own log text.
 *
 * A line that does not parse is COUNTED rather than dropped: an account this module could not read is not an account
 * that agreed, and the caller has to be able to see that difference.
 */
export function readTurnDeliveryRecords(logText) {
  const records = [];
  let unparsable = 0;
  for (const line of String(logText ?? "").split("\n")) {
    if (!line.startsWith(TURN_DELIVERY_PREFIX)) continue;
    try {
      const record = JSON.parse(line.slice(TURN_DELIVERY_PREFIX.length));
      if (record === null || typeof record !== "object" || Array.isArray(record)) throw new Error("not_an_object");
      records.push(record);
    } catch {
      unparsable += 1;
    }
  }
  return Object.freeze({ records: Object.freeze(records), unparsable });
}

/**
 * What the run's log says about executions that stopped making progress, in the shape a bundle publishes.
 *
 * <p>
 * `facts` are the stall facts in arrival order; `omitted` counts the ones the cap hid, so a healthy run states `0`
 * rather than leaving the field out. `watched` and `evicted` are the pump's own reading carried on the LAST fact (how many
 * executions were timed, and how many the record's bound dropped while still running) - both `null` when nothing was
 * published, with `notMeasured` naming why. A zero there would be a claim that nothing was stuck, which is the one
 * answer this must never invent.
 * </p>
 */
export function readStallWatch(logText) {
  const facts = [];
  let published = 0;
  let unreadable = 0;
  for (const line of String(logText ?? "").split("\n")) {
    if (!line.startsWith(EXECUTION_STALL_PREFIX)) continue;
    let payload;
    try {
      payload = JSON.parse(line.slice(EXECUTION_STALL_PREFIX.length));
    } catch {
      unreadable += 1;
      continue;
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      unreadable += 1;
      continue;
    }
    published += 1;
    if (facts.length < MAX_BUNDLE_STALL_FACTS) facts.push(Object.freeze(boundedStallFact(payload)));
  }
  const last = facts.at(-1);
  return Object.freeze({
    facts: Object.freeze(facts),
    omitted: published - facts.length,
    watched: last === undefined ? null : last.watched,
    evicted: last === undefined ? null : last.evicted,
    notMeasured:
      published > 0 ? null : unreadable > 0 ? "execution_stall_fact_unreadable" : "host_published_no_stall_fact",
    ...(unreadable === 0 ? {} : { unreadable }),
  });
}

/** The fields one stall fact publishes: identity, how long it has been silent, and what would release it. */
function boundedStallFact(payload) {
  return {
    atMs: numberOrNull(payload.atMs),
    executionId: typeof payload.executionId === "string" ? payload.executionId : null,
    actionId: typeof payload.actionId === "string" ? payload.actionId : null,
    elapsedMs: numberOrNull(payload.elapsedMs),
    lastFactKind: typeof payload.lastFactKind === "string" ? payload.lastFactKind : null,
    stallFactsSoFar: numberOrNull(payload.stallFactsSoFar),
    owner: typeof payload.owner === "string" ? payload.owner : null,
    endsOwnershipWith: typeof payload.endsOwnershipWith === "string" ? payload.endsOwnershipWith : null,
    ownershipAbsentReason: typeof payload.ownershipAbsentReason === "string" ? payload.ownershipAbsentReason : null,
    watched: numberOrNull(payload.watched),
    evicted: numberOrNull(payload.evicted),
  };
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The run-level account: both populations, each a partition, plus the one numbers the reader compares.
 *
 * `parts` is the assistant text the run produced, and it is reconciled from THREE populations that are each summed
 * from where they were measured: `produced` (Pi's own message stream, which `companion-loop.ts` counts),
 * `presented` (the projection's report of the parts it delivered) and `suppressed` (its report of the parts it
 * withheld, by reason). `missing` is the residual `produced - presented - suppressed` and it is REPORTED, never used
 * to balance the books: the identity that has to hold is `presented + suppressed === produced`, and a run whose three
 * numbers do not satisfy it is BLOCKED with `delivery_mismatch:...`.
 *
 * Why this is not pedantry: the previous version summed each turn's residual and kept the total as `unaccounted`, so two
 * turns that erred in opposite directions cancelled to zero and the account agreed with itself. A residual derived from
 * a total cannot disagree with that total, and an identity whose last term is computed from the difference is not an
 * identity. The per-turn check is therefore part of the gate, not a convenience: two totals can agree while every turn
 * behind them is wrong in a different direction, and `mismatchedTurns` is how many did.
 *
 * `pieces` is what the presentation port committed, which is the population `presentation.pieceCount` counts - one
 * paragraph can be several pieces, and a paced surface emits pieces that are not text at all. `pieces.accounted` is the
 * sum of what the Host named PER TURN, so a turn that never printed its record cannot hide inside the total.
 */
export function summarizeDeliveryAccount({ records, piecesProduced, unparsable = 0 }) {
  const suppressed = {};
  let textParts = 0;
  let presented = 0;
  let textPieces = 0;
  let aheadPieces = 0;
  let mismatchedTurns = 0;
  for (const record of records ?? []) {
    const turnParts = Number(record.textParts) || 0;
    const turnPresented = Number(record.presented) || 0;
    const turnSuppressed = sumSuppressed(record.suppressed);
    if (turnParts - turnPresented - turnSuppressed !== 0) mismatchedTurns += 1;
    textParts += turnParts;
    presented += turnPresented;
    for (const [reason, count] of Object.entries(record.suppressed ?? {}))
      suppressed[reason] = (suppressed[reason] ?? 0) + (Number(count) || 0);
    textPieces += Number(record.pieces?.text) || 0;
    aheadPieces += Number(record.pieces?.ahead) || 0;
  }
  const produced = Number(piecesProduced) || 0;
  const accounted = textPieces + aheadPieces;
  const missingParts = textParts - presented - sumSuppressed(suppressed);
  // Three zeroes, told apart. Nothing was presented and no turn had anything to deliver: a real state, named, and not
  // the same answer as an account that failed to add up.
  const nothingPresented = produced === 0 && (records ?? []).length === 0;
  const piecesUnaccounted = produced - accounted;
  const blocked = nothingPresented
    ? null
    : unparsable > 0
      ? "delivery_account_unreadable"
      : (records ?? []).length === 0
        ? "delivery_account_absent"
        : missingParts !== 0 || mismatchedTurns > 0
          ? "delivery_account_parts_do_not_add_up"
          : piecesUnaccounted !== 0
            ? "delivery_account_unaccounted_pieces"
            : null;
  return Object.freeze({
    turns: (records ?? []).length,
    unreadableTurns: unparsable,
    nothingPresented,
    parts: Object.freeze({
      produced: textParts,
      presented,
      suppressed: Object.freeze(suppressed),
      missing: missingParts,
      mismatchedTurns,
    }),
    pieces: Object.freeze({
      produced,
      accounted,
      unaccounted: piecesUnaccounted,
      text: textPieces,
      ahead: aheadPieces,
    }),
    blocked,
  });
}

/** One line a reader (and every log grep) can act on: the two accounts, and the verdict.
 *
 * When the parts do not add up the line carries the two facts the reader needs to tell the shapes apart - how many TURNS
disagreed with their own numbers, and the run's `delivery_mismatch:produced=…;presented=…;suppressed=…;missing=…`. Both
 * are named where the account is printed, so the failure is in the log beside the account that produced it rather than
 * only in a verdict field somebody has to open the bundle to read.
 */
export function describeDeliveryAccount(account) {
  const { parts, pieces } = account;
  const verdict =
    account.blocked === null ? (account.nothingPresented ? "nothing presented" : "reconciled") : account.blocked;
  const mismatched = parts.mismatchedTurns > 0 ? ` · turns mismatched ${parts.mismatchedTurns}` : "";
  const mismatch = parts.missing === 0 && parts.mismatchedTurns === 0 ? "" : ` · ${describeDeliveryMismatch(parts)}`;
  return `pieces produced ${pieces.produced} · accounted ${pieces.accounted} · unaccounted ${pieces.unaccounted} · parts produced ${parts.produced} · presented ${parts.presented} · suppressed ${sumSuppressed(parts.suppressed)} · missing ${parts.missing}${mismatched} · turns ${account.turns} · ${verdict}${mismatch}`;
}

/** The rung clause: a run whose own commitment count disagrees with its account is not a passed run. */
export function deliveryAccountClause(account) {
  // An account that could not be read is not an account that agreed: a missing one blocks by name rather than throwing
  // inside the verdict or, worse, passing because there was nothing to compare.
  if (account === undefined || account === null)
    return Object.freeze({
      id: "delivery_account",
      passed: false,
      reasonCode: "delivery_account_absent",
    });
  return Object.freeze({
    id: "delivery_account",
    passed: account.blocked === null,
    reasonCode: account.blocked ?? "delivery_account_reconciled",
  });
}

/**
 * The same invariant, asked of a bundle that was already written.
 *
 * A bundle that predates the field is BLOCKED rather than passed: the question this gate asks ("do the pieces and the
 * account agree?") cannot be answered from it, and a check whose population is empty must not agree with itself.
 */
export function assessBundleDeliveryAccount(bundle) {
  const presentation = bundle?.presentation;
  if (presentation === undefined || presentation === null)
    return Object.freeze({ ok: false, code: "delivery_account_bundle_without_presentation" });
  const account = presentation.deliveryAccount;
  if (account === undefined || account === null) return Object.freeze({ ok: false, code: "delivery_account_absent" });
  const produced = Number(presentation.pieceCount);
  if (Number.isFinite(produced) && produced !== Number(account.pieces?.produced))
    return Object.freeze({
      ok: false,
      code: "delivery_account_pieces_produced_disagrees",
      detail: `presentation.pieceCount ${String(presentation.pieceCount)} · account ${String(account.pieces?.produced)}`,
    });
  const pieces = account.pieces ?? {};
  if (Number(pieces.accounted) + Number(pieces.unaccounted) !== Number(pieces.produced))
    return Object.freeze({
      ok: false,
      code: "delivery_account_sum_does_not_hold",
      detail: `produced ${String(pieces.produced)} · accounted ${String(pieces.accounted)} + unaccounted ${String(pieces.unaccounted)}`,
    });
  const parts = account.parts ?? {};
  if (Number(parts.presented) + sumSuppressed(parts.suppressed) !== Number(parts.produced))
    return Object.freeze({
      ok: false,
      code: "delivery_account_parts_do_not_add_up",
      detail: describeDeliveryMismatch({
        ...parts,
        missing: Number(parts.produced) - Number(parts.presented) - sumSuppressed(parts.suppressed),
      }),
    });
  if (typeof account.blocked === "string" && account.blocked.length > 0)
    return Object.freeze({
      ok: false,
      code: account.blocked,
      detail: describeDeliveryAccount(account),
    });
  return Object.freeze({ ok: true, code: "delivery_account_reconciled", detail: describeDeliveryAccount(account) });
}

function sumSuppressed(suppressed) {
  return Object.values(suppressed ?? {}).reduce((total, count) => total + (Number(count) || 0), 0);
}
