/**
 * The game's own HUD notices, delivered to the companion as notices of their own.
 *
 * The engine explains itself in `Game1.hudMessages` ("It's getting late...", "Out of season.", "Inventory Full"), and
 * the Mod folds whatever appeared during an action's synchronous window into that action's receipt. A receipt is a
 * statement about ONE action, so a notice was readable only by a companion that had just acted - and the moment it
 * most needs the clock is the moment it has nothing outstanding. This module turns those raw texts into facts on the
 * session-level pump, the channel the arrival fact already uses (`companion-arrival-fact.ts`): they reach the
 * conversation whether or not an execution is in flight, and they read as the game's own words rather than as a
 * receipt field.
 *
 * WHAT A NOTICE IS NOT. The text is quoted verbatim and the framing sentence says only who showed it. Nothing here
 * carries an action command - whether a late hour is worth acting on is the companion's own decision - and the fact
 * travels as a `world_fact`, never through the pump's player-input lane, so it can never be read as the player
 * speaking.
 *
 * IDENTITY. One game notice is one identity: its exact text, scoped by the world day it was shown on and by the
 * in-game clock reading carried in the same receipt (`day | clock | text`). The text alone is wrong in both
 * directions - the engine repeats a fading notice across receipts (which must collapse), and it says the same line
 * again on the next night (which must not). Day and clock are read from what the Mod already published (the
 * snapshot's date, the receipt's own observation), never invented; a receipt without an observation has no clock to
 * scope by, so that part of the identity is empty rather than guessed. Remembered identities are bounded, oldest
 * first, so a long session cannot grow the set forever.
 */

import type { WorldFact } from "./event-pump.js";
import type { ExecutionReceipt } from "./protocol.js";

/** The semantic kind the notice facts carry; `CompanionLoop` treats it as salient. */
export const NATIVE_NOTICE_SEMANTIC_KIND = "native_notice";

/** Who synthesised the fact. The game showed the text; the Mod carried it; the Host names it. */
export const NATIVE_NOTICE_SOURCE = "host_game_session";

/** How many delivered identities this session remembers. Oldest first; a notice is a handful per in-game day. */
export const MAX_REMEMBERED_NATIVE_NOTICES = 64;

/** One Game session's notice identities, fed by its snapshots and by the receipts that carry notices. */
export class NativeNoticeLedger {
  /** The world day the latest snapshot named, or empty while the session has not read one. */
  #dayKey = "";
  #zh = false;
  /** Identities already delivered, in delivery order (the bound evicts the oldest). */
  readonly #delivered = new Set<string>();
  #ordinal = 0;

  /** The snapshot is where the world day and the presentation locale are read from, not invented. */
  public observeSnapshot(snapshot: Readonly<Record<string, unknown>>): void {
    this.#zh =
      typeof snapshot.presentationLocale === "string" && snapshot.presentationLocale.toLowerCase().startsWith("zh");
    const dayOfMonth = safeInteger(snapshot.dayOfMonth);
    const seasonIndex = safeInteger(snapshot.seasonIndex);
    const year = safeInteger(snapshot.year);
    this.#dayKey =
      dayOfMonth === undefined || seasonIndex === undefined || year === undefined
        ? ""
        : `y${String(year)}s${String(seasonIndex + 1)}d${String(dayOfMonth)}`;
  }

  /**
   * The notice facts this receipt carries for the first time, in the receipt's own order. A notice already delivered
   * under its identity produces nothing, which is what keeps one HUD line from re-announcing itself on every later
   * receipt that still sees it on screen.
   */
  public admit(receipt: ExecutionReceipt, occurredAtMs: number): readonly WorldFact[] {
    const notices = receipt.nativeNotices;
    if (!Array.isArray(notices) || notices.length === 0) return [];
    const clock = typeof receipt.observation?.inGameTime === "string" ? receipt.observation.inGameTime : "";
    const facts: WorldFact[] = [];
    for (const text of notices) {
      if (typeof text !== "string" || text.trim().length === 0) continue;
      const identity = `${this.#dayKey}\u001f${clock}\u001f${text}`;
      if (this.#delivered.has(identity)) continue;
      this.#ordinal += 1;
      const eventId = `native_notice_${String(this.#ordinal)}`;
      this.#delivered.add(identity);
      if (this.#delivered.size > MAX_REMEMBERED_NATIVE_NOTICES) {
        const oldest = this.#delivered.values().next();
        if (!oldest.done) this.#delivered.delete(oldest.value);
      }
      facts.push(
        Object.freeze({
          source: NATIVE_NOTICE_SOURCE,
          kind: "world_fact" as const,
          // The notice's own name: stable for this notice, and distinct from the next night's identical line.
          eventId,
          sourceEventId: eventId,
          correlationId: eventId,
          revision: 0,
          occurredAtMs,
          semanticKind: NATIVE_NOTICE_SEMANTIC_KIND,
          payload: Object.freeze({
            kind: NATIVE_NOTICE_SEMANTIC_KIND,
            notice: text,
            executionId: receipt.executionId,
            ...(clock === "" ? {} : { inGameTime: clock }),
            ...(this.#dayKey === "" ? {} : { worldDay: this.#dayKey }),
          }),
          contextProjection: Object.freeze({
            kind: NATIVE_NOTICE_SEMANTIC_KIND,
            notice: text,
            text: noticeText(this.#zh, text),
          }),
        }),
      );
    }
    return facts;
  }
}

/**
 * The one model-facing line a notice carries: the game's own text, and who showed it. Deliberately no reading of
 * the hour and no verb aimed at the companion - the notice reports, the companion decides.
 */
function noticeText(zh: boolean, text: string): string {
  return zh ? `游戏自己的提示：${text}` : `The game's own notice: ${text}`;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}
