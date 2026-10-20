/**
 * The companion's arrival on the farm, said once per Game session.
 *
 * The rule this module implements: she greets the player when she arrives. Nothing in the game says "I
 * arrived" - the AI attaching to an already-running world is an event of the HOST, and the Host is also
 * the only party holding both halves it takes to say it well: that the attach completed
 * (`acceptInitialFacts`, the one call `activateIngress` makes) and how the world looks at that moment
 * (the Mod's own snapshot: clock, date, weather, location). So the Host mints the one fact that says
 * both, and the EXISTING Game mechanism does the rest: event pump -> `CompanionLoop` -> one proactive Pi
 * turn. Her words come from the provider, exactly as they do when the Mod's own `day_started` fact makes
 * her speak; this module writes no speech.
 *
 * WHY `world_fact`, AND WHY A NEW SEMANTIC KIND. `world_fact` is the pump's existing "something in the
 * world is worth her attention" kind, and `semanticKind` is the label `CompanionLoop` already reads to
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
import { formatGameClock, formatGameDate, formatGameWeather } from "./runtime-core.internal.js";

/** The fact's own identity. Stable per Game session, because it is said at most once. */
export const COMPANION_ARRIVAL_EVENT_ID = "companion_arrival";

/** The semantic kind `CompanionLoop` must treat as salient (see `isSalientSensoryKind`). */
export const COMPANION_ARRIVAL_SEMANTIC_KIND = "companion_arrival";

/** Who synthesised the fact. Deliberately not `stardew_mod`: the Mod never says this. */
export const COMPANION_ARRIVAL_SOURCE = "host_game_session";

/** The batch marker `companionArrivalAlreadySaid` looks for in the session's own entries. */
const COMPANION_ARRIVAL_MARKER = `"${COMPANION_ARRIVAL_EVENT_ID}"`;

/**
 * Whether this Game session already carried the arrival fact.
 *
 * The batch that carried it is a `user` message Pi persisted verbatim, so the fact's own event id is
 * the marker, and `chatTranscriptPlayerText` reduces a persisted batch to exactly the text the Host
 * passed. The session's entries are the only authority that cannot drift from the delivery.
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
    if (text !== null && text.includes(COMPANION_ARRIVAL_MARKER)) return true;
  }
  return false;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/**
 * The one prompt line this fact carries, in the player's own language.
 *
 * It states the two things only the Host knows - she has just arrived, and this is the world's first
 * clock reading of the day - and then hands the turn to her: her opening words are hers, in the voice
 * she opens with, not a status report about arriving, the hour or the weather.
 */
function arrivalText(
  zh: boolean,
  clock: string,
  date: string,
  weatherLabel: string,
  location: string | undefined,
): string {
  if (zh) {
    const when = date === "" ? clock : `${date} ${clock}`;
    return [
      `你刚到这座农场，第一次真的站在这里；世界已经走起来了：现在是${when}，${weatherLabel}${
        location === undefined ? "" : `，此刻在${location}`
      }。`,
      "用你自己一贯开口的语气，说你想说的第一句话：可以是你看到的、你在意的，或者你想去做的。",
      "不要把时间和天气念成播报，也不要只说“我到了”。",
    ].join("");
  }
  const when = date === "" ? clock : `${date} ${clock}`;
  return [
    `You have just arrived on this farm and are standing here for the first time; the world has started moving: it is ${when}, ${weatherLabel}${location === undefined ? "" : `, here in ${location}`}.`,
    " Open this morning in the voice you always open with: say the first thing you want to say - something you see, something you care about, something you want to do.",
    ' Do not read the clock or the weather out as a status report, and do not merely announce "I have arrived".',
  ].join("");
}
