import { DREAMER_CLASSIFIER_AGENT } from "../../../agents/dreamer";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import {
    extractLatestAssistantText,
    hasLengthCappedOutput,
} from "../../../shared/assistant-message-extractor";
import { describeError, getErrorMessage } from "../../../shared/error-message";
import { shouldKeepSubagents } from "../../../shared/keep-subagents";
import { log } from "../../../shared/logger";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import { runLeaseGuardedWrite, startLeaseHeartbeat } from "../dreamer/lease";
import { assertManifestCoversExactly } from "../dreamer/manifest-parser";
import { getMemoriesByProject, type Memory } from "../memory";
import {
    buildCompressCuesPrompt,
    COMPRESS_CUES_SYSTEM_PROMPT,
    type CompressCuesPromptMemory,
    parseCuesManifest,
} from "./compress-cues-prompt";
import { validateCue } from "./cue-validation";
import {
    computeCueContentHash,
    getMuralCueState,
    memoryNeedsCue,
    setMuralCue,
} from "./storage-mural-cues";

/**
 * compress-cues: a NON-agentic single-shot transform (classify-memories shape).
 * For each project memory whose cue is missing or stale, the host renders one
 * prompt per chunk, a zero-tool agent emits ONE <cues> XML manifest, and the
 * host validates each cue and applies COLUMN-ONLY writes (mural_cue). No
 * per-memory tool calls; no selection/ranking/packing (those are deterministic
 * in resolveMural / renderMural).
 *
 * Gate: mural_cue IS NULL OR mural_cue_hash != sha256(content). Resumable — cues
 * are written per memory, so a partial run sticks and the next run picks up the
 * remaining gate set.
 *
 * Economics: chunks are small (~40 memories), so after the initial backfill the
 * daily trickle is cheap. First run on a 470-memory pool is ~12 chunks; steady
 * state is a handful of new/edited memories per day.
 */

/** Memories per compress call. Small so peak context stays bounded and a
 *  partial run leaves little re-work; the daily cadence drains any backlog. */
export const COMPRESS_CUES_CHUNK_SIZE = 40;

/** Minimum wall-clock budget a single chunk is allowed before we consider it
 *  doomed. runCompressCues divides the remaining task deadline evenly across the
 *  chunks still to run; on a large backfill (e.g. a 470-memory pool = 12 chunks)
 *  that even split can hand a slow thinking model far less than it needs, so
 *  every chunk times out, contributes 0 cues, and the loop burns the whole
 *  deadline (and model quota) marching through chunks that can never finish.
 *  The floor keeps each attempted chunk's slice at least this large, and if the
 *  remaining budget drops below it we stop the run and bank progress instead of
 *  starting a chunk we already know cannot complete. */
export const CHUNK_TIMEOUT_FLOOR_MS = 240_000;

/** How many chunks in a row may fail with a timeout-class error before the run
 *  stops early. A model that is consistently slower than its time slice will
 *  time out every chunk; continuing just burns the remaining chunks and quota.
 *  Two consecutive timeouts is enough to conclude the model cannot keep up
 *  within its slice, while still tolerating a single flaky/transient timeout. */
const CONSECUTIVE_TIMEOUT_LIMIT = 2;

export interface CompressCuesArgs {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string;
    holderId: string;
    leaseKey: string;
    deadline: number;
    model?: string;
    fallbackModels?: readonly string[];
}

/** How a chunk failed, used by the run loop to decide whether to keep going.
 *  "timeout" means the model did not finish within its time slice; "other"
 *  covers validation failures (bad/missing manifest, length cap) and provider
 *  errors, which keep the existing per-chunk retry-next-run behavior. */
type ChunkFailureClass = "timeout" | "other";

interface ChunkOutcome {
    compressed: number;
    skipped: number;
    /** Present only when the chunk failed. Carries the failure class plus the
     *  measured elapsed time so the run loop can log how long the doomed chunk
     *  actually ran (helps an operator size chunk vs model). */
    failure?: {
        class: ChunkFailureClass;
        brief: string;
        elapsedMs: number;
    };
}

export interface CompressCuesResult {
    /** Cues written this run (memories whose cue moved from missing/stale to set). */
    compressed: number;
    /** Cues the model returned that failed per-cue validation and were skipped. */
    skipped: number;
    chunks: number;
    remaining: number;
    complete: boolean;
}

/** A memory selected for (re)compression plus the content hash captured at
 *  SELECTION time. Storing this hash (not a re-hash at write time) is the race
 *  guard: if the memory is edited between selection and write, the stored hash
 *  won't match the new content, so resolveMural excludes the cue and the gate
 *  re-selects the memory next run — it never adopts a cue for content it wasn't
 *  compressed from. */
interface CueCandidate {
    memory: Memory;
    contentHash: string;
}

function toPromptMemory(candidate: CueCandidate): CompressCuesPromptMemory {
    const memory = candidate.memory;
    return {
        id: memory.id,
        category: memory.category,
        importance: memory.importance ?? 50,
        content: memory.content,
    };
}

/** Select the memories whose cue is missing or stale (content hash mismatch). */
function selectCandidates(db: Database, projectIdentity: string): CueCandidate[] {
    const memories = getMemoriesByProject(db, projectIdentity, ["active", "permanent"]);
    const cueState = getMuralCueState(
        db,
        memories.map((memory) => memory.id),
    );
    const candidates: CueCandidate[] = [];
    for (const memory of memories) {
        if (memoryNeedsCue(cueState.get(memory.id), memory.content)) {
            candidates.push({ memory, contentHash: computeCueContentHash(memory.content) });
        }
    }
    return candidates;
}

/** Compute the wall-clock slice for the next chunk: an even split of the
 *  remaining budget across the chunks still to run, but never below
 *  CHUNK_TIMEOUT_FLOOR_MS (a slice smaller than the model needs guarantees a
 *  timeout) and never more than the budget actually remaining. Exported for
 *  test; the run loop calls this once per chunk. */
export function computeChunkSliceMs(remainingMs: number, chunksRemaining: number): number {
    return Math.min(
        remainingMs,
        Math.max(CHUNK_TIMEOUT_FLOOR_MS, Math.floor(remainingMs / chunksRemaining)),
    );
}

export async function runCompressCues(args: CompressCuesArgs): Promise<CompressCuesResult> {
    const candidates = selectCandidates(args.db, args.projectIdentity);
    const result: CompressCuesResult = {
        compressed: 0,
        skipped: 0,
        chunks: 0,
        remaining: candidates.length,
        complete: candidates.length === 0,
    };
    if (candidates.length === 0) {
        log(`[dreamer] compress-cues: nothing to compress for ${args.projectIdentity}`);
        return result;
    }

    const chunks: CueCandidate[][] = [];
    for (let i = 0; i < candidates.length; i += COMPRESS_CUES_CHUNK_SIZE) {
        chunks.push(candidates.slice(i, i + COMPRESS_CUES_CHUNK_SIZE));
    }

    const abortController = new AbortController();
    const heartbeat = startLeaseHeartbeat(args.db, args.holderId, args.leaseKey, () =>
        abortController.abort(),
    );
    try {
        let consecutiveTimeouts = 0;
        // Elapsed time of each chunk in the current consecutive-timeout streak,
        // logged when the breaker trips so an operator can size chunk vs model.
        let timeoutStreakElapsedMs: number[] = [];
        for (let i = 0; i < chunks.length; i += 1) {
            const remainingMs = Math.max(0, args.deadline - Date.now());
            if (remainingMs <= 0) break;
            // Not enough budget left to give this chunk a fair (>= floor) slice.
            // Starting it would just produce another timeout, so stop here and
            // bank progress: cues already written are durable per memory, and the
            // incomplete result keeps this task transient so cron retries it.
            if (remainingMs < CHUNK_TIMEOUT_FLOOR_MS) {
                log(
                    `[dreamer] compress-cues: stopping before chunk ${i + 1}/${chunks.length} — remaining budget ${remainingMs}ms is below the ${CHUNK_TIMEOUT_FLOOR_MS}ms chunk floor; banking ${result.compressed} compressed cue(s)`,
                );
                break;
            }
            // Even-split the remaining budget across the chunks still to run, but
            // never hand a chunk less than the floor (a slice too small for the
            // model guarantees a timeout).
            const sliceMs = computeChunkSliceMs(remainingMs, chunks.length - i);
            const outcome = await compressOneChunk(
                args,
                chunks[i]!,
                sliceMs,
                abortController.signal,
            );
            result.compressed += outcome.compressed;
            result.skipped += outcome.skipped;
            result.remaining -= outcome.compressed;
            result.chunks += 1;

            if (outcome.failure?.class === "timeout") {
                consecutiveTimeouts += 1;
                timeoutStreakElapsedMs.push(outcome.failure.elapsedMs);
                if (consecutiveTimeouts >= CONSECUTIVE_TIMEOUT_LIMIT) {
                    // Circuit breaker: the model is consistently slower than its
                    // time slice. Stop now instead of burning the remaining chunks
                    // (and model quota) on attempts that will also time out.
                    log(
                        `[dreamer] compress-cues: circuit breaker tripped — ${consecutiveTimeouts} consecutive chunk timeouts (model too slow for its time slice); per-chunk elapsed [${timeoutStreakElapsedMs.join("ms, ")}ms] vs ${sliceMs}ms slice; stopping run incomplete with ${chunks.length - i - 1} chunk(s) unattempted`,
                    );
                    break;
                }
            } else {
                // A success or a non-timeout failure (validation/provider) breaks
                // the streak: those keep the existing retry-next-run behavior and
                // must not trip the timeout breaker.
                consecutiveTimeouts = 0;
                timeoutStreakElapsedMs = [];
            }
        }
        result.complete = result.remaining === 0;
        log(
            `[dreamer] compress-cues: compressed=${result.compressed} skipped=${result.skipped} chunks=${result.chunks} remaining=${result.remaining} complete=${result.complete}`,
        );
        return result;
    } finally {
        heartbeat.stop();
    }
}

/** True when a chunk failed because the model did not finish within its time
 *  slice — the "prompt timed out after Nms" error thrown by promptWithTimeout in
 *  shared/model-suggestion-retry. Validation failures (bad/missing manifest,
 *  length-capped output) and provider errors are deliberately NOT timeout-class:
 *  those keep the existing per-chunk retry-next-run behavior and must not trip
 *  the consecutive-timeout circuit breaker. */
function isTimeoutClassError(error: unknown): boolean {
    return error instanceof Error && /^prompt timed out after \d+ms$/.test(error.message);
}

async function compressOneChunk(
    args: CompressCuesArgs,
    chunk: CueCandidate[],
    sliceMs: number,
    signal: AbortSignal,
): Promise<ChunkOutcome> {
    let agentSessionId: string | null = null;
    const startedAt = Date.now();
    try {
        const prompt = buildCompressCuesPrompt({
            projectPath: args.projectIdentity,
            memories: chunk.map(toPromptMemory),
        });

        const createResponse = await args.client.session.create({
            body: {
                ...(args.parentSessionId ? { parentID: args.parentSessionId } : {}),
                title: "magic-context-dream-compress-cues",
            },
            query: { directory: args.sessionDirectory },
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            {
                preferResponseOnMissingData: true,
            },
        );
        agentSessionId = typeof created?.id === "string" ? created.id : null;
        if (!agentSessionId) throw new Error("Could not create compress-cues session.");

        const run = await shared.promptSyncWithValidatedOutputRetry(
            args.client,
            {
                path: { id: agentSessionId },
                query: { directory: args.sessionDirectory },
                body: {
                    agent: DREAMER_CLASSIFIER_AGENT,
                    system: COMPRESS_CUES_SYSTEM_PROMPT,
                    ...modelBodyField(args.model),
                    parts: [{ type: "text", text: prompt, synthetic: true }],
                },
            },
            {
                timeoutMs: sliceMs,
                signal,
                fallbackModels: args.fallbackModels,
                callContext: "dreamer:compress-cues",
                fetchOutput: async () => {
                    const messagesResponse = await args.client.session.messages({
                        path: { id: agentSessionId as string },
                        query: { directory: args.sessionDirectory, limit: 50 },
                    });
                    return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                        preferResponseOnMissingData: true,
                    });
                },
                validateOutput: (messages) => {
                    if (hasLengthCappedOutput(messages)) {
                        throw new Error("compress-cues returned length-capped output");
                    }
                    const text = extractLatestAssistantText(messages);
                    if (!text) throw new Error("compress-cues returned no output");
                    // Fail-closed root parse: a missing/truncated <cues> root rejects
                    // the whole chunk here (no partial apply from a truncated reply).
                    parseCuesManifest(text);
                    return text;
                },
            },
        );

        return applyCues(args, chunk, run.validated);
    } catch (error) {
        const desc = describeError(error);
        log(
            `[dreamer] compress-cues chunk failed: ${desc.brief}`,
            desc.stackHead ? { stackHead: desc.stackHead } : undefined,
        );
        // A chunk failure is not fatal to the run: other chunks still compress,
        // and this chunk's memories stay NULL and are retried next run. Rethrow
        // only on abort (lease lost / deadline) so the scheduler records it.
        if (signal.aborted) throw error;
        // Classify the failure so the run loop can drive the consecutive-timeout
        // circuit breaker. The measured elapsed time lets the operator compare
        // how long the model actually ran against the slice it was given.
        return {
            compressed: 0,
            skipped: 0,
            failure: {
                class: isTimeoutClassError(error) ? "timeout" : "other",
                brief: desc.brief,
                elapsedMs: Date.now() - startedAt,
            },
        };
    } finally {
        if (agentSessionId && !shouldKeepSubagents()) {
            await args.client.session
                .delete({
                    path: { id: agentSessionId },
                    query: { directory: args.sessionDirectory },
                })
                .catch((e: unknown) => {
                    log(`[dreamer] compress-cues session cleanup failed: ${getErrorMessage(e)}`);
                });
        }
    }
}

/**
 * Validate each returned cue independently and write the valid ones as
 * column-only updates. A cue that fails validation is SKIPPED (its memory keeps
 * a NULL cue and is retried next run) — never rejecting the whole chunk for one
 * bad cue. The stored hash is the SELECTION-time content hash, so a memory
 * edited mid-run doesn't adopt a cue compressed from its old content.
 */
export function applyCues(
    args: CompressCuesArgs,
    chunk: CueCandidate[],
    manifestText: string,
): { compressed: number; skipped: number } {
    const byId = new Map(chunk.map((candidate) => [candidate.memory.id, candidate]));
    const parsed = parseCuesManifest(manifestText);
    assertManifestCoversExactly(
        parsed.map((entry) => entry.id),
        new Set(byId.keys()),
        "cues",
    );
    let compressed = 0;
    let skipped = 0;
    runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () => {
        for (const entry of parsed) {
            const candidate = byId.get(entry.id);
            if (!candidate) throw new Error(`cues manifest contains unknown id ${entry.id}`);
            const failure = validateCue(entry.cue, candidate.memory.importance ?? 50);
            if (failure) {
                skipped += 1;
                log(
                    `[dreamer] compress-cues: skipped cue for memory ${entry.id} (${failure.reason})`,
                );
                continue;
            }
            setMuralCue(
                args.db,
                args.projectIdentity,
                entry.id,
                entry.cue.trim(),
                candidate.contentHash,
            );
            compressed += 1;
        }
    });
    return { compressed, skipped };
}
