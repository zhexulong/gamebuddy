import type { Locale } from "../i18n";
import type { BrowserDraftV1 } from "../reference-pipeline-api";
import type { ReferencePipelineSession } from "../reference-pipeline-session";
import type { ComposedReferenceGameBrowserRootV1 } from "../composed-reference-game-browser-api";
import type { ProblemViewState } from "../composed-problem-view";

/**
 * The composed shell's own view vocabulary.
 *
 * The shell holds the session and the peer surfaces render it, so the two sides
 * need the same name for "what the shell currently knows": `ReadyView` is the
 * authoritative root, the Reference session derived from its Chat half, the
 * durable draft read alongside it, and the display language. A surface never
 * builds one; it is handed the one the shell committed, which is what keeps a
 * single authority for the projection every surface reads.
 */
export type ReadyView = Readonly<{
  kind: "ready";
  root: ComposedReferenceGameBrowserRootV1;
  /**
   * The conversation's session, or `null` when this Host answered a root with no readable Chat half.
   *
   * `kind: "ready"` means one thing - the root is here - and every peer surface is readable from it. The
   * conversation is one of those peers rather than the frame, so a root that carries the Game half and no Chat
   * half is still a ready shell: the Game surface, its session and the game it runs are not the Chat producer's
   * subject, and unmounting them for its fault is what `chat-problem-keeps-the-game-mounted.spec.ts` exists
   * against. `null` is therefore not "loading" and not "failed": it is the shell with no conversation, whose
   * Chat region holds `chatProblem` and whose management peers - Chats, Characters, Settings, Memory, all of
   * them read through the Chat half - are absent because their producer is.
   */
  session: ReferencePipelineSession | null;
  /** The mounted conversation's durable draft, absent for the same reason the session is. */
  draft: BrowserDraftV1 | null;
  locale: Locale;
  /**
   * The Chat read that failed while this shell stood, or null.
   *
   * A failure about the CONVERSATION is not a failure about the shell. The Game projection, the
   * Game surface's own controls and the player's place on another surface are all still there, so
   * the card is one region's state and not the window's: it is drawn where the conversation is,
   * the Game surface stays mounted, and the stream that recovers the Chat half keeps running.
   *
   * `ViewState`'s own `kind: "problem"` is the other case and stays fatal - a mount that never had
   * a session to keep has no region to draw a card in, and nothing else on the window to preserve.
   */
  chatProblem: ProblemViewState | null;
}>;

export type ViewState = Readonly<{ kind: "loading" }> | ReadyView | ProblemViewState;

export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Reconnecting and reconnecting-aware commands are bounded by an authoritative
 * reread budget: `accepted`/`attached`/`reopened` transport results are never
 * runtime success, so the composed Game projection is reread until it converges,
 * a newer generation supersedes the attempt, or this budget expires (the attempt
 * fails over to its unavailable presentation with the exact generation-bound
 * idempotency key preserved for an idempotent replay).
 */
export const RESUME_REREAD_INTERVAL_MS = 500;
export const RESUME_REREAD_MAX_ATTEMPTS = 60;

/**
 * How many resyncs one connection may be replaced for before the panel stops re-subscribing.
 *
 * A resync is not an error: the channel keeps a bounded replay window, so a Host that restarted, a cursor that fell
 * out of the window, and a race against the very first frame all answer the same way - read `/game`, then continue
 * from the cursor it carried. The bound exists for the one case that is NOT an error: a Host that answers resync
 * forever would otherwise spin the panel between the route and the snapshot with nothing to show the player. Three
 * covers a restart plus a lost window plus the first-frame race; after it the snapshot stands and the next Game
 * command's own confirmation read is the way forward.
 */
export const GAME_STREAM_RESYNC_LIMIT = 3;

/**
 * The cabin handoff's own bounded wait, which an admitted launch starts.
 *
 * A launch's only forward path is the cabin handoff: confirming a cabin is what launches the AI
 * client and publishes the attachment, so a launch with nobody reading the cabin sits in
 * `launching` until the player presses "Read cabins again". Measured in a live run (2026-11-15, the
 * real game): the driver pressed it and the Host answered `Cabin 1` in 45 ms - one request the
 * panel never made on its own.
 *
 * The shape is the resume budget above, and the cadence is deliberately the slower of the two: the
 * fact it waits for is the player loading a farm, which is a human act rather than a Host
 * transition, so a second per read answers it without spending boundary queries on a screen the
 * player is not looking at. Thirty reads is the whole budget: after it, the wait is over and the
 * refresh control is the player's again, as a second chance rather than the only path.
 */
export const CABIN_REREAD_INTERVAL_MS = 1_000;
export const CABIN_REREAD_MAX_ATTEMPTS = 30;

/**
 * Redacted connection presentations that were attached and then dropped in a
 * way a player may recover with the generation-bound `game.resume` command.
 * `reconnecting` is already under backend recovery, and `stopped` is the
 * deliberate end state after STOP, so neither is player-resumable here.
 */
export const RESUMABLE_CONNECTION_STATUSES: ReadonlySet<string> = new Set(["failed", "disconnected"]);

export const STARDEW_GAME_INTEGRATION_ID = "stardew" as const;
