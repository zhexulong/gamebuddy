import { sessionLog } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { CATEGORY_DEFAULT_TTL, PROMOTABLE_CATEGORIES } from "./constants";
import { embedTextForProject } from "./embedding";
import { computeNormalizedHash } from "./normalize-hash";
import { areMemorySourcesEligible } from "./source-exclusion";
import { isOngoingInteractionDurableFactAdmissible } from "./ongoing-interaction-admission";
import type { MemoryDomain } from "./domain";
import {
    getMemoryByHash,
    getMemoryById,
    insertMemory,
    updateMemorySeenCount,
} from "./storage-memory";
import { saveEmbeddingIfHashMatches } from "./storage-memory-embeddings";
import type { MemoryCategory, MemoryInput } from "./types";

interface SessionFact {
    category: string;
    content: string;
    /** Optional adapter-supplied opaque source refs; never parsed from Historian XML. */
    sourceRefs?: readonly string[];
}

export interface PromotedMemoryRef {
    memoryId: number;
    content: string;
}

function isPromotableCategory(
    category: string,
    domain: MemoryDomain,
): category is MemoryCategory {
    // INTERACTION_EPISODE is a durable category only in the explicit ongoing
    // interaction domain. Keep the coding-project allowlist unchanged rather
    // than widening the global promotion set.
    if (category === "SEMANTIC_MEMORY" || category === "INTERACTION_EPISODE") {
        return domain === "ongoing-interaction";
    }
    return PROMOTABLE_CATEGORIES.some((promotableCategory) => promotableCategory === category);
}

function resolveExpiresAt(category: MemoryCategory): number | null {
    const ttl = CATEGORY_DEFAULT_TTL[category];
    return ttl === undefined ? null : Date.now() + ttl;
}

/**
 * Synchronously promote eligible session facts to cross-session memories.
 *
 * Transaction contract: callers may run this inside their publish transaction.
 * Storage failures deliberately propagate so the enclosing publication rolls
 * back atomically with the boundary; malformed/unpromotable facts are validation
 * skips and do not abort the publish.
 */
export function promoteSessionFactsDurable(
    db: Database,
    sessionId: string,
    projectPath: string,
    facts: SessionFact[],
    domain: MemoryDomain = "coding-project",
): PromotedMemoryRef[] {
    const refs: PromotedMemoryRef[] = [];
    for (const fact of facts) {
        if (
            !fact ||
            typeof fact.category !== "string" ||
            typeof fact.content !== "string" ||
            fact.content.trim().length === 0
        ) {
            continue;
        }
        if (!isPromotableCategory(fact.category, domain)) {
            continue;
        }
        if (
            domain === "ongoing-interaction" &&
            !isOngoingInteractionDurableFactAdmissible(fact.category, fact.content)
        ) {
            continue;
        }
        // Candidate-time exclusion check. A second check immediately before
        // insertion closes the asynchronous/candidate-to-commit race.
        if (!areMemorySourcesEligible(db, projectPath, fact.sourceRefs)) {
            continue;
        }

        const normalizedHash = computeNormalizedHash(fact.content);
        const existingMemory = getMemoryByHash(db, projectPath, fact.category, normalizedHash);

        if (existingMemory) {
            updateMemorySeenCount(db, existingMemory.id);
            continue;
        }

        // Commit-time recheck: a player may exclude the source after a
        // candidate has been parsed but before this publish transaction writes.
        if (!areMemorySourcesEligible(db, projectPath, fact.sourceRefs)) {
            continue;
        }

        const memoryInput: MemoryInput = {
            projectPath,
            category: fact.category,
            content: fact.content,
            sourceSessionId: sessionId,
            sourceType: "historian",
            expiresAt: resolveExpiresAt(fact.category),
            // Preserve only adapter-supplied opaque refs. The historian XML
            // cannot manufacture provenance, and this durable metadata lets
            // later source exclusion find already-promoted memories.
            metadataJson:
                fact.sourceRefs === undefined
                    ? null
                    : JSON.stringify({ source_refs: [...fact.sourceRefs] }),
        };

        const memory = insertMemory(db, memoryInput);
        refs.push({ memoryId: memory.id, content: memory.content });
    }

    return refs;
}

/**
 * Best-effort asynchronous embedding for newly promoted facts. Must run after
 * the durable publish transaction commits.
 */
export async function embedPromotedFacts(
    db: Database,
    sessionId: string,
    projectPath: string,
    refs: PromotedMemoryRef[],
): Promise<void> {
    for (const ref of refs) {
        await embedAndStoreMemory(db, sessionId, projectPath, ref.memoryId, ref.content);
    }
}

async function embedAndStoreMemory(
    db: Database,
    sessionId: string,
    projectPath: string,
    memoryId: number,
    content: string,
): Promise<void> {
    try {
        // Capture the row's content hash BEFORE the async provider call: the
        // vector it returns is only valid for the content stored right now. If
        // the memory is edited while the call is in flight, the row's
        // normalized_hash changes and the guarded save below discards the stale
        // vector instead of resurrecting an out-of-date row — the memory then
        // stays unembedded until the proactive drain re-embeds current content.
        const hashBeforeEmbed = getMemoryById(db, memoryId)?.normalizedHash;
        if (!hashBeforeEmbed) {
            return;
        }
        const result = await embedTextForProject(projectPath, content);
        if (result) {
            db.transaction(() => {
                saveEmbeddingIfHashMatches(
                    db,
                    memoryId,
                    result.vector,
                    result.modelId,
                    hashBeforeEmbed,
                );
            })();
        }
    } catch (error) {
        sessionLog(sessionId, `memory embedding failed for memory ${memoryId}:`, error);
    }
}
