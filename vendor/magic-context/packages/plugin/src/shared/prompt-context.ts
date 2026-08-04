/**
 * Resolve the newest effective prompt context (agent + model + variant) for a
 * session by reading recent messages from the OpenCode HTTP API.
 *
 * WHY: a Channel 2 ceiling nudge sends a synthetic user message via
 * `promptAsync` with `noReply:false` (it DOES trigger an assistant turn).
 * OpenCode's `createUserMessage` resolves variant relative to the chosen
 * agent; passing model alone makes OpenCode pick the default agent whose model
 * check then fails, bypassing the active variant and busting the provider
 * prefix cache the prior turn warmed. So we pass agent + model + variant
 * explicitly, mirroring the resolution AFT/opencode-xtra use for their wake
 * notifications.
 *
 * Walk newest→oldest and merge field-by-field so the newest context-bearing
 * message wins while older messages only fill fields it did not provide. Read
 * BOTH the flat shape (`info.providerID`) used by AssistantMessage and the
 * nested shape (`info.model.providerID`) used by UserMessage.
 *
 * Bounded via `query.limit` — the legacy `/session/{id}/message` endpoint
 * hydrates the ENTIRE session without it (30k-45k messages on large sessions).
 */

export interface ResolvedPromptContext {
    agent?: string;
    model?: { providerID: string; modelID: string };
    variant?: string;
}

interface RawInfo {
    role?: string;
    agent?: string;
    variant?: string;
    providerID?: string;
    modelID?: string;
    model?: { providerID?: string; modelID?: string; variant?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function extractMessages(response: unknown): unknown[] {
    if (Array.isArray(response)) return response;
    if (isRecord(response) && Array.isArray(response.data)) return response.data;
    return [];
}

function extractFromMessage(message: unknown): ResolvedPromptContext | null {
    if (!isRecord(message) || !isRecord(message.info)) return null;
    const info = message.info as RawInfo;
    const modelInfo = isRecord(info.model) ? info.model : undefined;

    const agent = typeof info.agent === "string" ? info.agent : undefined;
    const providerID =
        typeof modelInfo?.providerID === "string"
            ? modelInfo.providerID
            : typeof info.providerID === "string"
              ? info.providerID
              : undefined;
    const modelID =
        typeof modelInfo?.modelID === "string"
            ? modelInfo.modelID
            : typeof info.modelID === "string"
              ? info.modelID
              : undefined;
    const variant =
        typeof modelInfo?.variant === "string"
            ? modelInfo.variant
            : typeof info.variant === "string"
              ? info.variant
              : undefined;

    if (!agent && (!providerID || !modelID) && !variant) return null;
    const out: ResolvedPromptContext = {};
    if (agent) out.agent = agent;
    if (providerID && modelID) out.model = { providerID, modelID };
    if (variant) out.variant = variant;
    return out;
}

function mergeContexts(
    base: ResolvedPromptContext,
    patch: ResolvedPromptContext,
): ResolvedPromptContext {
    return {
        agent: base.agent ?? patch.agent,
        model: base.model ?? patch.model,
        variant: base.variant ?? patch.variant,
    };
}

function isComplete(ctx: ResolvedPromptContext): boolean {
    return Boolean(ctx.agent && ctx.model && ctx.variant);
}

const PROMPT_CONTEXT_MESSAGE_LIMIT = 50;

export async function resolvePromptContext(
    client: unknown,
    sessionId: string,
): Promise<ResolvedPromptContext | null> {
    if (!client || !sessionId) return null;
    const c = client as {
        session?: {
            messages?: (input: {
                path: { id: string };
                query?: { limit?: number };
            }) => Promise<{ data?: unknown[] } | unknown[]>;
        };
    };
    if (typeof c.session?.messages !== "function") return null;

    let messages: unknown[] = [];
    try {
        const response = await c.session.messages({
            path: { id: sessionId },
            query: { limit: PROMPT_CONTEXT_MESSAGE_LIMIT },
        });
        messages = extractMessages(response);
    } catch {
        return null;
    }
    if (messages.length === 0) return null;

    let result: ResolvedPromptContext = {};
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const ctx = extractFromMessage(messages[i]);
        if (!ctx) continue;
        result = mergeContexts(result, ctx);
        if (isComplete(result)) return result;
    }

    if (!result.agent && !result.model && !result.variant) return null;
    return result;
}
