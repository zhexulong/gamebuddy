import { DREAMER_REVIEWER_AGENT } from "../../../agents/dreamer";
import { withContentLanguageDirective } from "../../../agents/language-directive";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { describeError, getErrorMessage } from "../../../shared/error-message";
import { log } from "../../../shared/logger";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import { DREAMING_LEASE_KEY, runLeaseGuardedWrite, startLeaseHeartbeat } from "../dreamer/lease";
import { REVIEW_USER_MEMORIES_SYSTEM_PROMPT } from "../dreamer/task-prompts";
import { bumpProjectUserProfileVersion } from "../storage";
import { recordChildInvocation } from "../subagent-token-capture";
import {
    deleteUserMemoryCandidates,
    dismissUserMemory,
    getActiveUserMemories,
    getUserMemoryCandidates,
    insertUserMemory,
    pruneExpiredUserMemoryCandidates,
    USER_MEMORY_CANDIDATE_TTL_MS,
    updateUserMemoryContent,
} from "./storage-user-memory";

interface ReviewUserMemoriesArgs {
    db: Database;
    client: PluginContext["client"];
    parentSessionId: string | undefined;
    sessionDirectory: string | undefined;
    holderId: string;
    /** Keyed lease this task holds (Dreamer v2: global user-memories domain).
     *  Defaults to the legacy single lease key for back-compat. */
    leaseKey?: string;
    deadline: number;
    promotionThreshold: number;
    /** Per-task model override (Dreamer v2). */
    model?: string;
    /** Resolved dreamer fallback chain. */
    fallbackModels?: readonly string[];
    language?: string;
}

interface ReviewResult {
    promoted: number;
    merged: number;
    dismissed: number;
    candidatesConsumed: number;
}

export async function reviewUserMemories(args: ReviewUserMemoriesArgs): Promise<ReviewResult> {
    const result: ReviewResult = { promoted: 0, merged: 0, dismissed: 0, candidatesConsumed: 0 };

    // Decay first: prune one-off candidates older than the TTL that never
    // accumulated enough corroboration to promote, so the pool can't fill with
    // stale noise under the threshold. Runs every scheduled review (daily).
    const prunedExpired = pruneExpiredUserMemoryCandidates(args.db, USER_MEMORY_CANDIDATE_TTL_MS);
    if (prunedExpired > 0) {
        log(`[dreamer] user-memories: decayed ${prunedExpired} expired candidate(s)`);
    }

    const candidates = getUserMemoryCandidates(args.db);
    if (candidates.length < args.promotionThreshold) {
        log(
            `[dreamer] user-memories: ${candidates.length} candidate(s), need ${args.promotionThreshold} — skipping`,
        );
        return result;
    }

    const stableMemories = getActiveUserMemories(args.db);
    log(
        `[dreamer] user-memories: reviewing ${candidates.length} candidate(s) against ${stableMemories.length} stable memorie(s)`,
    );

    const candidateList = candidates
        .map((c) => `- Candidate #${c.id} [session ${c.sessionId.slice(0, 12)}]: "${c.content}"`)
        .join("\n");

    const stableList =
        stableMemories.length > 0
            ? stableMemories.map((m) => `- Memory #${m.id}: "${m.content}"`).join("\n")
            : "(none)";

    const prompt = `## Task: Review User Memory Candidates

You are reviewing behavioral observations about a human user to decide which patterns are real and persistent.

### Current Stable User Memories
${stableList}

### Candidate Observations (from recent historian runs)
${candidateList}

### Instructions

1. Look for **recurring patterns** across multiple candidates — observations that appear independently from different sessions or historian runs indicate a real user trait.
2. A candidate must appear in at least ${args.promotionThreshold} semantically similar variants before promotion.
3. Only promote **truly universal** user traits — communication style, expertise level, review focus, decision-making patterns, working habits.
4. Do NOT promote: project-specific preferences, framework choices, one-off moods, task-local frustrations.
5. If a candidate is semantically equivalent to an existing stable memory, mark it as already covered.
6. If multiple candidates describe the same trait, merge them into one clean statement.
7. If an existing stable memory should be updated based on new evidence, include the update.

### Output Format

Return valid JSON (no markdown fencing):

{
  "promote": [
    { "content": "Clean universal observation text", "candidate_ids": [1, 3, 7] }
  ],
  "update_existing": [
    { "memory_id": 5, "content": "Updated text incorporating new evidence", "candidate_ids": [2] }
  ],
  "dismiss_existing": [
    { "memory_id": 3, "reason": "No longer supported by recent observations" }
  ],
  "consume_candidate_ids": [1, 2, 3, 4, 5, 7, 8]
}

- \`promote\`: new stable memories to create from candidates
- \`update_existing\`: existing stable memories to rewrite with new evidence
- \`dismiss_existing\`: existing stable memories that are no longer valid
- \`consume_candidate_ids\`: ALL candidate IDs that were reviewed (promoted, merged, or rejected) — they will be deleted from the candidate pool

If no promotions are warranted, return empty arrays. Always consume reviewed candidates so they don't accumulate indefinitely.`;

    let agentSessionId: string | null = null;
    const startedAt = Date.now();
    let invocationRecorded = false;
    const recordInvocation = (params: {
        status: "completed" | "failed";
        messages?: unknown[];
        error?: unknown;
    }) => {
        if (!args.parentSessionId || invocationRecorded) return;
        invocationRecorded = true;
        recordChildInvocation({
            db: args.db,
            parentSessionId: args.parentSessionId,
            harness: "opencode",
            // subagent: "dreamer" + task: "user memories" so the dashboard's
            // dream-run token enrichment (filters subagent='dreamer', GROUP BY
            // task) maps this invocation's tokens to the "user memories" row.
            // The task name MUST match the phase name pushed by the dreamer
            // runner. Mirrors the smart-notes precedent.
            subagent: "dreamer",
            // Canonical v2 task name — MUST match the dream_runs row name
            // (config.task) so the dashboard's task GROUP BY join lines up.
            task: "review-user-memories",
            startedAt,
            status: params.status,
            messages: params.messages,
            error: params.error,
        });
    };
    const leaseKey = args.leaseKey ?? DREAMING_LEASE_KEY;
    const abortController = new AbortController();
    const heartbeat = startLeaseHeartbeat(args.db, args.holderId, leaseKey, (reason) => {
        log(`[dreamer] user-memories: lease lost (${reason}) — aborting`);
        abortController.abort();
    });

    try {
        const createResponse = await args.client.session.create({
            body: {
                ...(args.parentSessionId ? { parentID: args.parentSessionId } : {}),
                title: "magic-context-dream-user-memories",
            },
            query: { directory: args.sessionDirectory },
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            { preferResponseOnMissingData: true },
        );
        agentSessionId = typeof created?.id === "string" ? created.id : null;
        if (!agentSessionId) {
            const error = new Error("Could not create user memory review session.");
            recordInvocation({ status: "failed", error });
            throw error;
        }

        log(`[dreamer] user-memories: child session created ${agentSessionId}`);
        const childSessionId = agentSessionId;

        const remainingMs = Math.max(0, args.deadline - Date.now());
        const reviewRun = await shared.promptSyncWithValidatedOutputRetry(
            args.client,
            {
                path: { id: childSessionId },
                query: { directory: args.sessionDirectory },
                body: {
                    agent: DREAMER_REVIEWER_AGENT,
                    system: withContentLanguageDirective(
                        REVIEW_USER_MEMORIES_SYSTEM_PROMPT,
                        args.language,
                    ),
                    ...modelBodyField(args.model),
                    // synthetic: true hides the user-memory review prompt from the TUI
                    // subagent pane while still delivering it to the model. See issue #50.
                    parts: [{ type: "text", text: prompt, synthetic: true }],
                },
            },
            {
                // The executor owns the per-task deadline (config.timeoutMinutes);
                // honor the remaining budget, do NOT silently re-cap at 5 minutes.
                timeoutMs: remainingMs,
                signal: abortController.signal,
                fallbackModels: args.fallbackModels,
                callContext: "dreamer:user-memories",
                fetchOutput: async () => {
                    const messagesResponse = await args.client.session.messages({
                        path: { id: childSessionId },
                        query: { directory: args.sessionDirectory, limit: 50 },
                    });
                    return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                        preferResponseOnMissingData: true,
                    });
                },
                validateOutput: (messages) => {
                    const responseText = extractLatestAssistantText(messages);
                    if (!responseText) {
                        throw new Error("User memory review returned no output.");
                    }

                    // Parse the JSON response — try to extract from possible markdown fencing
                    const jsonMatch =
                        responseText.match(/```(?:json)?\s*([\s\S]*?)```/) ??
                        responseText.match(/(\{[\s\S]*\})/);
                    if (!jsonMatch) {
                        throw new Error("User memory review returned no JSON.");
                    }

                    try {
                        return JSON.parse(jsonMatch[1]) as {
                            promote?: Array<{ content: string; candidate_ids: number[] }>;
                            update_existing?: Array<{
                                memory_id: number;
                                content: string;
                                candidate_ids?: number[];
                            }>;
                            dismiss_existing?: Array<{ memory_id: number; reason?: string }>;
                            consume_candidate_ids?: number[];
                        };
                    } catch {
                        throw new Error("User memory review returned invalid JSON.");
                    }
                },
            },
        );

        recordInvocation({ status: "completed", messages: reviewRun.output });
        const parsed = reviewRun.validated;

        const promotions = (parsed.promote ?? [])
            .map((p) => ({
                content: p.content?.trim() ?? "",
                candidateIds: p.candidate_ids ?? [],
            }))
            .filter((p) => p.content.length > 0);
        const updates = (parsed.update_existing ?? [])
            .map((u) => ({
                memoryId: u.memory_id,
                content: u.content?.trim() ?? "",
            }))
            .filter((u) => Boolean(u.memoryId) && u.content.length > 0);
        const dismissals = (parsed.dismiss_existing ?? []).filter((d) => Boolean(d.memory_id));
        const consumeCandidateIds = parsed.consume_candidate_ids ?? [];

        // Re-check the lease only after BEGIN IMMEDIATE has serialized writers.
        // A lost lease throws so the executor hot-retries instead of recording
        // completion and advancing next_due_at past unprocessed work.
        runLeaseGuardedWrite(args.db, args.holderId, leaseKey, () => {
            for (const promotion of promotions) {
                insertUserMemory(args.db, promotion.content, promotion.candidateIds);
            }

            for (const update of updates) {
                updateUserMemoryContent(args.db, update.memoryId, update.content);
            }

            for (const dismissal of dismissals) {
                dismissUserMemory(args.db, dismissal.memory_id);
            }

            if (consumeCandidateIds.length > 0) {
                deleteUserMemoryCandidates(args.db, consumeCandidateIds);
            }

            if (promotions.length > 0 || updates.length > 0 || dismissals.length > 0) {
                bumpProjectUserProfileVersion(args.db);
            }
        });

        result.promoted = promotions.length;
        result.merged = updates.length;
        result.dismissed = dismissals.length;
        result.candidatesConsumed = consumeCandidateIds.length;

        for (const promotion of promotions) {
            log(`[dreamer] user-memories: promoted "${promotion.content.slice(0, 60)}..."`);
        }
        for (const update of updates) {
            log(`[dreamer] user-memories: updated memory #${update.memoryId}`);
        }
        for (const dismissal of dismissals) {
            log(
                `[dreamer] user-memories: dismissed memory #${dismissal.memory_id} — ${dismissal.reason ?? "no reason"}`,
            );
        }
        if (consumeCandidateIds.length > 0) {
            log(`[dreamer] user-memories: consumed ${result.candidatesConsumed} candidate(s)`);
        }

        return result;
    } catch (error) {
        const errorDescription = describeError(error);
        log(
            `[dreamer] user-memories: review failed: ${errorDescription.brief}`,
            errorDescription.stackHead ? { stackHead: errorDescription.stackHead } : undefined,
        );
        recordInvocation({ status: "failed", error });
        // Rethrow so the executor records this run as failed and the scheduler
        // does NOT advance next_due_at past unprocessed work. A prior silent
        // `return result` reported a successful empty run, skipping the task until
        // its next cron slot (Oracle P1). classifyFailure decides transient vs
        // permanent (lease/timeout/network → hot-retry; parse/validation → wait).
        throw error;
    } finally {
        heartbeat.stop();
        // PRIVACY: this child prompt embeds cross-session user behavior. Always
        // delete it, even on failure and even when debug subagent retention is
        // enabled, so personal data is not left in the OpenCode session store.
        if (agentSessionId) {
            await args.client.session
                .delete({
                    path: { id: agentSessionId },
                    query: { directory: args.sessionDirectory },
                })
                .catch((e: unknown) => {
                    log(`[dreamer] user-memories: session cleanup failed: ${getErrorMessage(e)}`);
                });
        }
    }
}
