import { GAME_SURFACE_PROMPT_FLOOR as PROMPT_FLOOR } from "./game-surface-prompt-floor.test-support.js";
import type { TavernAuthoredContextCatalog } from "./tavern/catalog-service.js";

/**
 * How much of the Game surface's usable window the player's own authored context occupies.
 *
 * <p>
 * The defect this measures is an asymmetry, not a number: the volatile half of an authored
 * catalogue is summed and refused past 32,768 tokens
 * (`vendor/magic-context/packages/pi-plugin/src/gamebuddy-stable-context-source.ts`), while the
 * stable half — which rides the cached m[0] head on EVERY turn — has no cross-source bound at
 * all. Overrunning the window does not surface as "your card is too long"; it arrives from the
 * raw-fallback path as `PiStorageBusyError`, which reads exactly like a disk that would not open.
 * </p>
 *
 * <p>
 * **Everything here is computed, never transcribed.** Authored sizes come from the product's own
 * catalogue materializer (`buildGameSurfaceAuthoredCatalog`), whose `budgetTokens` is
 * `Math.ceil(content.length / 4)` (`tavern/catalog-service.ts`). The floor is the recorded
 * Game-surface prompt reading, imported rather than copied, so the two cannot drift. What this
 * module adds is the arithmetic neither of them owns: the sum, the headroom left, and the
 * authored size at which headroom reaches zero.
 * </p>
 *
 * <p>
 * **The companion's persona is NOT authored context here, and must not be counted as any.**
 * `identity-profile.ts` renders `persona.core`, `persona.interactionStyle` and
 * `persona.expressionStyle` INTO the system prompt (`Core disposition:` / `Interaction style:` /
 * `Expression style:`), and the Game-surface floor reading is a measurement of exactly that
 * assembled prompt. So the persona's cost is already inside `floorTokens`, and adding it again as
 * an authored source would double-count it — inflating the authored total by the whole persona and
 * making a guard built on this refuse cards that fit. It is absent from
 * `buildGameSurfaceAuthoredCatalog` for the same reason. Only the catalogue's own stable sources and
 * its volatile candidates are authored context on this surface.
 * </p>
 *
 * <p>
 * **The authored half is measured in `ceil(chars / 4)`, and that unit is an estimate.** It is the
 * product's own authored-context unit — what `budgetTokens` means everywhere in the Host, and what
 * the volatile sum is already bounded in — so measuring in it is measuring in the unit a guard
 * would speak. It is NOT a tokenizer count: a flat four-characters-per-token ratio is roughly
 * right for English prose and badly low for the CJK prose a shipped card is written in, where a
 * real BPE tokenizer produces several times more tokens per character (measured on this very
 * world book: 244 stable characters render to 465 tokens under Magic Context's tokenizer, ~1.9 per
 * character, not 0.25). So read every authored figure as a LOWER BOUND on what the model carries,
 * and the crossing point as an upper bound on how much authored text still fits. The floor half is
 * the opposite case and is exact — a recorded measurement taken with the real tokenizer.
 * </p>
 *
 * <p>
 * **The history budget is included because it is spent before authored text is.** Magic Context
 * renders `<session-history>` into the same m[0] head, sized from `history_budget_percentage`
 * (0.15 default) against the usable window. On a 32,768 window that is a few thousand tokens that
 * authored context cannot use, so a reading that left it out would overstate the room available by
 * that much. It is derived from the product's own three inputs — usable window, the 65% execute
 * threshold, the 15% history share — and its formula is stated beside it rather than hidden.
 * </p>
 */
export type AuthoredContextBudgetRow = Readonly<{
  /** A catalogue stable source's own kind. There is no `persona` row: see the module comment. */
  kind: TavernAuthoredContextCatalog["stableSources"][number]["kind"];
  sourceId: string;
  contentChars: number;
  tokens: number;
}>;

export type AuthoredContextBudgetReading = Readonly<{
  schema: "gamebuddy-authored-context-budget/v1";
  /** The window and reserve this reading is computed against (the shipped Game geometry). */
  geometry: Readonly<{ window: number; outputReserve: number; usableSoft: number }>;
  /**
   * The fixed cost paid before one word of authored context.
   *
   * `envelopeTokens` is the measurement the sums use: one reading of the whole
   * `{system, tools, messages: []}` envelope, so it also carries the JSON structure the parts do
   * not. `systemTokens + toolDefinitionTokens` is therefore smaller, and `envelopeOverheadTokens`
   * is that difference rather than a rounding error.
   */
  floor: Readonly<{
    toolCount: number;
    systemTokens: number;
    toolDefinitionTokens: number;
    envelopeOverheadTokens: number;
    envelopeTokens: number;
  }>;
  /**
   * The history budget the fold spends inside the same head, derived from the usable window via
   * the historian's own percentages. Authored context competes with this, not just with the floor.
   */
  history: Readonly<{
    budgetPercentage: number;
    executeThresholdPercentage: number;
    tokens: number;
  }>;
  /**
   * The always-on half: injected unconditionally into the cached m[0] head, every turn. These are
   * the sources with no cross-source bound, which is the defect this reading exists to size.
   */
  stable: Readonly<{ rows: readonly AuthoredContextBudgetRow[]; contentChars: number; tokens: number }>;
  /**
   * The keyword-gated half: per-turn CANDIDATES. One turn carries only the entries whose trigger
   * words matched, so `tokens` is the whole candidate pool — an upper bound on what a single turn
   * adds, and the right figure to bound.
   */
  volatile: Readonly<{ rowCount: number; contentChars: number; tokens: number }>;
  total: Readonly<{
    floorTokens: number;
    historyTokens: number;
    authoredTokens: number;
    /** floor + history + every authored token: everything but the transcript itself. */
    inputTokens: number;
    /** `usableSoft - inputTokens`; negative means the prompt cannot fit before the transcript. */
    headroomTokens: number;
    headroomChars: number;
  }>;
  /** The same arithmetic swept over authored sizes, so the shape is visible and not a single point. */
  curve: readonly Readonly<{
    authoredTokens: number;
    authoredChars: number;
    totalTokens: number;
    headroomTokens: number;
  }>[];
  /**
   * The authored size at which floor + history + authored == usableSoft, with not one word of
   * transcript counted. Anything above this cannot fit at all.
   */
  crossing: Readonly<{ authoredTokens: number; authoredChars: number }>;
}>;

/** The shipped Game geometry: a 32,768 window with the 8,192 output reserve. */
export function shippedAuthoredContextGeometry(): AuthoredContextBudgetReading["geometry"] {
  const primary = PROMPT_FLOOR.denominator.find((row) => row.window === 32_768 && row.output === 8_192);
  if (primary === undefined)
    throw new Error("game_surface_floor_has_no_32768_8192_denominator: re-measure the prompt floor reading");
  return Object.freeze({
    window: primary.window,
    outputReserve: primary.output,
    usableSoft: primary.usableSoft,
  });
}

/** `Math.ceil(content.length / 4)` — the product's authored-token unit (`tavern/catalog-service.ts`). */
export function authoredTokensFor(content: string): number {
  return Math.ceil(content.length / 4);
}

/** The two knobs Magic Context's historian resolves the history budget from. */
export const HISTORY_BUDGET_PERCENTAGE = 0.15;
export const EXECUTE_THRESHOLD_PERCENTAGE = 65;

/**
 * The history budget `resolveHistoryBudgetTokensForPi` derives, in Magic Context's formula:
 * `floor(usableSoft × executeThreshold% × historyBudget%)`.
 *
 * Written out here rather than imported because `vendor/magic-context` is not on the Host's import
 * graph. The consequence is that this can drift from the vendor's arithmetic; the test that reads
 * it asserts the formula's own structure (each factor applied in order, floored once at the end)
 * so a change to this line is a change to a claim, not a silent numeric edit.
 */
export function deriveHistoryBudgetTokens(
  usableSoft: number,
  {
    historyBudgetPercentage = HISTORY_BUDGET_PERCENTAGE,
    executeThresholdPercentage = EXECUTE_THRESHOLD_PERCENTAGE,
  } = {},
): number {
  return Math.floor(usableSoft * (executeThresholdPercentage / 100) * historyBudgetPercentage);
}

/**
 * Measure one materialized catalogue against the shipped geometry.
 *
 * <p>
 * The catalogue arrives already materialized by the product, so its stable sources, their order
 * and their `budgetTokens` are the product's own. No persona is added: it is rendered into the
 * system prompt by `identity-profile.ts` and is therefore already counted in `floorTokens` (see the
 * module comment). Counting it again here would inflate the authored total by the whole persona and
 * make a guard built on this refuse cards that fit.
 * </p>
 */
export function measureGameSurfaceAuthoredContextBudget(
  catalog: TavernAuthoredContextCatalog,
): AuthoredContextBudgetReading {
  const geometry = shippedAuthoredContextGeometry();
  const floorPartsTokens = PROMPT_FLOOR.floor.systemTokens + PROMPT_FLOOR.floor.toolsTokens;
  // The envelope is measured as ONE string, so it is never smaller than its two parts. A reading
  // where it were would mean the halves and the whole came from different runs.
  if (PROMPT_FLOOR.floor.envelopeTokens < floorPartsTokens)
    throw new Error(
      `game_surface_floor_envelope_below_parts: ${PROMPT_FLOOR.floor.envelopeTokens} < ${floorPartsTokens}`,
    );
  const floor = Object.freeze({
    toolCount: PROMPT_FLOOR.floor.toolCount,
    systemTokens: PROMPT_FLOOR.floor.systemTokens,
    toolDefinitionTokens: PROMPT_FLOOR.floor.toolsTokens,
    envelopeOverheadTokens: PROMPT_FLOOR.floor.envelopeTokens - floorPartsTokens,
    envelopeTokens: PROMPT_FLOOR.floor.envelopeTokens,
  });
  const historyTokens = deriveHistoryBudgetTokens(geometry.usableSoft);

  const stableRows: AuthoredContextBudgetRow[] = catalog.stableSources.map((source) =>
    Object.freeze({
      kind: source.kind,
      sourceId: source.sourceId,
      contentChars: source.content.length,
      tokens: authoredTokensFor(source.content),
    }),
  );
  const stableTokens = stableRows.reduce((total, row) => total + row.tokens, 0);
  const stableChars = stableRows.reduce((total, row) => total + row.contentChars, 0);
  const volatileTokens = catalog.volatileSources.reduce(
    (total, source) => total + authoredTokensFor(source.content),
    0,
  );
  const volatileChars = catalog.volatileSources.reduce((total, source) => total + source.content.length, 0);

  const authoredTokens = stableTokens + volatileTokens;
  const committedTokens = floor.envelopeTokens + historyTokens;
  const headroom = (authored: number) => geometry.usableSoft - committedTokens - authored;
  const curve = [0, 2_000, 4_000, 8_000, 12_000, 16_000].map((authored) =>
    Object.freeze({
      authoredTokens: authored,
      authoredChars: authored * 4,
      totalTokens: committedTokens + authored,
      headroomTokens: headroom(authored),
    }),
  );
  const crossingTokens = geometry.usableSoft - committedTokens;
  return Object.freeze({
    schema: "gamebuddy-authored-context-budget/v1",
    geometry,
    floor,
    history: Object.freeze({
      budgetPercentage: HISTORY_BUDGET_PERCENTAGE,
      executeThresholdPercentage: EXECUTE_THRESHOLD_PERCENTAGE,
      tokens: historyTokens,
    }),
    stable: Object.freeze({
      rows: Object.freeze(stableRows),
      contentChars: stableChars,
      tokens: stableTokens,
    }),
    volatile: Object.freeze({
      rowCount: catalog.volatileSources.length,
      contentChars: volatileChars,
      tokens: volatileTokens,
    }),
    total: Object.freeze({
      floorTokens: floor.envelopeTokens,
      historyTokens,
      authoredTokens,
      inputTokens: committedTokens + authoredTokens,
      headroomTokens: headroom(authoredTokens),
      headroomChars: headroom(authoredTokens) * 4,
    }),
    curve: Object.freeze(curve),
    crossing: Object.freeze({
      authoredTokens: crossingTokens,
      authoredChars: crossingTokens * 4,
    }),
  });
}
