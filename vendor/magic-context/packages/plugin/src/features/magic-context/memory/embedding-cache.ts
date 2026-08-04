import type { Database } from "../../../shared/sqlite";
import { loadAllEmbeddings, type StoredMemoryEmbedding } from "./storage-memory-embeddings";

interface ProjectEmbeddingCacheEntry {
    embeddings: Map<number, StoredMemoryEmbedding>;
    expiresAt: number;
}

const DEFAULT_EMBEDDING_CACHE_TTL_MS = 60_000;

const projectEmbeddingCache = new Map<string, ProjectEmbeddingCacheEntry>();

let embeddingCacheTtlMs = DEFAULT_EMBEDDING_CACHE_TTL_MS;

function cacheKey(projectPath: string, modelId: string): string {
    return `${projectPath}\0${modelId}`;
}

function getValidCacheEntry(
    projectPath: string,
    modelId: string,
): ProjectEmbeddingCacheEntry | null {
    const entry = projectEmbeddingCache.get(cacheKey(projectPath, modelId));
    if (!entry) {
        return null;
    }

    if (entry.expiresAt <= Date.now()) {
        projectEmbeddingCache.delete(cacheKey(projectPath, modelId));
        return null;
    }

    return entry;
}

export function getProjectEmbeddings(
    db: Database,
    projectPath: string,
    modelId: string,
): Map<number, StoredMemoryEmbedding> {
    const cached = getValidCacheEntry(projectPath, modelId);
    if (cached) {
        return cached.embeddings;
    }

    const embeddings = loadAllEmbeddings(db, projectPath, modelId);
    projectEmbeddingCache.set(cacheKey(projectPath, modelId), {
        embeddings,
        expiresAt: Date.now() + embeddingCacheTtlMs,
    });
    return embeddings;
}

export function peekProjectEmbeddings(
    projectPath: string,
    modelId: string,
): Map<number, StoredMemoryEmbedding> | null {
    return getValidCacheEntry(projectPath, modelId)?.embeddings ?? null;
}

export function invalidateProject(projectPath: string): void {
    for (const key of projectEmbeddingCache.keys()) {
        if (key.startsWith(`${projectPath}\0`)) {
            projectEmbeddingCache.delete(key);
        }
    }
}

export function invalidateMemory(projectPath: string, memoryId: number): void {
    for (const key of projectEmbeddingCache.keys()) {
        if (!key.startsWith(`${projectPath}\0`)) continue;
        const entry = projectEmbeddingCache.get(key);
        if (!entry || entry.expiresAt <= Date.now()) {
            projectEmbeddingCache.delete(key);
            continue;
        }
        entry.embeddings.delete(memoryId);
    }
}

export function resetEmbeddingCacheForTests(): void {
    projectEmbeddingCache.clear();
    embeddingCacheTtlMs = DEFAULT_EMBEDDING_CACHE_TTL_MS;
}

export function setEmbeddingCacheTtlForTests(ttlMs: number): void {
    embeddingCacheTtlMs = Math.max(0, Math.floor(ttlMs));
}
