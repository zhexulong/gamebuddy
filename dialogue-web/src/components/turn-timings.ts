/**
 * Turn timings, marked so the browser's own Performance panel can read them.
 *
 * This is not a performance tool. Chrome DevTools, `PerformanceObserver` and Lighthouse already are,
 * and they need exactly one thing from the product: named marks on the timeline. What was missing here
 * was not an instrument - `git grep "performance\." -- dialogue-web/src` returned zero - so every
 * timing question ("why is a turn slow", "where did those 800ms go") could only be answered by
 * reading code and guessing.
 *
 * A mark, not a measurement: `performance.measure` between two marks is taken by whoever is looking
 * (DevTools, a Playwright script reading `performance.getEntriesByType("measure")`, or a future gate),
 * so nothing here decides which durations matter. That keeps the product free of a second opinion
 * about what "fast" means.
 *
 * The names are stable and prefixed because they are a contract with those readers:
 *
 *   gamebuddy:turn:submit        the player pressed send; the request is being assembled
 *   gamebuddy:turn:accepted      the Host answered that it accepted it (202, with the turn it started)
 *   gamebuddy:turn:first-token   the first streamed delta painted
 *   gamebuddy:turn:settled       the turn reached a terminal state
 *   gamebuddy:turn:failed        the turn ended as a failure (paired with settled, never instead)
 *
 * `submit -> accepted` is the Host's own round trip, and that is the split a first-token reading is
 * attributed with: until this mark existed the page recorded nothing between the press and the first
 * word, so "900 ms before the first token" could not say whether the app, the Host or the provider
 * held the time. `accepted` is emitted by the mutation that started the turn, from the answer it got
 * (see `observeTurnEvent` for why the event stream cannot carry it).
 *
 * Every mark carries the turn's idempotency key when one is known, so a DevTools recording with
 * several interleaved turns can still be attributed. Nothing carries player text: a mark name and a
 * key are identifiers, and a timing record that quoted the message would end up in a bug report.
 */

export const TURN_MARK_PREFIX = "gamebuddy:turn:";

export type TurnMarkStage = keyof typeof TURN_MARK;

export const TURN_MARK = Object.freeze({
  submit: `${TURN_MARK_PREFIX}submit`,
  accepted: `${TURN_MARK_PREFIX}accepted`,
  firstToken: `${TURN_MARK_PREFIX}first-token`,
  settled: `${TURN_MARK_PREFIX}settled`,
  failed: `${TURN_MARK_PREFIX}failed`,
});

/**
 * The entry type these marks land in. Named so a reader can filter without knowing the prefix:
 * `performance.getEntriesByType("mark").filter(e => e.detail?.surface === "chat")`.
 */
const DETAIL_KEYS = Object.freeze(["surface", "turnKey"]);

function supported() {
  return typeof performance !== "undefined" && typeof performance.mark === "function";
}

/**
 * Record one mark. Silent when the runtime has no Performance API, which is the case in some
 * server-rendered test harnesses - a missing timing must never break a turn.
 */
export function markTurn(stage: TurnMarkStage, detail: { surface?: string; turnKey?: string | null } = {}) {
  if (!supported()) return;
  const name = TURN_MARK[stage];
  const trimmed: Record<string, string> = {};
  for (const key of DETAIL_KEYS) {
    const value = detail[key as keyof typeof detail];
    if (value !== undefined && value !== null) trimmed[key] = String(value);
  }
  performance.mark(name, { detail: trimmed });
}

/**
 * Record the marks a turn event implies, and say whether the turn is over.
 *
 * This lives here rather than in the shell for two reasons. The shell is at its line ceiling, so
 * inline branching for five stages pushed it over; and the mapping from a contract event to a mark is
 * a fact about the CONTRACT (`BrowserTurnV1["state"]`), which is what this module already encodes.
 *
 * `payload` is read structurally rather than typed against one event member: the caller hands over the
 * whole discriminated union, and only these two optional fields are ever touched.
 *
 * Returns `terminal: true` when the turn reached a terminal state, so the caller can forget the key - a
 * key that outlives its turn attaches the next turn's timing to the previous turn's name.
 *
 * `accepted` is deliberately NOT mapped here. The Host publishes `turn.state_changed` twice: once as
 * its continuation starts, with the state its durable ledger projects (`projectTurn` in
 * `chat-pipeline-service.ts` turns `accepted_queued`/`attempt_starting` into `queued`), and again when
 * the turn ends. A `running` payload therefore never arrives for a fresh turn - it used to be the only
 * branch that could mark `accepted`, so on every real run the mark was never emitted and the stage a
 * first-token reading needs was permanently absent. The acceptance this page can see is the answer to
 * the request it made (202 `SubmitResultV1`, with the turn it started), which is the mutation's own
 * fact and is marked there.
 */
export function observeTurnEvent(
  event: Readonly<{ eventType: string; payload?: unknown }>,
  turnKey: string | null,
  previousTurnHandle: string | null,
): { readonly terminal: boolean; readonly isFirstDelta: boolean } {
  const payload = (event.payload ?? {}) as Readonly<{ turnHandle?: string; state?: string }>;
  if (event.eventType === "companion.delta") {
    /* The FIRST delta of a turn is the moment the player sees words; later deltas are the same paint. */
    const isFirstDelta = previousTurnHandle !== payload.turnHandle;
    if (isFirstDelta) markTurn("firstToken", { surface: "chat", turnKey });
    return { terminal: false, isFirstDelta };
  }
  if (event.eventType !== "turn.state_changed") return { terminal: false, isFirstDelta: false };
  if (payload.state === "completed" || payload.state === "cancelled") {
    markTurn("settled", { surface: "chat", turnKey });
    return { terminal: true, isFirstDelta: false };
  }
  if (payload.state === "failed") {
    markTurn("failed", { surface: "chat", turnKey });
    return { terminal: true, isFirstDelta: false };
  }
  return { terminal: false, isFirstDelta: false };
}

/**
 * The durations a reader asks for, computed from the marks that exist. Returns only pairs whose two
 * ends were both observed - a turn that never streamed a token has no `first-token` duration, and
 * reporting one as zero would describe a fast turn that did not happen.
 */
export function turnDurations(
  turnKey?: string,
): Readonly<Partial<Record<"accepted" | "firstToken" | "settled" | "failed", number>>> {
  if (!supported() || typeof performance.getEntriesByType !== "function") return Object.freeze({});
  const marks = performance
    .getEntriesByType("mark")
    .filter((entry) => entry.name.startsWith(TURN_MARK_PREFIX))
    .filter((entry) => turnKey === undefined || (entry as PerformanceMark).detail?.turnKey === turnKey)
    .sort((left, right) => left.startTime - right.startTime);
  const at = (stage: TurnMarkStage): number | undefined =>
    marks.find((entry) => entry.name === TURN_MARK[stage])?.startTime;
  const submit = at("submit");
  if (submit === undefined) return Object.freeze({});
  const durations: Partial<Record<"accepted" | "firstToken" | "settled" | "failed", number>> = {};
  for (const stage of ["accepted", "firstToken", "settled", "failed"] as const) {
    const end = at(stage);
    if (end !== undefined) durations[stage] = Math.round((end - submit) * 100) / 100;
  }
  return Object.freeze(durations);
}
