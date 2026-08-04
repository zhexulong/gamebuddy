import { createHash } from "node:crypto";
import { buildMagicContextSection } from "../../agents/magic-context-prompt";
import {
    type ContextDatabase,
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { sessionLog } from "../../shared/logger";
import { resolveCtxReduceAvailability } from "./ctx-reduce-availability";

import { estimateTokens } from "./read-session-formatting";

const MAGIC_CONTEXT_MARKER = "## Magic Context";
// Module-scope caches are per-plugin-instance (one plugin process per OpenCode
// process) and accumulate session entries over the plugin's lifetime. Without
// cleanup on `session.deleted`, these maps grow unbounded. Exported so hook.ts
// can register a cleanup callback tied to the session-deleted lifecycle event.
/**
 * Clear all per-session cache entries the system-prompt handler maintains,
 * including the module-scope user-profile/key-files maps and the per-handler
 * sticky-date/cached-docs maps (the latter passed in via the cleanup handle).
 * Called from the session-deleted event path.
 */
export function clearSystemPromptHashSession(
    sessionId: string,
    handleMaps: {
        stickyDateBySession: Map<string, string>;
        cachedDocsBySession: Map<string, string | null>;
    },
): void {
    handleMaps.stickyDateBySession.delete(sessionId);
    handleMaps.cachedDocsBySession.delete(sessionId);
}

/**
 * Detect OpenCode's three native hidden agents by stable signature lines from
 * their built-in prompts (see `~/Work/OSS/opencode/packages/opencode/src/agent/
 * prompt/{title,summary,compaction}.txt`).
 *
 * These agents:
 *   - "title": runs once on the first user turn against `small_model` to
 *              generate a short session title.
 *   - "summary": pull-request-style description of work done in a session.
 *   - "compaction": OpenCode's own auto-compaction summarizer (orthogonal to
 *                   our historian — fires when users haven't disabled
 *                   `compaction.auto`).
 *
 * Magic Context skips ALL injection (guidance, project docs, user profile,
 * key files, sticky date, hash flush) when these agents fire — they don't
 * benefit from any of it and the extra prompt content is wasted spend on
 * what's typically a small/cheap model running a fixed single-shot job.
 *
 * Detection uses literal substrings rather than fuzzy matching so a small
 * upstream prompt edit doesn't silently disable the skip. If OpenCode ever
 * rewrites these prompts, our injection will resume — that's the correct
 * fail-open behavior (worse than ideal, but not broken).
 */
function isInternalOpenCodeAgent(systemPromptContent: string): boolean {
    return (
        // title.txt opens with this exact line
        systemPromptContent.includes(
            "You are a title generator. You output ONLY a thread title.",
        ) ||
        // summary.txt opens with this exact line
        systemPromptContent.includes(
            "Summarize what was done in this conversation. Write like a pull request description.",
        ) ||
        // compaction.txt opens with this exact line
        systemPromptContent.includes(
            "You are an anchored context summarization assistant for coding sessions.",
        )
    );
}

/**
 * Detect Magic Context's OWN hidden child agents by their system-prompt
 * openers. These children (historian/dreamer/sidekick/memory-migration) load a
 * fixed agent identity and must NOT receive the MC guidance block — it's wasted
 * spend and a contradictory second identity frame ("You are Historian…" plus
 * "You are the user's long-term partner…").
 *
 * This is the timing-independent companion to the `internalChildSessions` flag:
 * the flag is set at `session.created` (may race the very first system.transform
 * by event-delivery latency), whereas this signature is present in the prompt
 * content on pass 1 with zero timing dependency. Memory-migration loads the
 * historian agent prompt, so the historian opener covers it.
 *
 * Literal substrings (not fuzzy) so an upstream prompt edit fails open (resumes
 * injection) rather than silently mis-detecting.
 */
export function isMagicContextInternalAgent(systemPromptContent: string): boolean {
    return (
        // HISTORIAN_AGENT (also used by memory-migration)
        systemPromptContent.includes(
            "You are Historian — the hippocampus of a long-running coding agent.",
        ) ||
        // Every dreamer task prompt (generic base + curate / maintain-docs /
        // review-user-memories / primer-investigator) shares this identity phrase,
        // so one substring covers them all even though their openers differ.
        systemPromptContent.includes("for the magic-context system") ||
        // SIDEKICK_SYSTEM_PROMPT
        systemPromptContent.includes(
            "You are Sidekick, a focused memory-retrieval subagent for an AI coding assistant.",
        )
    );
}

/**
 * Handle system prompt via experimental.chat.system.transform:
 *
 * 1. Inject generic magic-context guidance into the system prompt.
 *    Skips injection if guidance is already present (e.g., baked into the
 *    agent prompt by oh-my-opencode).
 *
 * 2. Detect system prompt changes for cache-flush triggering.
 *    If the hash changes between turns, the Anthropic prompt-cache prefix is
 *    already busted, so we flush queued operations immediately.
 */
export function createSystemPromptHashHandler(deps: {
    db: ContextDatabase;
    protectedTags: number;
    dreamerEnabled: boolean;
    /** When false (`memory.enabled: false`), the `<project-memory>` block is
     *  never injected, so ctx_memory guidance is dropped from the prompt and the
     *  ctx_memory tool is not registered. ctx_search guidance stays (it still
     *  recalls conversation + git commits). Default true. */
    memoryEnabled?: boolean;
    /** Optional language from user config for the main agent's generated text. */
    language?: string;
    /**
     * One-shot signal that disk-backed adjuncts (user profile, key files,
     * sticky date) need to be re-read on this pass.
     * Drained at the end of the handler regardless of whether anything
     * actually refreshed — defer passes after this point MUST hit cached
     * values to keep the system prompt cache-stable.
     */
    systemPromptRefreshSessions: Set<string>;
    /**
     * Producer side: when this handler detects a real prompt-content hash
     * change, it adds the session to all three sets so downstream consumers
     * (transform `prepareCompartmentInjection`, postprocess heuristics)
     * react on the same cycle. The hash change usually pairs with a new
     * agent identity, so all three are appropriate.
     */
    historyRefreshSessions: Set<string>;
    pendingMaterializationSessions: Set<string>;
    lastHeuristicsTurnId: Map<string, string>;
    /**
     * Issue #53: when false, Magic Context skips ALL system-prompt injection
     * for ALL agents. Global escape hatch for users who don't want Magic
     * Context guidance / sticky date touching the system prompt. (default: true)
     */
    injectionEnabled?: boolean;
    /**
     * Issue #53: per-agent opt-out. If the agent's system prompt contains
     * any of these substrings, skip ALL injection for this call. Lets users
     * mark specific custom agents (e.g. read-only QA agents that deny our
     * `ctx_*` tools) as no-injection without having to disable injection
     * globally.
     */
    injectionSkipSignatures?: string[];
    /**
     * Process-scoped set of Magic Context's OWN hidden child sessions
     * (historian/dreamer/sidekick/memory-migration), flagged by title prefix at
     * `session.created`. When the active session is in this set we skip ALL
     * injection — these children have their own fixed agent identity/prompt and
     * never benefit from the MC guidance block. Belt to the prompt-signature
     * detection below (which is the pass-1 timing-independent suspenders).
     */
    internalChildSessions?: Set<string>;
    /** @deprecated user memories now render in m[0]/m[1], not system prompt. */
    experimentalUserMemories?: boolean;
    /** @deprecated key files now render in m[1], not system prompt. */
    experimentalPinKeyFiles?: boolean;
    /** @deprecated key files now render in m[1], not system prompt. */
    experimentalPinKeyFilesTokenBudget?: number;
    /** When true, add a temporal-awareness guidance paragraph + surface compartment dates */
    experimentalTemporalAwareness?: boolean;
    /** When true, inject a "BEWARE: history compression is on" warning so the
     *  agent doesn't mimic its own caveman-compressed past output. */
    experimentalCavemanTextCompression?: boolean;
}): {
    handler: (input: { sessionID?: string }, output: { system: string[] }) => Promise<void>;
    clearSession: (sessionId: string) => void;
} {
    // Per-session sticky date: we freeze the date string from the system prompt
    // and only update it on cache-busting passes. This prevents a midnight date
    // flip from causing an unnecessary flush + cache rebuild.
    const stickyDateBySession = new Map<string, string>();

    const handler = async (
        input: { sessionID?: string },
        output: { system: string[] },
    ): Promise<void> => {
        const sessionId = input.sessionID;
        if (!sessionId) return;

        // ── Skip OpenCode's internal hidden agents ──
        //
        // OpenCode invokes `experimental.chat.system.transform` for ALL llm
        // calls inside a session, including its three native hidden agents:
        //   - "title": runs once on the first user turn against `small_model`
        //              (or the small variant of the active model) to generate
        //              a session title from the first message.
        //   - "summary": session export / pull-request-style description.
        //   - "compaction": OpenCode's own auto-compaction summarizer.
        //
        // These agents:
        //   1. Don't benefit from magic-context guidance (they have a fixed
        //      single-shot job — no tools, no `ctx_reduce`, no nudges).
        //   2. Get hit with our `<project-docs>`, `<user-profile>`,
        //      `<key-files>`, and the multi-paragraph guidance block, which
        //      can multiply their input by 10× for a tiny single-line output.
        //   3. Often run on a smaller/cheaper model where the extra prompt
        //      content is wasted spend.
        //
        // The hook contract gives us only `{ sessionID, model }`, so we can't
        // dispatch on agent name. We detect them by signature lines from
        // their prompts in OpenCode source (`packages/opencode/src/agent/prompt/`).
        // These signatures are stable across OpenCode releases — they're the
        // first instruction lines of each internal prompt.
        const fullPromptForDetection = output.system.join("\n");
        if (isInternalOpenCodeAgent(fullPromptForDetection)) {
            sessionLog(
                sessionId,
                "system-prompt-hash skipped (OpenCode internal agent: title/summary/compaction)",
            );
            return;
        }

        // ── Skip Magic Context's OWN hidden children ──
        // historian/dreamer/sidekick/memory-migration must not get the MC
        // guidance block (wasted spend + contradictory identity frame). Two
        // signals: the title-prefix flag (set at session.created) and the
        // prompt-signature (timing-independent, reliable on pass 1). Either
        // match skips ALL injection + hash tracking.
        if (
            deps.internalChildSessions?.has(sessionId) ||
            isMagicContextInternalAgent(fullPromptForDetection)
        ) {
            sessionLog(
                sessionId,
                "system-prompt-hash skipped (Magic Context internal child: historian/dreamer/sidekick/migration)",
            );
            return;
        }

        // ── Issue #53: user-controlled per-agent opt-out ──
        //
        // Two layers, both honored here:
        //   1. Global: `system_prompt_injection.enabled: false` → skip
        //      injection for every agent. Useful when a user wants Magic
        //      Context to manage history but never touch the system prompt.
        //   2. Per-agent: `system_prompt_injection.skip_signatures` →
        //      substring opt-out. The user adds the signature (default
        //      `<!-- magic-context: skip -->`) inside their custom agent's
        //      prompt; whenever that agent fires, we skip injection for
        //      that call only.
        //
        // Both paths skip ALL injection (guidance, project docs, user
        // profile, key files, sticky date) AND skip hash tracking — like
        // the internal-agent skip above. Hash tracking is intentionally
        // skipped so a deny-listed agent's system prompt doesn't compete
        // with the main agent's hash, which would cause cross-agent
        // hash-change flushes.
        const injectionEnabled = deps.injectionEnabled !== false;
        const skipSignatures = deps.injectionSkipSignatures ?? [];
        if (!injectionEnabled) {
            sessionLog(sessionId, "system-prompt-hash skipped (injection globally disabled)");
            return;
        }
        if (skipSignatures.some((sig) => sig.length > 0 && fullPromptForDetection.includes(sig))) {
            sessionLog(
                sessionId,
                "system-prompt-hash skipped (matched system_prompt_injection.skip_signatures)",
            );
            return;
        }

        // ── Step 1: Inject magic-context guidance ──
        // Subagents with callable ctx_reduce get only the minimal drop mechanics
        // guidance. Subagents without the tool get no Magic Context guidance,
        // because the primary-session no-reduce block would incorrectly describe
        // memory/search/note behavior for a bounded, parent-driven child task.
        let sessionMetaEarly: import("../../features/magic-context/types").SessionMeta | undefined;
        try {
            sessionMetaEarly = getOrCreateSessionMeta(deps.db, sessionId);
        } catch (error) {
            sessionLog(sessionId, "system-prompt-hash session meta load failed:", error);
        }
        const isSubagentSession = sessionMetaEarly?.isSubagent === true;
        // A session whose spawn tools map filters ctx_reduce out (parent
        // allow-lists) must be treated like ctx_reduce-disabled: reduce
        // guidance for an uncallable tool is overhead + cargo-cult risk.
        // The verdict freezes on the session's first user message; before that
        // exists it is a PROVISIONAL fail-open default. Guidance still renders
        // from the provisional value (a prompt must go out), but the hash write
        // below is gated on `frozen` so a provisional reduce-enabled prompt is
        // never persisted as the session's baseline — if the first user message
        // then denies the tool, the variant settles BEFORE any hash existed,
        // instead of flipping a persisted hash and busting the prompt cache.
        const availability = resolveCtxReduceAvailability(sessionId);
        const ctxReduceCallable = availability.callable;
        const subagentReduceMode = isSubagentSession && ctxReduceCallable;
        const effectiveCtxReduceEnabled = isSubagentSession ? false : ctxReduceCallable;
        // A subagent without callable ctx_reduce gets no MC guidance.
        const skipGuidanceForDisabledSubagent = isSubagentSession && !ctxReduceCallable;
        const fullPrompt = output.system.join("\n");
        if (
            fullPrompt.length > 0 &&
            !fullPrompt.includes(MAGIC_CONTEXT_MARKER) &&
            !skipGuidanceForDisabledSubagent
        ) {
            const guidance = buildMagicContextSection(
                null,
                deps.protectedTags,
                effectiveCtxReduceEnabled,
                deps.dreamerEnabled,
                deps.experimentalTemporalAwareness,
                deps.experimentalCavemanTextCompression,
                subagentReduceMode,
                deps.language,
                deps.memoryEnabled !== false,
            );
            output.system.push(guidance);
            sessionLog(
                sessionId,
                `injected generic guidance into system prompt (ctxReduce=${effectiveCtxReduceEnabled}, subagent=${isSubagentSession}, subagentReduceMode=${subagentReduceMode})`,
            );
        }

        // ── Step 1.5: m[0]/m[1]-resident adjuncts ──
        // Project docs, user profile, and key files intentionally do NOT
        // enter the system prompt in cache architecture v2.0. Project docs
        // and baseline user profile are materialized into m[0]; key files
        // are the volatile resident at m[1]. Keep only guidance + sticky
        // date in system so BP1 remains stable.
        const isCacheBusting = deps.systemPromptRefreshSessions.has(sessionId);

        // ── Step 2: Freeze volatile date to prevent unnecessary cache busts ──
        const DATE_PATTERN = /Today's date: .+/;

        for (let i = 0; i < output.system.length; i++) {
            const match = output.system[i].match(DATE_PATTERN);
            if (!match) continue;

            const currentDate = match[0];
            const stickyDate = stickyDateBySession.get(sessionId);

            if (!stickyDate) {
                // First time seeing this session — store the date
                stickyDateBySession.set(sessionId, currentDate);
            } else if (currentDate !== stickyDate) {
                if (isCacheBusting) {
                    // Cache is already busting — update to the real date
                    stickyDateBySession.set(sessionId, currentDate);
                    sessionLog(
                        sessionId,
                        `system prompt date updated: ${stickyDate} → ${currentDate} (cache-busting pass)`,
                    );
                } else {
                    // Defer pass — replace with the sticky date to keep prompt stable
                    output.system[i] = output.system[i].replace(DATE_PATTERN, stickyDate);
                    sessionLog(
                        sessionId,
                        `system prompt date frozen: real=${currentDate}, using=${stickyDate} (defer pass)`,
                    );
                }
            }
            break;
        }

        // ── Step 3: Detect system prompt changes ──
        const systemContent = output.system.join("\n");
        if (systemContent.length === 0) return;

        // Provisional availability (no first user message persisted yet): the
        // guidance above may be the wrong variant for this session. Do not
        // initialize or compare the persisted hash from it — the first pass with
        // a frozen verdict owns the baseline. Skipping here means the variant
        // settles before any hash is written, so a deny-list session's prompt
        // never records a reduce-enabled hash it would immediately flip.
        if (!availability.frozen) return;

        // Use hex digest — numeric strings get coerced by SQLite INTEGER column affinity,
        // causing precision loss on read-back and infinite hash-change flushes.
        // node:crypto MD5 produces identical digests to Bun.CryptoHasher("md5"),
        // so persisted hashes remain stable across the Bun→Node runtime swap.
        const currentHash = createHash("md5").update(systemContent).digest("hex");

        // Reuse sessionMetaEarly from Step 1 — no code path between that read
        // and here mutates session_meta for this session, so a second DB read
        // would return identical data. If Step 1's read failed (sessionMetaEarly
        // is undefined), bail rather than re-attempting: we already logged the
        // error and can't make an informed hash-change decision without the
        // previous hash.
        if (!sessionMetaEarly) {
            return;
        }
        const sessionMeta = sessionMetaEarly;
        const previousHash = sessionMeta.systemPromptHash;
        if (previousHash !== "" && previousHash !== "0" && previousHash !== currentHash) {
            sessionLog(
                sessionId,
                `system prompt hash changed: ${previousHash} → ${currentHash} (len=${systemContent.length}), triggering flush`,
            );
            // Real prompt-content change: signal all three independent
            // refresh lifetimes. The Anthropic prompt-cache prefix is already
            // busted on this turn, so we want history rebuild + adjunct
            // refresh + materialization on the same cycle.
            deps.historyRefreshSessions.add(sessionId);
            deps.systemPromptRefreshSessions.add(sessionId);
            deps.pendingMaterializationSessions.add(sessionId);
            deps.lastHeuristicsTurnId.delete(sessionId);
        } else if (previousHash === "" || previousHash === "0") {
            sessionLog(
                sessionId,
                `system prompt hash initialized: ${currentHash} (len=${systemContent.length})`,
            );
        }

        // Estimate system prompt tokens for dashboard visibility only when
        // the prompt hash changed; unchanged prompts keep the stored count.
        //
        // FAIL-OPEN (per-turn handler rule): the prompt has ALREADY been mutated
        // in place above (guidance + sticky date). estimateTokens can throw on a
        // pathological tokenizer input and updateSessionMeta can throw on a busy/
        // failing DB — neither must propagate into the prompt path (a throw here
        // would fail the LLM call instead of just losing a telemetry write). Persist
        // the hash even if token estimation fails, so the next pass doesn't re-detect
        // a phantom hash change and re-flush.
        if (currentHash !== previousHash) {
            let systemPromptTokens = sessionMeta.systemPromptTokens;
            try {
                systemPromptTokens = estimateTokens(systemContent);
            } catch (error) {
                sessionLog(
                    sessionId,
                    "system prompt token estimate failed (using prior count):",
                    error,
                );
            }
            try {
                updateSessionMeta(deps.db, sessionId, {
                    systemPromptHash: currentHash,
                    systemPromptTokens,
                });
            } catch (error) {
                sessionLog(sessionId, "system prompt meta persist failed (fail-open):", error);
            }
        }

        // ── Step 4: Drain systemPromptRefreshSessions (one-shot semantics) ──
        // We've consumed the signal: adjuncts have been re-read or kept
        // cached as appropriate, sticky date has been updated or frozen,
        // and the hash has been re-evaluated. Future defer passes within
        // the same TTL window MUST hit cached adjunct values to keep the
        // system-prompt cache prefix stable.
        //
        // CRITICAL: drain conditionally on the value captured at the top
        // of the handler (`isCacheBusting` from line 201). Two distinct
        // cases hinge on this:
        //
        // 1. Flag was already set when handler started → adjuncts were
        //    refreshed in Step 1.5 above using the live `isCacheBusting`
        //    value. Signal consumed; drain it.
        //
        // 2. Flag was added LATER in Step 3 by hash-change detection
        //    (lines 401-403) → adjuncts in Step 1.5 used STALE cache
        //    because `isCacheBusting` was captured before the add.
        //    The just-added flag must survive to the NEXT pass so
        //    adjuncts can finally refresh. An unconditional drain here
        //    would silently drop that signal, leaving adjuncts stale
        //    forever.
        //
        // Early returns at lines 375 / 388 also benefit: they preserve
        // any pre-existing flag set by `/ctx-flush` or variant change so
        // the next valid pass can consume it.
        //
        // See Oracle review 2026-04-26 Finding A1 for the bug this fixes.
        if (isCacheBusting) {
            deps.systemPromptRefreshSessions.delete(sessionId);
        }
    };

    return {
        handler,
        clearSession: (sessionId: string) => {
            clearSystemPromptHashSession(sessionId, {
                stickyDateBySession,
                cachedDocsBySession: new Map(),
            });
        },
    };
}
