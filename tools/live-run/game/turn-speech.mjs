/**
 * WHICH LINES BELONG TO WHICH TURN, closed at the NEXT turn's start rather than at the await that returned.
 *
 * <p>
 * The session record's `spokenLines` was a slice taken the instant `runAgentTurn` resolved: `presentationPieces.slice(
 * spokenBefore)`. That is a slice of ARRAY POSITION AT A MOMENT, not of a turn, and the moment is the harness's, not the
 * world's. Measured 2026-11-21 (`round87b`, `.live-runs/game-ladder/2026-11-21T13-38-15-600Z-multiday_routine`): the day
 * 3 turn settled with `spokenLines: []`, and `run-progress.jsonl` records nineteen bubbles presented after that turn's
 * `turn_started` and before `run_ended` - her speech for the day arrived after the await returned, so the field said she
 * said nothing while the player was shown nineteen lines. Over the run the record held 4 of the 58 bubbles the delivery
 * account and `presentation.pieceCount` both counted.
 * </p>
 * <p>
 * WHICH ONE WAS BUILT WRONG: the session record, not the progress record. `run-progress.jsonl` writes one `presented`
 * line per commit as it lands (`core/run-progress.mjs`), so it is a witness of the same population the Host's delivery
 * account counts; `spokenLines` is derived from that population by a window, and the window was the wrong one. Closing
 * each turn at the NEXT turn's start makes the derivation total - every committed piece falls in exactly one turn - so
 * the sum of every turn's lines is the population itself and the two artifacts must agree.
 * </p>
 * <p>
 * The window is published (`spokenFromIndex`/`spokenToIndex`) so the claim is checkable in the bundle instead of only
 * being true in the process that wrote it.
 * </p>
 */

function lineOf(piece) {
  return (typeof piece === "string" ? piece : (piece?.text ?? "")).trim();
}

/** CJK writing, the scripts a Chinese bubble speaks in and a one-letter Latin word cannot join. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/u;

const refusal = (text) => `bubble_carried_a_fragment:${text.slice(0, 20)}`;

/**
 * THE ONE REFUSAL A DELIVERED BUBBLE CAN EARN, or `null` when its own text is speech.
 *
 * <p>
 * MEASURED 2026-11-21 (`round89`, `.live-runs/game-ladder/2026-11-21T20-38-52-354Z-multiday_routine`): the eighteenth
 * bubble reached the player as `b 十五包防风草种子到手，兜里还剩七百六。…`. The producer is the model's own text part and
 * nothing else - the session record's assistant message (`#186`, `deepseek-v4.1-flash`) carries ONE `text` part whose
 * string begins `b `, its `thinking` block says `Say one line: 十五包防风草种子到手，七百六还剩着。回地里种上。`, and the
 * bubble's text is that part verbatim. So it is not a chunk boundary from streaming, not a markdown or whitespace parse,
 * and not a role tag: a single stray character arrived at the head of the bubble and the assembler printed it as her
 * words. A trim would hide a provider defect; a REFUSAL names it, in the artifact, in the shape a reader can grep.
 * </p>
 *
 * <p>
 * TWO SHAPES, ONE SCOPE. A bubble that is nothing but ONE LATIN LETTER is refused: a bubble is one utterance, and a
 * letter is not one (a single CJK character is - `哦` is an answer). A LOWERCASE Latin letter followed by whitespace and
 * then CJK words is refused, because a lowercase letter cannot be a one-letter word in a Chinese bubble; uppercase is
 * excluded because `A 和 B 你选哪个` labels an option and is a real sentence, and `a cat` in an English bubble is a real
 * article, which is why the head rule reads the bubble's own `locale` and applies to `zh` only. Over the 287 bundles and
 * 1 742 delivered pieces this machine holds, that predicate fires exactly once: the bubble above, while every other
 * bubble of every other run is accepted.
 * </p>
 */
export function bubbleFragment(text, locale = null) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length === 0) return null;
  if (/^[A-Za-z]$/u.test(trimmed)) return refusal(trimmed);
  const head = /^([a-z])\s+(\S)/u.exec(trimmed);
  if (head === null) return null;
  if (!String(locale ?? "").toLowerCase().startsWith("zh")) return null;
  if (!CJK.test(head[2])) return null;
  return refusal(trimmed);
}

/**
 * Every delivered bubble of one bundle, and which of them its own text refuses.
 *
 * <p>
 * The population is `presentation.pieces` - the pieces the presentation port committed - and the rule is
 * {@link bubbleFragment}, so the verdict and the turn's own record cannot refuse different bubbles. A bundle written
 * before `refusedBubbles` existed on the turn record is read by this same authority, which is how `round89`'s stray `b`
 * is named from a bundle that predates the field. `index` is the piece's own `index` when it publishes one, else its
 * position, so a refusal can be found in the artifact it came from.
 * </p>
 */
export function readDeliveredBubbles(pieces) {
  const list = Array.isArray(pieces) ? pieces : [];
  const refused = [];
  for (const [position, piece] of list.entries()) {
    const bubble = readBubble(piece, position);
    if (bubble.code !== null) refused.push(Object.freeze({ index: bubble.index, code: bubble.code }));
  }
  return Object.freeze({ examined: list.length, refused: Object.freeze(refused) });
}

/** One committed piece as a bubble: its text, where it sits, when it landed, and the refusal its own text earns (or none). */
function readBubble(piece, fallbackIndex) {
  const text = lineOf(piece);
  const locale = typeof piece === "string" ? null : (piece?.locale ?? null);
  return {
    index: Number.isInteger(piece?.index) ? piece.index : fallbackIndex,
    text,
    atMs: Number.isFinite(piece?.atMs) ? piece.atMs : null,
    code: text.length === 0 ? null : bubbleFragment(text, locale),
  };
}

/**
 * The turns with their windows closed and their lines read out of the committed pieces.
 *
 * `spokenFromIndex` is the piece index at the turn's own start (the caller records it before the turn is handed over).
 * A turn with no index is the first one - the population starts where the run does - and the last turn runs to the end.
 * Pure, and idempotent: it reads only the index and the pieces, so a caller may take the same reading at the promise
 * reading and again when the bundle is assembled, and the two cannot disagree.
 *
 * A REFUSED BUBBLE IS NOT ONE OF HER LINES, and every reading that asks what she SAID goes through `spokenLines`, so a
 * bubble carrying a fragment is not read as speech by any of them. Nothing is lost by that: its text is still in
 * `presentation.pieces`, the code names the piece by index and its first 20 characters, and `refusedBubbles` keeps the
 * turn's count in the population the run presented - `analysis/self-record.mjs` adds the two back together.
 *
 * `spokenAtMs` IS THE SAME POPULATION'S CLOCK, line for line: the moment the player was shown each line, from the piece's
 * own `atMs` (`./presentation-piece-time.mjs`). It is published beside the lines rather than inside them so a reading that
 * quotes a commitment can date it without holding the presentation population itself - the promise ledger names the hour
 * she promised at, and `null` where a piece carried no clock is "nobody recorded when", never zero.
 */
export function attributeTurnSpeech(turns, pieces) {
  const list = Array.isArray(turns) ? turns : [];
  const committed = Array.isArray(pieces) ? pieces : [];
  const startOf = (turn) => (Number.isInteger(turn?.spokenFromIndex) ? Math.max(0, turn.spokenFromIndex) : 0);
  return list.map((turn, position) => {
    const from = startOf(turn);
    const next = list[position + 1];
    const to = next === undefined ? committed.length : Math.min(committed.length, Math.max(from, startOf(next)));
    // `refusedBubbles` keeps the population whole: a bubble the assembler will not read as her speech is still a bubble
    // the player was shown (`presentation.pieces` holds its text), so it is NAMED here rather than deleted from the
    // count - `analysis/self-record.mjs` adds the two back together against the run's own `presented` lines.
    const read = committed.slice(from, to).map((piece, offset) => readBubble(piece, from + offset));
    const spoken = read.filter((bubble) => bubble.text.length > 0 && bubble.code === null);
    return Object.freeze({
      ...turn,
      spokenFromIndex: from,
      spokenToIndex: to,
      spokenLines: Object.freeze(spoken.map((bubble) => bubble.text)),
      spokenAtMs: Object.freeze(
        spoken.map((bubble) => (Number.isFinite(bubble.atMs) ? bubble.atMs : null)),
      ),
      refusedBubbles: Object.freeze(
        read.filter((bubble) => bubble.code !== null).map((bubble) => Object.freeze({ index: bubble.index, code: bubble.code })),
      ),
    });
  });
}
