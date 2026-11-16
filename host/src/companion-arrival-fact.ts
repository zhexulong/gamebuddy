/**
 * The companion's arrival on the farm, said once per Game session.
 *
 * THE FACT. She has arrived, and this is the world's first clock reading of the day. Nothing in the game says "I
 * arrived" - the AI attaching to an already-running world is an event of the HOST, and the Host is also the only party
 * holding both halves it takes to say it: that the attach completed (`acceptInitialFacts`, the one call `activateIngress`
 * makes) and how the world looks at that moment (the Mod's own snapshot: clock, date, weather, location). So the Host
 * mints the one fact that says both, and the EXISTING Game mechanism does the rest: event pump -> `CompanionLoop` -> one
 * proactive Pi turn. Her words come from the provider, exactly as they do when the Mod's own `day_started` fact opens a
 * turn; this module writes no speech.
 *
 * IT WRITES NO INSTRUCTION TO SPEAK EITHER. Until 2026-11-22 the paragraph went on to tell her how to open (「用你自己一贯
 * 开口的语气，说你想说的第一句话」 / "Open this morning in the voice you always open with: say the first thing you want to
 * say") and then how not to say it (a ban on reading the clock out as a status report). The first made speaking the
 * consequence of the event, which `design/input-authority.md` § three calls a defect in this writer "including when it
 * arrives as a description of a fact"; the second is form. Both were deleted rather than moved, and `arrivalText` below
 * records where each of them already lives. `conversational-stance-gate.test.ts` reads this module's strings with the
 * `speech_mandated` detector, so the third location cannot come back here.
 *
 * WHY `world_fact`, AND WHY A NEW SEMANTIC KIND. `world_fact` is the pump's existing "something in the world is worth her
 * attention" kind, and `semanticKind` is the label `CompanionLoop` already reads to
 * decide which facts may open a native companion turn. The two kinds it whitelists (`day_started`,
 * `time_milestone`) are the MOD's own events; borrowing either name for a Host-minted fact would claim
 * the Mod said something it did not. The whitelist therefore gains exactly one name -
 * `companion_arrival` - which only this fact carries. `source` names who synthesised the fact; every
 * number in its payload is still read from the Mod's snapshot, never invented.
 *
 * THE ONCE-ONLY RULE has two authorities, because they answer different questions:
 *
 *  - the live switch in `CompanionHostService`, so one mounted session can never say it twice;
 *  - the Game session's own Pi transcript (`companionArrivalAlreadySaid`), so a Host that crashes and
 *    re-attaches to the same Game session finds the fact it already delivered.
 *
 * The transcript is the right durable record because the fact IS a turn: Pi persisted the batch the
 * moment it consumed it, and nothing else in the product can disagree with that. No marker file is
 * added, so nothing can drift from it. The one replay window left is a crash between enqueue and Pi
 * consuming the batch - the same window every turn has, and not one a second durable write could close
 * without becoming a second authority over Pi's own session.
 *
 * THE CLOCK. Attach alone says nothing: the fact needs a snapshot whose clock has actually ticked
 * (`timeOfDay > 0`). A world that has not started its day renders no greeting, which is the rule the
 * environment-facts provider already follows - absent a usable reading, say nothing.
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";

import type { WorldFact } from "./event-pump.js";
import { chatTranscriptPlayerText } from "./native-companion-content.js";
import { formatGameClock, formatGameDate, formatGameWeather } from "./game-world-vocabulary.js";

/** The fact's own identity. Stable per Game session, because it is said at most once. */
export const COMPANION_ARRIVAL_EVENT_ID = "companion_arrival";

/** The semantic kind `CompanionLoop` must treat as salient (see `isSalientSensoryKind`). */
export const COMPANION_ARRIVAL_SEMANTIC_KIND = "companion_arrival";

/** Who synthesised the fact. Deliberately not `stardew_mod`: the Mod never says this. */
export const COMPANION_ARRIVAL_SOURCE = "host_game_session";

/**
 * The invariant opening of the arrival paragraph, in each language it is written in.
 *
 * TWO READERS, ONE DECLARATION: `arrivalText` opens with it, and `companionArrivalAlreadySaid` looks for it in the
 * session's persisted entries. It used to be the fact's event id inside a JSON envelope - the batch was a stringified
 * object, so `"companion_arrival"` was the marker - and a prose delivery carries no such token. The opening sentence is
 * the one thing the delivered text and the detector cannot disagree about, because both are built from these strings.
 */
const ARRIVAL_OPENING_ZH = "你刚到这座农场，第一次真的站在这里";
const ARRIVAL_OPENING_EN = "You have just arrived on this farm and are standing here for the first time";

/**
 * Whether this Game session already carried the arrival fact.
 *
 * The batch that carried it is a `user` message Pi persisted verbatim, so the arrival paragraph's own opening is the
 * marker, and `chatTranscriptPlayerText` reduces a persisted batch to exactly the text the Host passed. The session's
 * entries are the only authority that cannot drift from the delivery.
 */
export type CompanionArrivalHistory = Readonly<{ alreadySaid(): boolean }>;

/**
 * The arrival fact for one attached Game session, or `undefined` when the world has no usable clock
 * yet. Pure: the caller owns the once-only decisions.
 */
export function companionArrivalFact(snapshot: unknown): WorldFact | undefined {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return undefined;
  const source = snapshot as Readonly<Record<string, unknown>>;
  const timeOfDay = source.timeOfDay;
  // A world that has not started its day has no clock (`Snapshot.timeOfDay` is 0 until it does).
  if (typeof timeOfDay !== "number" || !Number.isSafeInteger(timeOfDay) || timeOfDay <= 0) return undefined;
  const weather = source.weather;
  if (typeof weather !== "string" || weather.length === 0) return undefined;
  // Same locale rule as the environment-facts provider: the Mod's own BCP-47 tag decides the wording.
  const zh = typeof source.presentationLocale === "string" && source.presentationLocale.toLowerCase().startsWith("zh");
  const clock = formatGameClock(timeOfDay, zh);
  if (clock === "") return undefined;
  const dayOfMonth = safeInteger(source.dayOfMonth);
  const seasonIndex = safeInteger(source.seasonIndex);
  const year = safeInteger(source.year);
  const location = typeof source.location === "string" && source.location.length > 0 ? source.location : undefined;
  const date =
    dayOfMonth === undefined || seasonIndex === undefined || year === undefined
      ? ""
      : formatGameDate(dayOfMonth, seasonIndex, year, zh);
  const weatherLabel = formatGameWeather(weather, zh);
  return Object.freeze({
    source: COMPANION_ARRIVAL_SOURCE,
    kind: "world_fact" as const,
    eventId: COMPANION_ARRIVAL_EVENT_ID,
    sourceEventId: COMPANION_ARRIVAL_EVENT_ID,
    correlationId: COMPANION_ARRIVAL_EVENT_ID,
    revision: 0,
    occurredAtMs: Date.now(),
    semanticKind: COMPANION_ARRIVAL_SEMANTIC_KIND,
    // The authoritative values, read straight from the Mod's snapshot.
    payload: Object.freeze({
      kind: COMPANION_ARRIVAL_SEMANTIC_KIND,
      timeOfDay,
      weather,
      ...(dayOfMonth === undefined ? {} : { dayOfMonth }),
      ...(seasonIndex === undefined ? {} : { seasonIndex }),
      ...(year === undefined ? {} : { year }),
      ...(location === undefined ? {} : { location }),
    }),
    // What the model reads: the same numbers, phrased as the moment she has walked into.
    contextProjection: Object.freeze({
      kind: COMPANION_ARRIVAL_SEMANTIC_KIND,
      time: clock,
      weather: weatherLabel,
      ...(date === "" ? {} : { date }),
      ...(location === undefined ? {} : { location }),
      text: arrivalText(zh, clock, date, weatherLabel, location),
    }),
  });
}

/** Whether the Game session's own entries already hold the arrival fact's batch. */
export function companionArrivalAlreadySaid(session: Pick<SessionManager, "getBranch">): boolean {
  for (const entry of session.getBranch()) {
    if (entry.type !== "message") continue;
    const text = chatTranscriptPlayerText(entry.message);
    if (text !== null && (text.includes(ARRIVAL_OPENING_ZH) || text.includes(ARRIVAL_OPENING_EN))) return true;
  }
  return false;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/**
 * The one prompt line this fact carries, in the player's own language.
 *
 * IT STATES THE TWO FACTS AND STOPS. The two are the ones only the Host knows at this instant: she has just arrived, and
 * this is the world's first clock reading of the day. That is the whole of what a fact block may say.
 *
 * WHAT IT USED TO SAY, AND WHERE THOSE TWO SENTENCES ALREADY LIVED. It ended with 「用你自己一贯开口的语气，说你想说的第一
 * 句话：可以是你看到的、你在意的，或者你想去做的。」 / "Open this morning in the voice you always open with: say the first
 * thing you want to say", and then 「不要把时间和天气念成播报」 / "Do not read the clock or the weather out as a status
 * report". The first is a speech mandate: it makes speaking the consequence of the event, which is the persona's
 * sentence and nobody else's (`design/input-authority.md` § three). The second is FORM. Both were DELETED rather than
 * moved, because the layer that owns each one already states it:
 *
 *  - the card's own directive (mounted by every Game session as `characterVoice`) says 先接住人 / 只说你自己 /
 *    只从手头实物或一句闲聊开口 / 不报进度 / 不报备 / 动作回执绝不翻成台词广播;
 *  - the floor's CHANNEL says the rest (`machine_fields_translated`: "Tool results, receipts and status fields are written
 *    for machines ... say what they MEAN to a person instead of reading them out").
 *
 * And moving the 「open with a line」 rule into the preset would have reversed a deliberate owner decision
 * (`assets/tavern/presets/PERSONA-REVISION.md`: 2026-11-13 "replace broken positive declarations forcing chatter with
 * action-with-spoken-intent", 2026-11-15 "de-bloat presets to positive co-op gaming identity (silent on work, speak on
 * coordination)"), so there was nothing to move it to.
 *
 * The detector that found it reads this function's two sentences - the shipped ones - and `conversational-stance-gate.test.ts`
 * pins both directions: the paragraph that shipped is red, this one is not.
 */
function arrivalText(
  zh: boolean,
  clock: string,
  date: string,
  weatherLabel: string,
  location: string | undefined,
): string {
  const when = date === "" ? clock : `${date} ${clock}`;
  const here = location === undefined ? "" : location;
  if (zh)
    return `${ARRIVAL_OPENING_ZH}；世界已经走起来了：现在是${when}，${weatherLabel}${
      here === "" ? "" : `，此刻在${here}`
    }。`;
  return `${ARRIVAL_OPENING_EN}; the world has started moving: it is ${when}, ${weatherLabel}${
    here === "" ? "" : `, here in ${here}`
  }.`;
}
