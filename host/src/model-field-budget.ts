/**
 * HOW MUCH OF A MOD-AUTHORED FIELD REACHES THE MODEL, in one place: the ceilings, the writer that enforces them, and
 * the order a cut keeps.
 *
 * <p>
 * This module is the budget table and the cut, and nothing else. It was extracted from `fact-brief.ts` because the two
 * are one responsibility - a ceiling nothing enforces is a comment, and a cut with no declared ceiling is an opinion -
 * and because both are read from OUTSIDE the Host: `SweepTargetRefusalNamingTests` (the Mod's census) judges a receipt
 * detail by `evidence`, and it reads that number from the table this module PUBLISHES as data
 * (`model-field-budget.published.json`, held equal to the declaration below by `model-field-budget.published.test.ts`),
 * so the number the model actually receives has one spelling rather than a second copy in a C# test.
 * </p>
 *
 * <p>
 * TWO KINDS OF FIELD, TWO KINDS OF NUMBER. A node's `hint` and `reasonDetail` are bounded by their PRODUCER: the Mod's
 * journal refuses a hint over 256 characters and a refusal detail over 512
 * (`BodyProgramValidation.MaximumNodeHintLength` / `MaximumNodeRefusalDetailLength`), and `protocol.ts` refuses a frame
 * over the same two numbers. Printing them up to those bounds is printing them WHOLE, and a smaller number is a Host
 * opinion about a field the Mod already sized.
 * </p>
 *
 * <p>
 * WHAT A SMALLER ONE COST, measured 2026-11-11 (`round45`). All 15 failed `for_each` hints reached `fact-brief.ts`
 * between 169 and 255 characters (median 248) and all 15 of their details between 480 and 507, against a flat
 * 160-character ceiling: 30 cuts in one run's model-visible text. The ledger survived every cut and the per-code tail -
 * `no_safe_clear:crop:scythe_crop=3; no_rule_matched:ground_58_9=1;…`, the part that says WHICH rows failed - was
 * exactly what fell off, mid-token. The ceiling was wrong, not the text.
 * </p>
 */

import { MAX_BATCH_BYTES } from "./event-pump.js";
import { MAX_BODY_PROGRAM_REFUSAL_DETAIL_LENGTH } from "./protocol.js";

/**
 * The most fact lines `<world-facts>` names before it counts the rest.
 *
 * The pump already bounds how many facts a batch may hold (`MAX_PENDING_*`) and how large the whole delivery may be
 * (`MAX_BATCH_BYTES`), and the byte bound is what protects the context. This cap is the SECOND bound, and it exists
 * because dropping the oldest fact is right for a run and wrong for a REPORT: a batch of ninety receipts answered "what
 * just happened" with the thirty newest ones and said nothing about the sixty it left out. So the line count is
 * bounded where the sentences are composed, and the remainder is named.
 *
 * It lives here rather than beside the block it counts because it is a budget, and this module is where the budgets
 * are: the per-field ceilings below are shares of one line, and this is the only declaration of how many there are.
 */
export const MAX_WORLD_FACT_LINES = 24;

/**
 * A node hint's ceiling, which is the wire's own number: `protocol.ts:isBodyProgramNodeStatus` refuses a frame carrying
 * a longer one, so a hint that arrived through the bridge can never meet this ceiling, let alone a smaller one.
 *
 * `fact-brief.private.test.ts` reads that validator and asserts the two numbers are the same one, so this cannot drift
 * from the bound the Mod's journal enforces.
 */
const MAX_BODY_PROGRAM_NODE_HINT_CHARS = 256;

/**
 * How many of a line's fields the Host may print at a full share each. `failureWords` joins a node's `hint` and its
 * `reasonDetail` on ONE `<world-facts>` line (`｜` between them), so a line can carry two fields of this size and the
 * share of each is half the line.
 */
const MODEL_FIELDS_SHARING_ONE_LINE = 2;

/**
 * One `<world-facts>` line's character share of a delivery, derived from the two bounds that already exist: the
 * delivery's own byte bound (`MAX_BATCH_BYTES`, `event-pump.ts`) and how many lines the block names
 * (`MAX_WORLD_FACT_LINES`).
 *
 * <p>
 * THE ARITHMETIC, with the numbers this repository publishes: `MAX_BATCH_BYTES` is
 * `floor(22,879 × 0.32 × 2.47) = 18,083` characters (`deriveMaxBatchBytes(HISTORIAN_CHUNK_FALLBACK_TOKENS)`), and
 * `18,083 / 24 = 753` characters per line. A line carries at most two of these fields, so one field's share is
 * `floor(753 / 2) = 376`.
 * </p>
 *
 * <p>
 * WHAT THIS REPLACES, and why the old number had to go. `evidence` was 160, and its docblock called that "the Host's own
 * measured share of one line" - a measurement of other lines, not a share of the bound any of them is held to. A number
 * nobody derived cannot be re-derived when the bound moves, so it stayed at 160 while receipt evidence grew to 200-600
 * characters. A hand-written bound beside a comment claiming a measurement is the defect; this is the derivation.
 * </p>
 *
 * <p>
 * THE CASES THE OWNER OF THE BOUND MUST STILL NOTE: a `hint` (256) and a `reasonDetail` (512) each keep their producer's
 * own ceiling, and 256 + 512 + a separator is 769 - just over this 753-character line share, so a failure node whose two
 * fields are both at their maximum spends slightly more than one line's budget. That is a bound on what the MOD writes
 * (its own journal enforces both), not something this table can cut without shortening a field the Mod declared whole;
 * the block's own 24-line cap and `MAX_BATCH_BYTES` still bound the delivery, and pump overflow is put back rather than
 * dropped. Named here rather than hidden.
 * </p>
 */
export function derivedEvidenceCeiling(): number {
  return Math.floor(MAX_BATCH_BYTES / MAX_WORLD_FACT_LINES / MODEL_FIELDS_SHARING_ONE_LINE);
}

/**
 * The resolved share, published as a literal BESIDE THIS MODULE rather than computed here: a reader OUTSIDE this process
 * needs it, and that reader cannot follow a call expression - `model-field-budget.published.json` states it as data, so
 * nothing outside this process has to parse TypeScript. `fact-brief.private.test.ts` asserts this literal equals
 * `derivedEvidenceCeiling()`, and `model-field-budget.published.test.ts` asserts the published table equals this
 * declaration, which is what keeps one fact from having two spellings: the derivation is authoritative, this is its
 * published value, and the artifact is that value in the form a foreign reader reads.
 */
const EVIDENCE_CEILING_CHARS = 376;

/**
 * The ceiling every Mod-authored field the Host prints is held to, and where each number comes from.
 *
 * <p>
 * `hint` and `reasonDetail` are the producer's own numbers, for the reason in this module's header. `evidence` is the
 * Host's own share of one line, derived (`derivedEvidenceCeiling`) and published above.
 * </p>
 */
export const MODEL_FIELD_CEILINGS = Object.freeze({
  hint: MAX_BODY_PROGRAM_NODE_HINT_CHARS,
  reasonDetail: MAX_BODY_PROGRAM_REFUSAL_DETAIL_LENGTH,
  evidence: EVIDENCE_CEILING_CHARS,
});

/** Every Mod-authored field this file prints under a ceiling. */
export type ModelVisibleField = keyof typeof MODEL_FIELD_CEILINGS;

/**
 * THE ORDER A CUT KEEPS, declared here because neither length nor the producer's writing order can rank a field.
 *
 * <p>
 * THE RULE, in one sentence: a field that says what stands in the way, what removes it, or where to act comes before a
 * field that describes the situation. The rank is a total order over the NAMES this rank declares - the four things a
 * refusal owes - and every name it does not mention keeps the producer's order AFTER them. That is what makes it a rank
 * rather than an allow-list: an unknown field is not refused, it simply goes last, so a producer that writes its
 * narration first no longer costs the answer.
 * </p>
 *
 * <p>
 * WHY IMPORTANCE CANNOT BE THE PRODUCER'S ORDER, measured 2026-11-13 (`round63`). A `fish_here` refusal carried
 * `blocker_occupant=twig@69,31` and `clears_with=remove_placed_item(stamina:2,tool:target_requirement,turns:1)` as fields
 * 11 and 13 of 16, and the cut kept the first whole fields - so the model read `footprint=1` and `clear_step=twig@69,31`
 * and neither fact. She swept the scythe at a twig, cut an unnamed weed at `67:29`, and never tried
 * `remove_placed_item`, the one published action whose `Clears` declaration names a twig. The producer was writing in the
 * order it measured the world in; the order a reader needs is not that order, and it has to be declared by the reader's
 * side of the boundary.
 * </p>
 *
 * <p>
 * THE VOCABULARY IS THE MOD'S, THE RANK IS THE HOST'S. `ClearingEvidence.DescribeBlocker` publishes the blocker and its
 * clearer under these names; when a future producer picks a different name, the failure is not a wrong cut but a missing
 * rank - and `fact-brief.private.test.ts#decision_field_rank_names_a_producer` holds every declared rank name to the
 * `name=` keys the Mod's own production sources spell, so a name that stops existing is named there rather than left to
 * hoist nothing.
 * </p>
 */
export const DECISION_FIELD_RANK = Object.freeze([
  "blocker_occupant",
  "clears_with",
  "clear_step",
  "blocker_target",
  "blocked_by",
  "reason",
  "state",
  "target",
  "tile",
  "stand_at",
  "remaining_clears",
]);

/**
 * How a cut names what it withheld: the names of the whole fields a line did not show, and - when one field alone is over
 * the ceiling - that field's own length against the ceiling it met. One spelling each, so a run audit greps one name.
 */
const DROPPED = "dropped";
const FIELD_OVER_CEILING = "field_over_ceiling";

/**
 * One Mod-authored field's share of a line, cut at its own ceiling - on a FIELD boundary, never inside one, and in the
 * order a reader needs rather than the order the producer wrote it in.
 *
 * <p>
 * A receipt's evidence is `k=v;k=v` (`ToolActionEvidence.Compose`), and slicing it at the character ceiling produced a
 * token that looks like a fact and is not one: a 254-character proof cut at 160 ended mid-value (`stamina_bef`), and the
 * only thing the line then added was `[evidence_detail_over_ceiling:254:160]` - the byte arithmetic of a budget, which
 * tells a reader the budget was exceeded and nothing about what it lost. So every field is either printed WHOLE or not
 * printed at all.
 * </p>
 *
 * <p>
 * AND THE CUT DOES NOT KEEP THE PRODUCER'S FIRST FIELDS, because the first fields are whatever the producer happened to
 * measure first. `DECISION_FIELD_RANK` decides what comes first and everything else keeps its own order after it, so the
 * length of a field and its position in the Mod's sentence stop deciding whether a reader can act. What a cut drops it
 * NAMES (`…[dropped:footprint,standable_tiles]`), or names what it had room to name and counts the rest
 * (`…[dropped:footprint+3]`) - a count alone, which is what this line used to say, tells a reader that something is
 * missing and nothing about what.
 * </p>
 *
 * <p>
 * A single field that alone exceeds the ceiling cannot be shown at any prefix, so the line is replaced by
 * `[field_over_ceiling:<length>:<ceiling>]`: the two numbers are the ones that decide whether the frame should have
 * arrived at all. At the ceiling the value prints exactly as the Mod wrote it, because the point of
 * `MODEL_FIELD_CEILINGS` is that a field inside its producer's bound is printed whole.
 * </p>
 */
export function boundedField(field: ModelVisibleField, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text === "") return undefined;
  const ceiling = MODEL_FIELD_CEILINGS[field];
  if (text.length <= ceiling) return text;
  const entries = text.split(";");
  if (entries.length === 1) return `[${FIELD_OVER_CEILING}:${String(text.length)}:${String(ceiling)}]`;

  // Ranked first, in the rank's order; then every other field in the order its producer wrote it. One sort, so the
  // printed order and the dropped names are read from the same decision, and a name the rank does not know simply sorts
  // last (`rankKey` gives it the rank's own length).
  const position = new Map(entries.map((entry, index) => [entry, index]));
  const ordered = [...entries].sort(
    (left, right) => rankKey(left) - rankKey(right) || (position.get(left) ?? 0) - (position.get(right) ?? 0),
  );
  const showable = ordered.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.length <= ceiling);
  // NAMES BEFORE ROOM: the largest cut that can still NAME what it dropped is taken before any cut that can only count,
  // because a reader who is told something is missing and not what cannot ask for it. The second pass is the fallback for
  // a list with nothing nameable in it (a pass of refused rows' sentences) and for values too small for even one name.
  for (const requireNames of [true, false])
    for (let kept = showable.length; kept >= 0; kept -= 1) {
      const shownIndexes = new Set(showable.slice(0, kept).map(({ index }) => index));
      // Indexed, not value-matched: a producer that repeats a field name must not have both copies kept or both dropped.
      const shown = ordered.filter((_, index) => shownIndexes.has(index));
      const dropped = ordered.filter((_, index) => !shownIndexes.has(index));
      const body = shown.join(";");
      const room = ceiling - body.length - (body === "" ? 0 : 1);
      const notice = droppedNotice(dropped, room, requireNames);
      if (notice !== undefined) return `${body}${notice}`;
    }
  return `[${FIELD_OVER_CEILING}:${String(text.length)}:${String(ceiling)}]`;
}

/** One field's own name, or the entry itself when it carries no `=` at all. */
function fieldNameOf(entry: string): string {
  const at = entry.indexOf("=");
  return at <= 0 ? entry : entry.slice(0, at);
}

/** Where a field sits in `DECISION_FIELD_RANK`, or the rank's own length when the rank says nothing about it. */
function rankKey(entry: string): number {
  const at = DECISION_FIELD_RANK.indexOf(fieldNameOf(entry));
  return at === -1 ? DECISION_FIELD_RANK.length : at;
}

/**
 * The tail a cut appends: the names of the fields it dropped, and `+<count>` for the ones it had no room to name.
 *
 * @param dropped The whole entries the body did not show, in the order they would have been read.
 * @param room How many characters the tail may spend.
 * @param requireNames When true, a tail that names nothing is REFUSED (`undefined`) rather than returned, so the caller
 * shows one field fewer to make room for a name. A count alone is the last resort, not the first fit.
 * @returns The tail, or `undefined` when this cut cannot say what the caller asked it to say.
 */
function droppedNotice(dropped: readonly string[], room: number, requireNames: boolean): string | undefined {
  if (dropped.length === 0) return room >= 0 ? "" : undefined;
  // Only a `k=v` entry has a NAME to state. A refused row's own sentence rides the same list
  // (`RouteReenteringBodyProgramExecutor.FailureDetail` appends `;<sentence>`), and a sentence is not a field: naming
  // half of it would read as a field that does not exist, so it is counted and never named.
  const names = dropped.filter((entry) => entry.includes("=")).map(fieldNameOf);
  const shape = (named: readonly string[]): string => {
    const rest = dropped.length - named.length;
    if (rest === 0) return `…[${DROPPED}:${named.join(",")}]`;
    return named.length === 0 ? `…[${DROPPED}:${String(rest)}]` : `…[${DROPPED}:${named.join(",")}+${String(rest)}]`;
  };
  const all = shape(names);
  if (all.length <= room) return all;
  // As many whole NAMES as fit, then the number of fields nothing named - never a truncated name, which would read as a
  // different field.
  for (let named = names.length - 1; named >= 1; named -= 1) {
    const candidate = shape(names.slice(0, named));
    if (candidate.length <= room) return candidate;
  }
  if (requireNames) return undefined;
  const bare = shape([]);
  return bare.length <= room ? bare : undefined;
}
