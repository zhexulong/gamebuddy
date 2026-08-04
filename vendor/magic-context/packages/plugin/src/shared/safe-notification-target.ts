import { log } from "./logger";

/**
 * Guard for ignored-message notification posting: only post into sessions
 * that already carry a REAL title.
 *
 * Why: OpenCode's title generation (SessionPrompt.ensureTitle) silently and
 * PERMANENTLY skips a session once it contains more than one non-synthetic
 * user message. Our notification posts (config warnings, conflict warnings,
 * schema-fence warnings, startup announcements) are `ignored: true` — hidden
 * from the LLM — but NOT `synthetic: true`, so the title gate counts them as
 * real user messages. A notification landing in a fresh session before the
 * user's first prompt therefore suppressed that session's title forever
 * (issue #129; only repros where the new session is the project's only one,
 * e.g. fresh non-git directories).
 *
 * We deliberately do NOT mark our posts `synthetic: true` instead: the
 * Desktop renderer (UserMessageDisplay) picks the first NON-synthetic text
 * part, so synthetic would blank the message on Desktop — the only surface
 * these posts exist for.
 *
 * ensureTitle short-circuits on `!isDefaultTitle(session.title)` before the
 * message count, so posting into an already-titled session can never affect
 * titling. Callers must NOT mark a notification as delivered when this guard
 * returns "skip", so the next startup retries.
 */

/**
 * Mirrors OpenCode's Session.isDefaultTitle (session.ts): a default title is
 * `New session - <ISO>` or `Child session - <ISO>`.
 */
const DEFAULT_TITLE_RE =
    /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isDefaultSessionTitle(title: string): boolean {
    return DEFAULT_TITLE_RE.test(title);
}

/**
 * Read a session's current title via the SDK client. Returns null when the
 * title cannot be determined (missing API, transport error, unexpected
 * shape) — callers treat that as "fail open" and post, preserving delivery
 * on clients/tests that don't expose session.get.
 */
async function readSessionTitle(client: unknown, sessionId: string): Promise<string | null> {
    try {
        const c = client as {
            session?: { get?: (input: unknown) => unknown };
        };
        if (typeof c.session?.get !== "function") return null;
        const raw = await Promise.resolve(c.session.get({ path: { id: sessionId } }));
        // SDK response shapes vary across versions: `{ data: { title } }` or
        // the session object directly.
        const obj = raw as { data?: { title?: unknown }; title?: unknown } | null;
        const title = obj && typeof obj === "object" ? (obj.data?.title ?? obj.title) : undefined;
        return typeof title === "string" ? title : null;
    } catch {
        return null;
    }
}

export interface SafeTargetOptions {
    /** Total title checks before giving up (default 4). */
    attempts?: number;
    /** Delay between checks in ms (default 15s). */
    delayMs?: number;
}

/**
 * Resolve whether `sessionId` is safe to receive an ignored-message post.
 *
 * - "safe": the session has a real (non-default) title, or the title is
 *   unreadable (fail-open).
 * - "skip": the session still has OpenCode's default title after all
 *   attempts — posting now could permanently suppress its title generation.
 *   The caller must leave its delivered/seen marker unset so a later
 *   startup retries.
 *
 * The retry window exists for the common startup case: plugin init fires a
 * few seconds after launch, the user prompts shortly after, and the title
 * lands within seconds of that first prompt.
 */
export async function waitForSafeNotificationTarget(
    client: unknown,
    sessionId: string,
    options?: SafeTargetOptions,
): Promise<"safe" | "skip"> {
    const attempts = Math.max(1, options?.attempts ?? 4);
    const delayMs = options?.delayMs ?? 15_000;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const title = await readSessionTitle(client, sessionId);
        if (title === null) return "safe";
        if (!isDefaultSessionTitle(title)) return "safe";
        if (attempt < attempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    log(
        `[magic-context] notification skipped: session ${sessionId} still has its default title (would suppress title generation); will retry on a later startup`,
    );
    return "skip";
}
