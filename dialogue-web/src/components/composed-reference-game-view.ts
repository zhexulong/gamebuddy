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
  session: ReferencePipelineSession;
  draft: BrowserDraftV1;
  locale: Locale;
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
 * Redacted connection presentations that were attached and then dropped in a
 * way a player may recover with the generation-bound `game.resume` command.
 * `reconnecting` is already under backend recovery, and `stopped` is the
 * deliberate end state after STOP, so neither is player-resumable here.
 */
export const RESUMABLE_CONNECTION_STATUSES: ReadonlySet<string> = new Set(["failed", "disconnected"]);

export const STARDEW_GAME_INTEGRATION_ID = "stardew" as const;
