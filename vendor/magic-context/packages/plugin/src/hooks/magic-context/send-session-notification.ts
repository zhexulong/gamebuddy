import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";

export interface NotificationParams {
    agent?: string;
    variant?: string;
    providerId?: string;
    modelId?: string;
    /** TUI toast lifetime in milliseconds (default: 5000). */
    toastDurationMs?: number;
}

export type NotificationDeliveryDisposition = "sent" | "skipped" | "failed";

interface NotificationClient {
    session?: {
        prompt?: (opts: unknown) => unknown | Promise<unknown>;
        promptAsync?: (opts: unknown) => Promise<unknown>;
    };
}

function hasNotificationSessionClient(client: unknown): client is NotificationClient {
    if (client === null || typeof client !== "object") return false;
    const candidate = client as Record<string, unknown>;
    if (candidate.session === undefined) return true;
    if (candidate.session === null || typeof candidate.session !== "object") return false;
    const session = candidate.session as Record<string, unknown>;
    return (
        (session.prompt === undefined || typeof session.prompt === "function") &&
        (session.promptAsync === undefined || typeof session.promptAsync === "function")
    );
}

/**
 * Map notification text to a TUI toast variant based on content heuristics.
 */
function inferToastVariant(text: string): "success" | "error" | "warning" | "info" {
    const lower = text.toLowerCase();
    if (lower.includes("error") || lower.includes("failed") || lower.includes("alert"))
        return "error";
    if (lower.includes("warning") || lower.includes("⚠")) return "warning";
    if (
        lower.includes("complete") ||
        lower.includes("success") ||
        lower.includes("✓") ||
        lower.includes("finished")
    )
        return "success";
    return "info";
}

/**
 * Extract a short title from notification text (first line or first sentence).
 */
function extractToastTitle(text: string): string {
    // Use first markdown heading if present
    const headingMatch = text.match(/^#+\s+(.+)/m);
    if (headingMatch) return headingMatch[1].trim();
    // Use first line if short enough
    const firstLine = text.split("\n")[0].trim();
    if (firstLine.length <= 80) return firstLine;
    return "Magic Context";
}

export async function sendIgnoredMessage(
    client: unknown,
    sessionId: string,
    text: string,
    params: NotificationParams,
    // When true, ALWAYS persist as an ignored message (skip the TUI toast path)
    // so the content survives in scrollback. Used for outcomes of long-running
    // background work (e.g. session-upgrade result) where a transient 5s toast
    // is too easy to miss — dogfood 2026-05-30.
    forcePersist = false,
): Promise<NotificationDeliveryDisposition> {
    const title = extractToastTitle(text);
    const message = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    const toastVariant = inferToastVariant(text);
    const duration = params.toastDurationMs ?? 5000;

    // In TUI mode, show as toast via RPC instead of ignored message — UNLESS the
    // caller asked to force-persist (long-running outcome must stay in scrollback).
    // Cannot use process.env.OPENCODE_CLIENT — it's undefined in the server plugin process.
    const { isTuiConnected: checkTui } = await import("../../shared/rpc-notifications");
    if (!forcePersist && checkTui(sessionId)) {
        try {
            const { pushNotification } = await import("../../shared/rpc-notifications");
            pushNotification(
                "toast",
                {
                    title,
                    message,
                    variant: toastVariant,
                    duration,
                },
                sessionId,
            );
            return "sent";
        } catch {
            // RPC enqueue failed — fall through to ignored message.
            sessionLog(sessionId, "TUI RPC toast enqueue failed, falling back to ignored message");
        }
    }
    // Title-safety guard (issue #129): an ignored message is hidden from the
    // LLM but NOT `synthetic`, so OpenCode's title gate counts it as a real
    // user message — one post into a not-yet-titled session permanently
    // suppresses that session's title generation. Only persist into sessions
    // that already have a real title (the toast path above is unaffected).
    // Mid-session callers (historian failures, recomp outcomes) always pass
    // immediately because their sessions are titled.
    const { waitForSafeNotificationTarget } = await import("../../shared/safe-notification-target");
    if ((await waitForSafeNotificationTarget(client, sessionId)) === "skip") {
        sessionLog(sessionId, "notification skipped (session not titled yet)");
        return "skipped";
    }

    if (!hasNotificationSessionClient(client)) {
        sessionLog(sessionId, "session prompt API unavailable for notification");
        return "failed";
    }
    const c = client;

    // Pin the prompt context (agent + model + variant) to the session's most
    // recent real turn. WHY: even though this is `noReply: true` (no assistant
    // turn fires now), OpenCode's createUserMessage RECORDS prompt context on
    // the appended user message, and THAT becomes the session's active
    // model/agent for the NEXT real turn. Passing nothing makes OpenCode record
    // the DEFAULT agent/model — which then switches the model on the user's
    // next turn and busts the provider prefix cache the prior turn warmed.
    // Mirrors AFT's notifications.ts (issue #62).
    //
    // Caller-supplied params win; otherwise resolve from the last assistant
    // turn. We only pin values actually resolved from real messages (never a
    // synthesized default), and resolution failures degrade to "pin nothing"
    // (today's behavior) — so a fresh/empty session is never made worse.
    let agent = params.agent || undefined;
    let variant = params.variant || undefined;
    let model =
        params.providerId && params.modelId
            ? { providerID: params.providerId, modelID: params.modelId }
            : undefined;
    if (!agent || !model || !variant) {
        try {
            const { resolvePromptContext } = await import("../../shared/prompt-context");
            const resolved = await resolvePromptContext(client, sessionId);
            if (resolved) {
                agent = agent ?? resolved.agent;
                model = model ?? resolved.model;
                variant = variant ?? resolved.variant;
            }
        } catch {
            // Resolution is best-effort; on failure fall back to whatever the
            // caller passed (possibly nothing) rather than blocking the notice.
        }
    }

    const input = {
        path: { id: sessionId },
        body: {
            noReply: true,
            agent,
            model,
            variant,
            parts: [
                {
                    type: "text",
                    text,
                    ignored: true,
                },
            ],
        },
    };

    try {
        if (typeof c.session?.prompt === "function") {
            await Promise.resolve(c.session.prompt(input));
            return "sent";
        }
        if (typeof c.session?.promptAsync === "function") {
            await c.session.promptAsync(input);
            return "sent";
        }
        sessionLog(sessionId, "session prompt API unavailable for notification");
        return "failed";
    } catch (error: unknown) {
        const msg = getErrorMessage(error);
        sessionLog(sessionId, "failed to send notification:", msg);
        return "failed";
    }
}

/**
 * Send a real user prompt that will be processed by the model (not ignored).
 * Used by /ctx-aug to inject the augmented prompt after sidekick completes.
 */
export async function sendUserPrompt(
    client: unknown,
    sessionId: string,
    text: string,
): Promise<void> {
    if (!hasNotificationSessionClient(client)) {
        sessionLog(sessionId, "session prompt API unavailable for user prompt");
        return;
    }
    const c = client as NotificationClient;

    const input = {
        path: { id: sessionId },
        body: {
            parts: [{ type: "text", text }],
        },
    };

    try {
        if (typeof c.session?.promptAsync === "function") {
            await c.session.promptAsync(input);
        } else if (typeof c.session?.prompt === "function") {
            await Promise.resolve(c.session.prompt(input));
        } else {
            sessionLog(sessionId, "session prompt API unavailable for user prompt");
        }
    } catch (error: unknown) {
        const msg = getErrorMessage(error);
        sessionLog(sessionId, "failed to send user prompt:", msg);
    }
}
