/**
 * The player's directive for one world day: the one thing the companion may treat as authorized work today.
 *
 * WHY THIS MODULE EXISTS. Measured 2026-11-10 (`round44`, live session 03:40-04:01, 373 JSONL lines and 15
 * compactions): the day's note reached the model ONCE, as an ordinary `player_text`. At the first turn after it the
 * emitted context held 144 carriers of which **33 described the work the note had superseded**; by 04:00:18 the note's
 * own words had **0** carriers and only a compaction's paraphrase survived, which the next summary replaced with
 * yesterday's plan. Twenty-five plan submissions followed, none about the note. Recency and frequency were not the
 * defect: the note's sentence appeared once and so did the older plan's. The defect was that the older plan was
 * **state** - a snapshot, receipts, a running programme, every turn - while the note was an utterance with no field
 * that said "this is what today is for". This module is the field.
 *
 * THE RECORD HAS NO CLOCK (`issuedAtMs` is deliberately absent). What the model can act on is "is this today", not
 * "how long ago"; a second time source beside `worldDay` is a second truth that can disagree with the calendar the
 * snapshot publishes.
 *
 * `worldDay` IS THE SNAPSHOT'S OWN TRIPLE - `{year, seasonIndex, dayOfMonth}` (`protocol.ts:307-310`, the values the
 * model reads every turn as `Season/Day/Year`). It is NOT `day_started.payload.day`, which is `Game1.Date.TotalDays`
 * and a different scale; `round44` had `dayOfMonth=6` and `TotalDays=5` in one session's context at the same moment,
 * and this module does not add a third.
 *
 * `state` IS THE ONLY PREDICATE: `state === "current"` means "today may be planned from it". The day boundary is a
 * transition on that field (`expireForWorldDay`), never a second comparison beside it, so a reader has one input.
 *
 * OWNERSHIP. The record - including the player's words - lives in the Host and only for the current Game session
 * (never persisted across a Host restart: a reconnect does not restore AI authority, so it must not restore the
 * authority's text). The Mod is given nothing but an opaque `(directiveId, directiveWorldDay)` stamp on a plan, and
 * that stamp is not on the wire in this unit at all - see `protocol.ts` `bodyProgramCandidateWire`.
 */

import { MAX_CONTROL_TEXT_BYTES } from "./companion-control-protocol.js";

/** The snapshot's calendar triple: the one spelling of "which day" the model already reads every turn. */
export type WorldDay = Readonly<{ year: number; seasonIndex: number; dayOfMonth: number }>;

export type GameDirectiveState = "current" | "superseded" | "expired";

/**
 * One player directive.
 *
 * `supersedes` names the directive it replaced (`null` when it replaced nothing), so a plan stamped with the older id
 * and a batch carrying the newer one are visibly different without any instruction to prefer the newer.
 */
export type GameDirective = Readonly<{
  directiveId: string;
  /** The player's own words, bounded by the same limit every authenticated player text already obeys. */
  text: string;
  worldDay: WorldDay;
  supersedes: string | null;
  state: GameDirectiveState;
}>;

/** The byte bound a directive's text obeys: the control protocol's own player-text limit, not a second one. */
export const MAX_DIRECTIVE_TEXT_BYTES = MAX_CONTROL_TEXT_BYTES;

/** The one token for "there was no population to divide by" (see `DirectiveReading`). */
const NOT_MEASURED = "not_measured" as const;

/**
 * The world day a snapshot payload states, or `null` when it states none.
 *
 * Read off `{year, seasonIndex, dayOfMonth}` only, and `null` for anything else: a partially-read calendar is not a
 * day, and rounding three integers into one would let the Host decide the day boundary from a field the world did not
 * publish. Zero is a VALUE (year 0 is nonsense but a day 0 exists in the Mod's own winter), so the check is
 * `Number.isInteger`, not truthiness.
 */
export function worldDayFrom(source: unknown): WorldDay | null {
  if (typeof source !== "object" || source === null) return null;
  const record = source as Record<string, unknown>;
  const year = record.year;
  const seasonIndex = record.seasonIndex;
  const dayOfMonth = record.dayOfMonth;
  if (!Number.isInteger(year) || !Number.isInteger(seasonIndex) || !Number.isInteger(dayOfMonth)) return null;
  return Object.freeze({ year: year as number, seasonIndex: seasonIndex as number, dayOfMonth: dayOfMonth as number });
}

/** Whether two triples name the same world day. */
export function sameWorldDay(left: WorldDay, right: WorldDay): boolean {
  return left.year === right.year && left.seasonIndex === right.seasonIndex && left.dayOfMonth === right.dayOfMonth;
}

/**
 * Cut one directive's text to the bound every player text already obeys, on a code-point boundary.
 *
 * Truncation is a loss and is NOT reported as anything else: the record says what the Host would act on, and the
 * caller can compare its own text with the record's. A partial code point would make the record's text an invalid
 * string, which is why the cut walks code points instead of bytes.
 */
export function directiveText(text: string): string {
  const trimmed = text.trim();
  if (Buffer.byteLength(trimmed, "utf8") <= MAX_DIRECTIVE_TEXT_BYTES) return trimmed;
  let used = 0;
  let out = "";
  for (const character of trimmed) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > MAX_DIRECTIVE_TEXT_BYTES) break;
    used += bytes;
    out += character;
  }
  return out;
}

/** The current directive for a world day, replacing `supersedes` if it named one. */
export function issueDirective(
  input: Readonly<{ directiveId: string; text: string; worldDay: WorldDay; supersedes: GameDirective | null }>,
): GameDirective {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.directiveId)) throw new Error("invalid_directive_id");
  const text = directiveText(input.text);
  if (text.length === 0) throw new Error("empty_directive_text");
  return Object.freeze({
    directiveId: input.directiveId,
    text,
    worldDay: Object.freeze({ ...input.worldDay }),
    supersedes: input.supersedes?.directiveId ?? null,
    state: "current",
  });
}

/**
 * The same record, no longer authorized.
 *
 * A record that is already superseded or expired is returned unchanged: this is a state transition with one
 * destination, so calling it twice cannot make an old directive look newly retired.
 */
export function supersedeDirective(directive: GameDirective): GameDirective {
  if (directive.state !== "current") return directive;
  return Object.freeze({ ...directive, state: "superseded" });
}

/**
 * The same record, expired by the world moving to another day.
 *
 * `state === "current"` and a different day is the whole rule (§6.1: the day boundary is written into the state, so a
 * reader never has to compare a second field). There is no automatic renewal: the note itself says tomorrow has other
 * things in it, and a plan carried across a night would be yesterday's authorization spending today's world.
 */
export function expireForWorldDay(directive: GameDirective, worldDay: WorldDay): GameDirective {
  if (directive.state !== "current" || sameWorldDay(directive.worldDay, worldDay)) return directive;
  return Object.freeze({ ...directive, state: "expired" });
}

/** The id a plan may be planned from today, or `null` when no directive authorizes anything right now. */
export function currentDirectiveIdOf(directive: GameDirective | null): string | null {
  return directive?.state === "current" ? directive.directiveId : null;
}

/**
 * The fields the HOST fills on a plan candidate, and the model cannot.
 *
 * A candidate that carries one of these is claiming the player authorized it, which is the one claim this module
 * exists to keep out of a model's reach: hence `hostOwnedStampField` names the field rather than refusing the frame as
 * generically malformed - a caller that guessed the shape should be told which guess was the wrong one.
 */
export const HOST_OWNED_STAMP_FIELDS: readonly string[] = Object.freeze(["directiveId", "directiveWorldDay"]);

/** The host-owned stamp field a submitted candidate carries, or `null` when it carries none. */
export function hostOwnedStampField(source: unknown): string | null {
  if (typeof source !== "object" || source === null) return null;
  return HOST_OWNED_STAMP_FIELDS.find((field) => Object.hasOwn(source, field)) ?? null;
}

/** What a plan was admitted under: the directive id, and the day it was current on. */
export type ProgramDirectiveStamp = Readonly<{ directiveId: string | null; directiveWorldDay: WorldDay | null }>;

/** No directive authorized the plan: her own decision, which no day boundary revokes (§6.3). */
export const NO_DIRECTIVE_STAMP: ProgramDirectiveStamp = Object.freeze({
  directiveId: null,
  directiveWorldDay: null,
});

/**
 * What a plan-admission site needs from the Host's ledger, bound once the Host service exists.
 *
 * The tools are built inside runtime construction, before `CompanionHostService` exists, so the seam is a stable object
 * whose methods dereference a variable bound later - the same shape the settled digest already uses for its route onto
 * the pump. Unbound, a candidate is stamped `null`: an honest "no directive authorized this" for a session that could
 * not have issued one yet.
 */
export type ProgramDirectiveSeam = Readonly<{
  stamp(programId: string): ProgramDirectiveStamp;
  read(programId: string): ProgramDirectiveStamp;
  settle(programId: string): void;
}>;

export const UNBOUND_PROGRAM_DIRECTIVE_SEAM: ProgramDirectiveSeam = Object.freeze({
  stamp: () => NO_DIRECTIVE_STAMP,
  read: () => NO_DIRECTIVE_STAMP,
  settle: () => undefined,
});

/**
 * The Host's `programId -> directiveId` ledger, as one reading.
 *
 * `stamps` carries `null` for a plan admitted with no directive, so "she decided this herself" and "the ledger never
 * heard of this program" are different answers (`plans` vs `none` in `my_work`).
 */
export type ProgramDirectiveLedger = Readonly<{
  currentDirectiveId: string | null;
  stamps: ReadonlyMap<string, string | null>;
}>;

/**
 * Where a reader that is not the Host's own service finds the ledger.
 *
 * The stamp map is state and is owned in exactly one place (`CompanionHostService`). This is the reader seam for the
 * observation tools, which are built inside runtime construction long before that service exists
 * (`runtime-core.internal.ts:1946`), so the materializer binds the reader onto the one identity both sides already
 * share - the authenticated connection object, the same key the launcher's own authentication map uses
 * (`authenticatedStardewConnections`). A reader, not the fact: the map still lives in one place, and a session that
 * never binds one answers `not_measured` rather than an empty ledger.
 */
const directiveLedgerReaders = new WeakMap<object, () => ProgramDirectiveLedger | undefined>();

/** Bind (or replace) the ledger reader for one live connection. */
export function bindProgramDirectiveLedger(connection: object, read: () => ProgramDirectiveLedger | undefined): void {
  directiveLedgerReaders.set(connection, read);
}

/** The ledger bound to this connection, or `undefined` when nothing was ever bound to it. */
export function programDirectiveLedgerFor(connection: object): ProgramDirectiveLedger | undefined {
  return directiveLedgerReaders.get(connection)?.();
}

/**
 * One ratio, or the reason there is no ratio.
 *
 * `not_measured` is not zero: a denominator of zero agrees with itself, so publishing `0/0` as green would report a
 * structural guarantee nobody measured. `missingField` names the population that was empty, in the same dotted form
 * `game-lookup.ts` answers `my_work` with (`BodyProgramJournal.program.day`).
 */
export type DirectiveReading =
  | Readonly<{ state: "measured"; numerator: number; denominator: number; value: number }>
  | Readonly<{ state: typeof NOT_MEASURED; missingField: string }>;

/**
 * What the directive authority is worth on the evidence it actually produced (§6.7, DAR).
 *
 * - `presence` - of the turns this Host delivered, how many carried a directive block. Structural: the pump
 *   re-serialises the record into every batch, so this is a measurement that a structural guarantee still holds, not a
 *   hope. It counts TURNS (`flush` deliveries, the batches that start an assistant turn), not steers.
 * - `alignment` - of the plans submitted, how many were admitted under the directive that is current NOW. Its
 *   denominator is every plan, including plans admitted with no directive: `round44` read `0 of 25` for exactly that
 *   reason, and an empty denominator is `not_measured` rather than a perfect score.
 * - `plansUnderCurrent` / `plansUnderRetired` / `plansWithoutDirective` partition the same population, so a retired
 *   plan is visible by name and never by subtracting two other numbers.
 * - `staleWork` - retired-stamped plans that have not settled: the ones a later unit refuses at admission. It is a
 *   subset of `plansUnderRetired`, not a second spelling of it. Its population is every plan the Host stamped, which
 *   includes a candidate the Mod then refused: such a plan never settles, so it is counted as outstanding work that may
 *   not exist. That is the safe direction for a reading - it can report more stale work than there is, never a clean
 *   zero over work that was never accounted for.
 */
export type DirectiveAlignment = Readonly<{
  presence: DirectiveReading;
  alignment: DirectiveReading;
  plansUnderCurrent: number;
  plansUnderRetired: number;
  plansWithoutDirective: number;
  staleWork: number;
}>;

/** One plan's stamp, as the ledger holds it: what authorized it, and whether its ledger has been announced. */
export type DirectiveStampRow = Readonly<{ directiveId: string | null; settled: boolean }>;

/**
 * The alignment reading, from the two populations the Host owns.
 *
 * Pure, so the runner's bundle and the tests answer the same object for the same evidence - there is no second
 * derivation and therefore nothing to disagree with the artifact.
 */
export function measureDirectiveAlignment(
  input: Readonly<{
    /** Batches this Host delivered to an assistant turn. */
    deliveredTurns: number;
    /** How many of those carried a current directive. */
    turnsWithDirective: number;
    /** The directive that is current NOW, or `null` when none is. */
    currentDirectiveId: string | null;
    stamps: readonly DirectiveStampRow[];
  }>,
): DirectiveAlignment {
  const presence: DirectiveReading =
    input.deliveredTurns === 0
      ? Object.freeze({ state: NOT_MEASURED, missingField: "game_session.deliveredTurns" })
      : Object.freeze({
          state: "measured" as const,
          numerator: input.turnsWithDirective,
          denominator: input.deliveredTurns,
          value: input.turnsWithDirective / input.deliveredTurns,
        });
  const underCurrent = input.stamps.filter(
    (stamp) => stamp.directiveId !== null && stamp.directiveId === input.currentDirectiveId,
  ).length;
  const underRetired = input.stamps.filter(
    (stamp) => stamp.directiveId !== null && stamp.directiveId !== input.currentDirectiveId,
  ).length;
  const withoutDirective = input.stamps.filter((stamp) => stamp.directiveId === null).length;
  const alignment: DirectiveReading =
    input.stamps.length === 0
      ? Object.freeze({ state: NOT_MEASURED, missingField: "game_session.planSubmissions" })
      : Object.freeze({
          state: "measured" as const,
          numerator: underCurrent,
          denominator: input.stamps.length,
          value: underCurrent / input.stamps.length,
        });
  return Object.freeze({
    presence,
    alignment,
    plansUnderCurrent: underCurrent,
    plansUnderRetired: underRetired,
    plansWithoutDirective: withoutDirective,
    staleWork: input.stamps.filter(
      (stamp) =>
        stamp.settled === false && stamp.directiveId !== null && stamp.directiveId !== input.currentDirectiveId,
    ).length,
  });
}
