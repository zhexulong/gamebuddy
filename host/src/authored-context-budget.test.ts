import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  authoredTokensFor,
  deriveHistoryBudgetTokens,
  measureGameSurfaceAuthoredContextBudget,
  shippedAuthoredContextGeometry,
} from "./authored-context-budget.test-support.js";
import { GAME_SURFACE_PROMPT_FLOOR } from "./game-surface-prompt-floor.test-support.js";
import { buildGameCompanionSystemPrompt, identityProfileMacros } from "./identity-profile.js";
import { buildGameSurfaceAuthoredCatalog } from "./tavern/catalog-service.js";
import { DEFAULT_COMPANION_PRESET } from "./tavern/default-companion-preset.js";
import { renderMacros } from "./tavern/macro-engine.js";
import { validateWorldBook } from "./worldbook.js";

/**
 * THE AUTHORED CONTEXT'S SHARE OF THE GAME WINDOW, MEASURED ON THE SHIPPED CARD.
 *
 * <p>
 * The premise under test is narrower than "the card is big": it is that the STABLE half of the
 * authored context — the half injected unconditionally into the cached m[0] head on every turn —
 * has no cross-source bound, while the volatile half is summed and refused past 32,768 tokens.
 * Sizing that asymmetry needs real numbers, and none of them may be transcribed: the shipped book's
 * authored size, the fixed prompt-floor cost, the history budget spent in the same head, and the
 * usable window.
 * </p>
 *
 * <p>
 * Two sources of the same book are measured and required to agree: `DEFAULT_COMPANION_PRESET`,
 * which is the form that actually ships (the raw card must not), and the committed
 * `assets/tavern/presets/default-companion/worldbook.json` it is generated from. Reading only the
 * preset would let it drift from the asset; reading only the asset would measure something the
 * product never loads. `default-companion-preset.test.ts` owns the full parity proof between the
 * two; this file needs only enough of it to know it is sizing the book the product ships.
 * </p>
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root, found by the same marker the prompt-floor test walks to. */
function repositoryRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, "integrations", "stardew", "action-development"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repository_root_not_found:${start}`);
    directory = parent;
  }
}

const ROOT = repositoryRoot(HERE);

/** The committed book asset, read from git at HEAD — never the working tree, which lanes edit. */
function committedWorldBook(): unknown {
  const spec = "HEAD:assets/tavern/presets/default-companion/worldbook.json";
  try {
    return JSON.parse(execFileSync("git", ["show", spec], { cwd: ROOT, encoding: "utf8" }));
  } catch (error) {
    throw new Error(
      `committed_asset_unreadable: git could not show ${spec} (${error instanceof Error ? error.message : String(error)}); ` +
        "reading the file on disk here would measure whatever a lane has in flight",
    );
  }
}

/**
 * One valid world-book entry, at a caller-chosen content length.
 *
 * The rest of the shape is the minimum the validator accepts, so the only thing these probes vary
 * is size — which is what makes them probes of the BOUND rather than of an invented record.
 */
function worldBookEntry(index: number, contentChars: number, constant: boolean): Record<string, unknown> {
  return {
    entryId: `probe-entry-${index}`,
    title: "probe",
    content: "x".repeat(contentChars),
    scope: "setting",
    provenance: "authored",
    tokenBudget: "small",
    ...(constant ? { constant: true } : { keys: ["probe"] }),
  };
}

/** A whole valid book holding exactly these entries, plus the premise field the validator allows to be empty. */
function worldBookOf(entries: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    worldBookId: "probe-world-book",
    revision: 1,
    alwaysOnPremise: "",
    entries,
  };
}

/** The largest entry content the world-book validator keeps, found by asking it. */
function largestAcceptedEntryChars(): number {
  // Exponential search then binary search over the validator itself: no constant is transcribed, and
  // a change to the bound moves this number with it.
  const accepted = (chars: number): boolean => {
    try {
      validateWorldBook(worldBookOf([worldBookEntry(0, chars, true)]));
      return true;
    } catch {
      return false;
    }
  };
  if (!accepted(1)) throw new Error("worldbook_validator_refuses_a_one_char_entry");
  let low = 1;
  let high = 2;
  while (accepted(high)) {
    low = high;
    high *= 2;
    if (high > 1 << 26) throw new Error("worldbook_entry_bound_not_found");
  }
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (accepted(mid)) low = mid;
    else high = mid;
  }
  return low;
}

/** The largest number of entries one book may hold, found by asking the validator. */
function largestAcceptedEntryCount(): number {
  const accepted = (count: number): boolean => {
    try {
      validateWorldBook(worldBookOf(Array.from({ length: count }, (_, index) => worldBookEntry(index, 1, false))));
      return true;
    } catch {
      return false;
    }
  };
  if (!accepted(1)) throw new Error("worldbook_validator_refuses_a_one_entry_book");
  let low = 1;
  let high = 2;
  while (accepted(high)) {
    low = high;
    high *= 2;
    if (high > 1 << 20) throw new Error("worldbook_entry_count_bound_not_found");
  }
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (accepted(mid)) low = mid;
    else high = mid;
  }
  return low;
}

const SCOPE = Object.freeze({
  continuityId: "continuity-authored-budget",
  sessionId: "session-authored-budget",
  surface: "game" as const,
  threadId: "thread-authored-budget",
  profile: Object.freeze({ profileId: "profile-authored-budget", revision: 1, canonicalHash: "a".repeat(64) }),
});

/** The shipped persona is deliberately NOT a parameter: it is inside `floorTokens` (see below). */
/** Materialize one book through the product's own catalogue builder, exactly as a mount does. */
function materializeBook(rawBook: unknown) {
  const book = validateWorldBook(rawBook);
  return buildGameSurfaceAuthoredCatalog(
    SCOPE,
    {
      book,
      metadata: { worldBookId: book.worldBookId, revision: book.revision, canonicalHash: "b".repeat(64) },
    } as never,
    { char: DEFAULT_COMPANION_PRESET.profile.identity.name },
    {
      scenarioId: "scenario-default-companion",
      revision: 1,
      canonicalHash: "c".repeat(64),
      text: DEFAULT_COMPANION_PRESET.scenario ?? "",
    },
  );
}

/** The shipped reading: the shipped preset's own book and scenario. */
function shippedReading() {
  return measureGameSurfaceAuthoredContextBudget(materializeBook(DEFAULT_COMPANION_PRESET.worldBook));
}

test("the shipped book is measured from the asset that ships, and the committed asset agrees", () => {
  // `DEFAULT_COMPANION_PRESET.worldBook` is the shipped artifact; the asset is its source. Both go
  // through the SAME product builder, so a disagreement is about the book, not about rendering.
  const shipped = shippedReading();
  const committed = measureGameSurfaceAuthoredContextBudget(materializeBook(committedWorldBook()));
  assert.deepEqual(
    shipped.stable.rows.map((row) => [row.kind, row.contentChars, row.tokens]),
    committed.stable.rows.map((row) => [row.kind, row.contentChars, row.tokens]),
    "the shipped preset's stable sources are no longer the committed world book's; " +
      "regenerate the preset with host/scripts/compile-default-companion-preset.mjs --committed",
  );
  assert.equal(
    shipped.volatile.tokens,
    committed.volatile.tokens,
    "the shipped and committed books disagree on volatile size",
  );
});

test("the companion's persona is counted ONCE, inside the floor, never as authored context", () => {
  // The defect this asserts against: `identity-profile.ts` renders the persona INTO the system
  // prompt (L214-220: `Core disposition:` / `Interaction style:` / `Expression style:`), and the
  // Game floor reading is a measurement of that assembled prompt — so the persona's cost is already
  // inside `floorTokens`. Counting it again as an authored source would inflate the authored total by
  // the whole persona (830 + 48 characters, more than the shipped book itself) and make a guard built
  // on this reading refuse cards that fit.
  //
  // Compared MACRO-RENDERED, through the profile's own table: since 350ec7e1 (2026-11-03) the shipped
  // card writes `{{char}}`/`{{user}}` inside `persona.core`, so the raw field stopped being a
  // substring of any prompt while the rendered one is what the model reads, exactly once.
  // `identity-profile.test.ts` owns the rendering contract; `authored-context-budget-gate.test.ts`
  // owns it for every field the preset declares. This test owns only that the floor carries the
  // persona and the authored reading does not.
  const profile = DEFAULT_COMPANION_PRESET.profile;
  const prompt = buildGameCompanionSystemPrompt(profile, "zh-CN");
  const persona = profile.persona;
  assert.ok(persona !== undefined, "the shipped profile lost its persona, so this premise is void");
  const macros = identityProfileMacros(profile, "zh-CN");
  assert.ok(
    prompt.includes(renderMacros(persona.core ?? "\u0000", macros)),
    "persona.core is no longer rendered into the system prompt; if that changed, the floor no longer " +
      "carries it and the authored sum WOULD have to count it",
  );
  assert.ok(
    prompt.includes(renderMacros(persona.interactionStyle ?? "\u0000", macros)),
    "persona.interactionStyle is no longer rendered into the system prompt",
  );
  // And the reading itself carries no persona row, because there is no authored persona source:
  // `kind` is the catalogue's own field, `sourceId` is the artifact's id and would never be "persona".
  const reading = shippedReading();
  assert.equal(
    reading.stable.rows.some((row) => row.kind === "persona"),
    false,
    "the reading added a persona row, which double-counts what floorTokens already contains",
  );
  // The system prompt the floor measured is the same one this test just built.
  assert.equal(
    prompt.length,
    GAME_SURFACE_PROMPT_FLOOR.floor.systemChars,
    "the system prompt changed size, so the recorded floor no longer describes it",
  );
});

test("every authored figure is the product's own ceil(chars / 4), recomputed from the content", () => {
  // The rows carry a token count; the content is what decides it. Recomputing here is what makes
  // this a measurement rather than a table someone can edit.
  const reading = shippedReading();
  assert.ok(reading.stable.rows.length > 0, "the shipped book produced no stable sources at all");
  for (const row of reading.stable.rows) {
    assert.equal(
      row.tokens,
      Math.ceil(row.contentChars / 4),
      `${row.kind}/${row.sourceId} records ${row.tokens} tokens for ${row.contentChars} characters`,
    );
    assert.ok(row.contentChars > 0, `${row.kind}/${row.sourceId} is recorded with no content`);
  }
  assert.equal(
    reading.stable.tokens,
    reading.stable.rows.reduce((total, row) => total + row.tokens, 0),
    "the stable total is not the sum of its rows",
  );
  assert.equal(reading.total.authoredTokens, reading.stable.tokens + reading.volatile.tokens);
  assert.equal(
    reading.total.inputTokens,
    reading.total.floorTokens + reading.total.historyTokens + reading.total.authoredTokens,
  );
});

test("the geometry is derived from the product's function, not written down here", () => {
  const geometry = shippedAuthoredContextGeometry();
  assert.equal(geometry.window, 32_768);
  assert.equal(geometry.outputReserve, 8_192);
  // shared_upfront: the reserve is carved out of the same window the input has to fit in.
  assert.equal(geometry.usableSoft, geometry.window - geometry.outputReserve);
  const reading = shippedReading();
  assert.equal(reading.geometry.usableSoft, geometry.usableSoft);
  assert.equal(
    reading.total.headroomTokens,
    reading.geometry.usableSoft - reading.floor.envelopeTokens - reading.history.tokens - reading.total.authoredTokens,
  );
});

const HISTORY_SHARE = 0.15;
const EXECUTE_THRESHOLD = 65;

test("the history budget is the historian's own formula, floored once", () => {
  // Magic Context sizes <session-history> from the usable window; that budget occupies the same
  // m[0] head the authored block rides, so it is subtracted before the crossing is computed.
  const geometry = shippedAuthoredContextGeometry();
  const expected = Math.floor(geometry.usableSoft * (EXECUTE_THRESHOLD / 100) * HISTORY_SHARE);
  assert.equal(deriveHistoryBudgetTokens(geometry.usableSoft), expected);
  // Applied in order then floored once — not floored at each step, which would drift.
  const reading = shippedReading();
  assert.equal(reading.history.tokens, expected);
  assert.ok(reading.history.tokens > 0, "a zero history budget means authored context was given its whole share");
  assert.equal(reading.total.historyTokens, reading.history.tokens);
});

test("the shipped book leaves most of the window free, and the crossing point says how much room is left", () => {
  // The reading is only worth committing if it answers "how big can a player's own context get".
  // Both halves of that answer are asserted: the shipped book fits comfortably, and the crossing is
  // the authored size at which floor + history + authored text reaches usableSoft.
  const reading = shippedReading();
  assert.ok(
    reading.total.headroomTokens > 0,
    `the shipped book does not fit: ${reading.total.inputTokens} tokens against ${reading.geometry.usableSoft} usable`,
  );
  assert.equal(
    reading.crossing.authoredTokens,
    reading.geometry.usableSoft - reading.floor.envelopeTokens - reading.history.tokens,
  );
  // The curve sweeps the same arithmetic, so every point at or past the crossing must show no
  // headroom. That is the shape a guard has to speak in.
  assert.ok(
    reading.curve.every(
      (point) => point.totalTokens === reading.total.floorTokens + reading.total.historyTokens + point.authoredTokens,
    ),
    "a curve point's total is not the floor plus history plus its authored size",
  );
  const pastCrossing = reading.curve.filter((point) => point.authoredTokens >= reading.crossing.authoredTokens);
  assert.ok(pastCrossing.length > 0, "the curve stops before the crossing, so it never shows the overrun");
  for (const point of pastCrossing)
    assert.ok(
      point.headroomTokens <= 0,
      `the curve's ${point.authoredTokens}-token point claims ${point.headroomTokens} tokens of headroom at or past the crossing`,
    );
});

test("the shipped book's stable half is bounded today by nothing", () => {
  // The defect as an assertion: the stable sum is allowed past the volatile ceiling.
  // `MAX_AUTHORED_VOLATILE_BUDGET_TOKENS` is 32,768 and the volatile half is refused past it; the
  // stable half has only a per-source `budgetTokens > 0`.
  const reading = shippedReading();
  assert.ok(
    reading.stable.tokens > 0,
    "the shipped book contributes no always-on stable text, so this reading measures nothing",
  );
  // The crossing is the real bound: authored text past it cannot fit even with an empty transcript.
  // It is smaller than the volatile ceiling, which is what makes a volatile-only guard insufficient.
  assert.ok(
    reading.crossing.authoredTokens < 32_768,
    `authored context crosses usableSoft at ${reading.crossing.authoredTokens} tokens, which is not below the ` +
      "32,768 volatile ceiling; the two bounds would have to be reconciled before either can be trusted",
  );
});

test("authoredTokensFor is ceil(chars / 4) and is the unit the whole reading uses", () => {
  // Boundary: an empty string costs nothing, one character already costs one token, and the ratio
  // is per-source so it never rounds a source to zero.
  assert.equal(authoredTokensFor(""), 0);
  assert.equal(authoredTokensFor("a"), 1);
  assert.equal(authoredTokensFor("abcd"), 1);
  assert.equal(authoredTokensFor("abcde"), 2);
  // The unit is a character ratio, so CJK prose — what a shipped card is written in — is measured
  // at the same rate as ASCII. Asserted because it is the estimation's known limit, not an
  // accident: it makes every authored figure a lower bound, never an upper one.
  assert.equal(authoredTokensFor("你好世界"), authoredTokensFor("abcd"));
});

test("the worst-case stable book the product accepts does not fit, and the reading says so", () => {
  // The shipped book is a few hundred characters of always-on prose. The product accepts far more:
  // the world-book validator bounds ONE entry's content and a book's entry count, and both bounds
  // are DISCOVERED by asking that validator (see `largestAcceptedEntryChars` / `largestAcceptedEntryCount`)
  // rather than restated here. A book at its own limits is accepted, materializes as ONE
  // `lorebook_constant` stable source, and is far past the crossing — while the volatile half of
  // the same book is summed and refused past 32,768. That gap is the defect.
  const reading = shippedReading();
  const largestEntryChars = largestAcceptedEntryChars();
  const largestEntryCount = largestAcceptedEntryCount();
  const maximalBookChars = largestEntryChars * largestEntryCount;
  const maximalBookTokens = authoredTokensFor("x".repeat(maximalBookChars));
  assert.ok(
    maximalBookTokens > reading.crossing.authoredTokens,
    `a book at the validator's limits (${largestEntryChars} chars x ${largestEntryCount} entries = ` +
      `${maximalBookChars} chars, ${maximalBookTokens} tokens) no longer crosses usableSoft ` +
      `(${reading.crossing.authoredTokens} authored tokens), so this measurement no longer describes a risk`,
  );
  // A single maximal entry is already a large share of the room, and a handful cross it outright.
  const entriesToCross = Math.ceil(reading.crossing.authoredTokens / authoredTokensFor("x".repeat(largestEntryChars)));
  assert.ok(
    entriesToCross > 0 && entriesToCross <= largestEntryCount,
    `${entriesToCross} maximal entries cross usableSoft, which is outside the ${largestEntryCount} a book may hold`,
  );
  // The last figure the report quotes: how much authored text still fits, in characters.
  assert.equal(reading.crossing.authoredChars, reading.crossing.authoredTokens * 4);
});
