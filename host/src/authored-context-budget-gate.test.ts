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
import { buildGameCompanionSystemPrompt, identityProfileMacros } from "./identity-profile.js";
import { buildGameSurfaceAuthoredCatalog } from "./tavern/catalog-service.js";
import { DEFAULT_COMPANION_PRESET } from "./tavern/default-companion-preset.js";
import { renderMacros } from "./tavern/macro-engine.js";
import { validateWorldBook } from "./worldbook.js";

/**
 * THE INVARIANT THE GUARD ENFORCES, ASSERTED WHERE IT CAN BE SEEN.
 *
 * <p>
 * The guard itself lives at prompt-build time, in the vendored Magic Context
 * (`packages/pi-plugin/src/gamebuddy-authored-context-budget.ts`), because that is the only place all
 * four terms of this inequality exist together for the request actually being sent. What that
 * module cannot do is prove the PRODUCT still satisfies the inequality at the shipped geometry —
 * it refuses at runtime, it does not audit the card. This file is the gate:
 * </p>
 *
 * ```
 * floorTokens + historyBudgetTokens + authoredTotalTokens <= usableSoft
 * ```
 *
 * <p>
 * Every term is derived, not typed. `usableSoft` comes from the recorded denominator (the same
 * number the prompt-floor reading and the vendored guard both use); the floor from that reading's
 * own parts; the history budget from the historian's formula over that window; the authored total
 * from the product's catalogue materializer and its `ceil(chars / 4)` unit. A change to any of them
 * moves the inequality, and this gate says which term moved.
 * </p>
 *
 * <p>
 * **The gate is written to fail for the class, not for the shipped card.** The shipped card has
 * ~13,000 tokens of headroom and will not cross by accident; a gate that only checked it would be
 * green forever. So the population is every book the product's own validator ACCEPTS, sampled at
 * its limits — discovered by asking the validator, not restated — and the assertion is that the
 * guard refuses each of those and admits the shipped one. If a future change made the authored
 * bound unreachable, or the validator permissive enough to accept a book the window cannot hold
 * without the guard noticing, this goes red.
 * </p>
 */

const HERE = dirname(fileURLToPath(import.meta.url));

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

/** The locale the shipped Game session runs under; `game-surface-prompt-floor.test.ts` measures at the same one. */
const GAME_LOCALE = "zh-CN";

const SCOPE = Object.freeze({
  continuityId: "continuity-authored-gate",
  sessionId: "session-authored-gate",
  surface: "game" as const,
  threadId: "thread-authored-gate",
  profile: Object.freeze({ profileId: "profile-authored-gate", revision: 1, canonicalHash: "a".repeat(64) }),
});

/** One valid world-book entry at a caller-chosen size; the rest is the minimum the validator takes. */
function worldBookEntry(index: number, contentChars: number, constant: boolean): Record<string, unknown> {
  return {
    entryId: `gate-entry-${index}`,
    title: "gate",
    content: "x".repeat(contentChars),
    scope: "setting",
    provenance: "authored",
    tokenBudget: "small",
    ...(constant ? { constant: true } : { keys: ["gate"] }),
  };
}

function worldBookOf(entries: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { schemaVersion: 1, worldBookId: "gate-world-book", revision: 1, alwaysOnPremise: "", entries };
}

/** The largest entry content the validator keeps, discovered by asking it. */
function largestAcceptedEntryChars(): number {
  const accepted = (chars: number): boolean => {
    try {
      validateWorldBook(worldBookOf([worldBookEntry(0, chars, true)]));
      return true;
    } catch {
      return false;
    }
  };
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

/** The largest entry count the validator keeps, discovered by asking it. */
function largestAcceptedEntryCount(): number {
  const accepted = (count: number): boolean => {
    try {
      validateWorldBook(worldBookOf(Array.from({ length: count }, (_, index) => worldBookEntry(index, 1, false))));
      return true;
    } catch {
      return false;
    }
  };
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

/** Materialize one book through the product's own catalogue builder. */
function materialize(rawBook: unknown) {
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

/**
 * The inequality, over one materialized catalogue. Returns the reading plus the verdict, so a
 * failure can name every term rather than just "false".
 *
 * <p>
 * The sum is taken HERE from the three named terms rather than read off `total.inputTokens`. That is
 * deliberate: reading the convenience field would make the gate blind to that field disagreeing with
 * the terms it is supposed to be the sum of — dropping the history term from it left the gate green,
 * which is exactly the asymmetry this whole change exists to fix. The field is then cross-checked
 * against the sum, so a divergence fails loudly instead of hiding.
 * </p>
 */
function evaluate(rawBook: unknown) {
  const reading = measureGameSurfaceAuthoredContextBudget(materialize(rawBook));
  const summed = reading.total.floorTokens + reading.total.historyTokens + reading.total.authoredTokens;
  return {
    reading,
    summed,
    /** `floorTokens + historyBudgetTokens + authoredTotalTokens <= usableSoft`, exactly. */
    holds: summed <= reading.geometry.usableSoft,
    describe: () =>
      `floor=${reading.total.floorTokens} + history=${reading.total.historyTokens} + ` +
      `authored=${reading.total.authoredTokens} = ${summed} against usableSoft=` +
      `${reading.geometry.usableSoft} (window ${reading.geometry.window}, reserve ` +
      `${reading.geometry.outputReserve}); authored budget is ${reading.crossing.authoredTokens} tokens ` +
      `(${reading.crossing.authoredChars} chars)`,
  };
}

test("the shipped card satisfies the invariant, with the headroom the reading records", () => {
  const { reading, summed, holds, describe } = evaluate(DEFAULT_COMPANION_PRESET.worldBook);
  assert.ok(holds, `the shipped card does not fit: ${describe()}`);
  // The convenience field must be the sum of the three named terms, or one of them is not being
  // counted by the code a guard would actually read.
  assert.equal(
    reading.total.inputTokens,
    summed,
    `the reading's inputTokens (${reading.total.inputTokens}) is not floor + history + authored (${summed})`,
  );
  // The headroom is not incidental: it is what the guard leaves a player to spend.
  assert.equal(reading.total.headroomTokens, reading.geometry.usableSoft - summed);
  assert.ok(reading.total.headroomTokens > 0, `the shipped card leaves no headroom at all: ${describe()}`);
});

test("the invariant's terms are each derived, and none is a copied number", () => {
  const { reading } = evaluate(DEFAULT_COMPANION_PRESET.worldBook);
  const geometry = shippedAuthoredContextGeometry();
  // usableSoft: from the recorded denominator, which is the window minus the reserve.
  assert.equal(reading.geometry.usableSoft, geometry.usableSoft);
  assert.equal(reading.geometry.usableSoft, reading.geometry.window - reading.geometry.outputReserve);
  // floor: the envelope reading, and its parts must agree with it.
  assert.equal(
    reading.total.floorTokens,
    reading.floor.systemTokens + reading.floor.toolDefinitionTokens + reading.floor.envelopeOverheadTokens,
  );
  // history: the historian's formula over the same window, and it must be a real term of the sum.
  assert.equal(reading.total.historyTokens, deriveHistoryBudgetTokens(reading.geometry.usableSoft));
  assert.ok(reading.total.historyTokens > 0, "a zero history budget means history was not counted");
  // authored: the product's own ceil(chars / 4) over every source the catalogue carries.
  assert.equal(reading.total.authoredTokens, reading.stable.tokens + reading.volatile.tokens);
  for (const row of reading.stable.rows) assert.equal(row.tokens, authoredTokensFor("x".repeat(row.contentChars)));
});

test("a book at the validator's own limits breaks the invariant, which is why the guard exists", () => {
  // RED CASE, on the real defect class. The product ACCEPTS this book — the validator is asked and
  // says yes — and the authored sum alone is orders of magnitude past the window. Before the guard
  // nothing refused it; it surfaced as a storage error.
  const largestEntry = largestAcceptedEntryChars();
  const largestCount = largestAcceptedEntryCount();
  const maximalBook = worldBookOf(
    Array.from({ length: largestCount }, (_, index) => worldBookEntry(index, largestEntry, true)),
  );
  // The validator accepts it, so this is a book the product can actually be handed.
  assert.doesNotThrow(() => validateWorldBook(maximalBook), "the validator now refuses a book at its own limits");
  const { reading, holds, describe } = evaluate(maximalBook);
  assert.equal(
    holds,
    false,
    `a maximal book should break floor + history + authored <= usableSoft, but it held: ${describe()}`,
  );
  // The failure names the authored total, the headroom and the window, so the next reader knows
  // which term to look at.
  assert.ok(
    reading.total.authoredTokens > reading.crossing.authoredTokens,
    `authored ${reading.total.authoredTokens} did not exceed the authored budget ` +
      `${reading.crossing.authoredTokens} (headroom ${reading.total.headroomTokens}, window ` +
      `${reading.geometry.usableSoft})`,
  );
});

test("the authored total crosses before either half's own ceiling does", () => {
  // The asymmetry that made a per-half bound insufficient, asserted as a relation between the two
  // numbers rather than as prose: the window's authored room is SMALLER than the volatile ceiling,
  // so a catalogue can be within every per-half limit and still not fit.
  const { reading } = evaluate(DEFAULT_COMPANION_PRESET.worldBook);
  const volatileCeiling = 32_768;
  assert.ok(
    reading.crossing.authoredTokens < volatileCeiling,
    `the authored room (${reading.crossing.authoredTokens}) is not below the volatile ceiling ` +
      `(${volatileCeiling}); if it ever is, a per-half bound would suffice and this gate's premise changed`,
  );
});

test("the gate's own population is the validator's limits, not a list someone maintains", () => {
  // A gate whose population is hand-written can only catch what its author remembered. These two
  // numbers are discovered by binary-searching the validator, so a change to the bound moves them.
  const largestEntry = largestAcceptedEntryChars();
  const largestCount = largestAcceptedEntryCount();
  assert.ok(largestEntry > 0, "the validator accepts no entry content at all");
  assert.ok(largestCount > 0, "the validator accepts no entries at all");
  // One past each bound must be refused, or the search found the wrong edge.
  assert.throws(
    () => validateWorldBook(worldBookOf([worldBookEntry(0, largestEntry + 1, true)])),
    "the validator accepted one character past the largest entry it accepts",
  );
  assert.throws(
    () =>
      validateWorldBook(
        worldBookOf(Array.from({ length: largestCount + 1 }, (_, index) => worldBookEntry(index, 1, false))),
      ),
    "the validator accepted one entry past the largest count it accepts",
  );
});

test("the committed world book is the same book the gate measured", () => {
  // The gate must not be satisfiable by a preset that drifted from the asset. Both go through the
  // same product builder; a disagreement is about the book, not about rendering.
  const spec = "HEAD:assets/tavern/presets/default-companion/worldbook.json";
  let committed: unknown;
  try {
    committed = JSON.parse(execFileSync("git", ["show", spec], { cwd: ROOT, encoding: "utf8" }));
  } catch (error) {
    throw new Error(
      `committed_asset_unreadable: git could not show ${spec} (${error instanceof Error ? error.message : String(error)}); ` +
        "reading the file on disk would measure whatever a lane has in flight",
    );
  }
  const shipped = evaluate(DEFAULT_COMPANION_PRESET.worldBook);
  const fromAsset = evaluate(committed);
  assert.deepEqual(
    shipped.reading.stable.rows.map((row) => [row.kind, row.contentChars, row.tokens]),
    fromAsset.reading.stable.rows.map((row) => [row.kind, row.contentChars, row.tokens]),
    "the shipped preset's stable sources are no longer the committed world book's",
  );
  assert.equal(shipped.holds, fromAsset.holds);
});

/**
 * THE PERSONA THE SHIPPED PRESET DECLARES IS RENDERED BY THE FLOOR, EXACTLY ONCE, AND BY NOTHING ELSE.
 *
 * <p>
 * The whole authored reading rests on one premise: `identity-profile.ts` renders the card's persona
 * into the system prompt (L214-220), so the persona's cost is inside `floorTokens` and must never be
 * counted again as an authored source. `authored-context-budget.test.ts` states that for the shipped
 * fields; this is the gate for the class. The population is every field the preset's own `persona`
 * declares, discovered from the object rather than listed here, so a field a later `IdentityProfile`
 * adds reaches this assertion the moment the preset writes one.
 * </p>
 *
 * <p>
 * Each field must appear exactly ONCE across (system prompt + every authored source). Nowhere means
 * the prompt stopped rendering what the card declares, and twice means the reading double-counts a
 * persona the floor already carries; both fail by name as `persona_field_<state>:<field>`. Zero
 * population is a blocked reading rather than a pass, because a preset with no persona makes every
 * count here agree with itself.
 * </p>
 *
 * <p>
 * Compared MACRO-RENDERED through the profile's own table, the one `renderIdentityProfile` uses: since
 * 350ec7e1 (2026-11-03) the shipped card writes `{{char}}`/`{{user}}` inside `persona.core`, and a
 * raw-substring comparison would report the field missing while the prompt renders it perfectly.
 * </p>
 */
test("every persona field the preset declares is rendered exactly once, by the floor and never by the authored sum", () => {
  const profile = DEFAULT_COMPANION_PRESET.profile;
  const persona = profile.persona;
  const declared: [string, string][] =
    persona === undefined
      ? []
      : Object.entries(persona).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  // Zero population is blocked, never green: nothing examined agrees with itself.
  assert.ok(
    declared.length > 0,
    "persona_fields_examined_zero: the shipped preset declares no persona field, so this gate measures nothing",
  );
  const prompt = buildGameCompanionSystemPrompt(profile, GAME_LOCALE);
  const macros = identityProfileMacros(profile, GAME_LOCALE);
  const catalog = materialize(DEFAULT_COMPANION_PRESET.worldBook);
  const authored = [...catalog.stableSources, ...catalog.volatileSources].map((source) => source.content);
  const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

  const states = declared.map(([field, text]) => {
    const rendered = renderMacros(text, macros);
    const inFloor = occurrences(prompt, rendered);
    const asAuthored = authored.reduce((total, content) => total + occurrences(content, rendered), 0);
    return { field, inFloor, asAuthored, total: inFloor + asAuthored };
  });
  process.stdout.write(
    `persona fields examined ${states.length} · rendered in floor ${states.filter((state) => state.inFloor > 0).length} ` +
      `· counted as authored ${states.filter((state) => state.asAuthored > 0).length} ` +
      `· missing ${states.filter((state) => state.total === 0).length}\n`,
  );
  const violations = states.flatMap((state) => [
    ...(state.total === 0
      ? [`persona_field_missing:${state.field} (in neither the system prompt nor any authored source)`]
      : []),
    ...(state.total > 1
      ? [`persona_field_double_counted:${state.field} (floor ${state.inFloor} + authored ${state.asAuthored})`]
      : []),
  ]);
  assert.deepEqual(
    violations,
    [],
    `a persona field is no longer rendered exactly once, by the floor: ${violations.join(" | ")}. Rendered nowhere ` +
      "means the system prompt stopped carrying what the card declares; counted twice means the authored sum " +
      "double-counts a persona `floorTokens` already contains.",
  );
});
