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

/** How many of a turn's parts no layer named - the number the per-turn account claims is zero. */
function unaccountedParts(record) {
  const suppressed = record.suppressed ?? {};
  const named = Object.values(suppressed).reduce((total, count) => total + (Number(count) || 0), 0);
  return (Number(record.textParts) || 0) - (Number(record.presented) || 0) - named;
}

/**
 * The run-level account: both populations, each a partition, plus the one numbers the reader compares.
 *
 * `parts` is the assistant text the run produced. `pieces` is what the presentation port committed, which is the
 * population `presentation.pieceCount` counts - one paragraph can be several pieces, and a paced surface emits pieces
 * that are not text at all. `pieces.accounted` is the sum of what the Host named PER TURN, so a turn that never
 * printed its record cannot hide inside the total.
 */
export function summarizeDeliveryAccount({ records, piecesProduced, unparsable = 0 }) {
  const suppressed = {};
  let textParts = 0;
  let presented = 0;
  let textPieces = 0;
  let aheadPieces = 0;
  for (const record of records ?? []) {
    textParts += Number(record.textParts) || 0;
    presented += Number(record.presented) || 0;
    for (const [reason, count] of Object.entries(record.suppressed ?? {}))
      suppressed[reason] = (suppressed[reason] ?? 0) + (Number(count) || 0);
    textPieces += Number(record.pieces?.text) || 0;
    aheadPieces += Number(record.pieces?.ahead) || 0;
  }
  const produced = Number(piecesProduced) || 0;
  const accounted = textPieces + aheadPieces;
  const partsUnaccounted = (records ?? []).reduce((total, record) => total + unaccountedParts(record), 0);
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
        : partsUnaccounted !== 0
          ? "delivery_account_unaccounted_parts"
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
      unaccounted: partsUnaccounted,
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

/** One line a reader (and every log grep) can act on: the two numbers and what is left over. */
export function describeDeliveryAccount(account) {
  const { parts, pieces } = account;
  const verdict =
    account.blocked === null ? (account.nothingPresented ? "nothing presented" : "reconciled") : account.blocked;
  return `pieces produced ${pieces.produced} · accounted ${pieces.accounted} · unaccounted ${pieces.unaccounted} · parts produced ${parts.produced} · presented ${parts.presented} · unaccounted ${parts.unaccounted} · turns ${account.turns} · ${verdict}`;
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
  if (Number(parts.presented) + Number(parts.unaccounted) !== Number(parts.produced) - sumSuppressed(parts.suppressed))
    return Object.freeze({
      ok: false,
      code: "delivery_account_parts_do_not_add_up",
      detail: `parts produced ${String(parts.produced)} · presented ${String(parts.presented)} · suppressed ${String(sumSuppressed(parts.suppressed))} · unaccounted ${String(parts.unaccounted)}`,
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
