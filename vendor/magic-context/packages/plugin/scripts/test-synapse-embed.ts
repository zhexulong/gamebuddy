#!/usr/bin/env bun
/**
 * Standalone Synapse embedding lane exerciser.
 *
 * Talks to the live subc daemon directly through the same provider class the
 * plugin uses, so the lane can be validated end-to-end (discovery, query embed,
 * id-keyed batch, fingerprint pinning) without restarting a harness or arming
 * the shadow dual-write.
 *
 * Usage:
 *   bun packages/plugin/scripts/test-synapse-embed.ts            # smoke: discover + query + small batch
 *   bun packages/plugin/scripts/test-synapse-embed.ts --compare  # also rank-compare against the primary lane on real memories
 *   bun packages/plugin/scripts/test-synapse-embed.ts --n 32     # batch size for the batch leg
 *
 * Read-only against context.db (used only to pull real memory texts for --compare).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
    SYNAPSE_DEFAULT_MODEL,
    SynapseEmbeddingProvider,
} from "../src/features/magic-context/memory/embedding-synapse";

const args = process.argv.slice(2);
const compare = args.includes("--compare");
const nIdx = args.indexOf("--n");
const batchN = nIdx >= 0 ? Number(args[nIdx + 1]) : 8;

const connectionFile = join(homedir(), ".local", "share", "cortexkit", "run", "subc-connection.json");
if (!existsSync(connectionFile)) {
    console.error(`no daemon connection file at ${connectionFile}`);
    process.exit(1);
}

const t0 = Date.now();
const step = (label: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);

// 1. Discovery: models.list through the management route.
step("discovering lane (models.list)...");
const metadata = await SynapseEmbeddingProvider.discover({
    connectionFile,
    projectRoot: process.cwd(),
    session: `script:test-synapse-embed:${Date.now()}`,
});
console.log({
    model: metadata.model,
    dims: metadata.dims ?? "(pinned on first embed)",
    fingerprint: `${metadata.fingerprint.slice(0, 16)}...`,
    tableEpoch: metadata.table_epoch,
    recommendedBatch: metadata.recommended_batch,
    state: metadata.status,
});
if (metadata.model !== SYNAPSE_DEFAULT_MODEL) {
    console.warn(`served model ${metadata.model} differs from default ${SYNAPSE_DEFAULT_MODEL}`);
}

const provider = new SynapseEmbeddingProvider({
    connectionFile,
    projectRoot: process.cwd(),
    session: `script:test-synapse-embed:${Date.now()}`,
    model: metadata.model,
    fingerprint: metadata.fingerprint,
    tableEpoch: metadata.table_epoch,
    ...(metadata.dims ? { dims: metadata.dims } : {}),
    ...(metadata.recommended_batch ? { recommendedBatch: metadata.recommended_batch } : {}),
});

// 2. Query embed (the search hot-path op).
step("embed.query smoke...");
const queryVec = await provider.embed("how does the historian decide when to fire?");
if (!queryVec) throw new Error("embed.query returned null");
let qnorm = 0; for (const x of queryVec) qnorm += x * x;
console.log(`query vector: dims=${queryVec.length} norm=${Math.sqrt(qnorm).toFixed(4)}`);

// 3. Id-keyed batch (the background-write op).
step(`embed.batch smoke (${batchN} items)...`);
const items = Array.from({ length: batchN }, (_, i) => {
    const text = `synthetic batch item ${i}: cache stability requires byte-identical replay of frozen placeholders across defer passes (variant ${i}).`;
    return {
        id: `script:item:${i}`,
        text,
        contentSha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
    };
});
const batchT = Date.now();
const result = await provider.embedItems(items);
console.log(
    `batch: ${result.size}/${items.length} vectors in ${Date.now() - batchT}ms (dims ${[...result.values()][0]?.length})`,
);

if (compare) {
    // 4. Rank comparison against the primary lane vectors already in context.db.
    step("rank-compare against primary lane (read-only context.db)...");
    const { openDatabase } = await import("../src/features/magic-context/storage");
    const db = openDatabase();
    if (!db) throw new Error("context.db unavailable");
    const rows = db
        .prepare(
            `SELECT m.id, m.content, e.embedding FROM memories m
             JOIN memory_embeddings e ON e.memory_id = m.id
             WHERE m.status = 'active' AND m.content IS NOT NULL
             ORDER BY m.id DESC LIMIT 200`,
        )
        .all() as { id: number; content: string; embedding: Uint8Array }[];
    step(`pulled ${rows.length} memories with primary vectors`);

    const synapseVecs = new Map<number, Float32Array>();
    const CHUNK = metadata.recommended_batch ?? 16;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const res = await provider.embedItems(
            slice.map((r) => ({
                id: `memory:${r.id}`,
                text: r.content,
                contentSha256: new Bun.CryptoHasher("sha256").update(r.content).digest("hex"),
            })),
        );
        for (const r of slice) {
            const v = res.get(`memory:${r.id}`);
            if (v) synapseVecs.set(r.id, v);
        }
        process.stdout.write(`\r  embedded ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
    }
    console.log();

    const cosine = (a: Float32Array, b: Float32Array): number => {
        let dot = 0;
        let na = 0;
        let nb = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        return dot / (Math.sqrt(na) * Math.sqrt(nb));
    };

    // Real query set: exercise both lanes and report top-10 rank overlap per query.
    const queries = [
        "cache bust caused by memory archive",
        "how are compartments rendered with decay tiers",
        "sqlite busy timeout in tests",
        "windows subagent spawn failure",
        "embedding model substitution guard",
        "protected tail boundary token cap",
        "channel 2 nudge delivery",
        "project identity resolution git fallback",
    ];
    // Build the primary-lane provider directly from the user config so query
    // embeds hit the same lane the stored vectors came from.
    const { OpenAICompatibleEmbeddingProvider } = await import(
        "../src/features/magic-context/memory/embedding-openai"
    );
    const { readFileSync } = await import("node:fs");
    const apiKey = readFileSync(join(homedir(), ".config", "openrouter.key"), "utf8").trim();
    const primary = new OpenAICompatibleEmbeddingProvider({
        endpoint: "https://openrouter.ai/api/v1",
        model: "qwen/qwen3-embedding-8b",
        apiKey,
        queryInputType: "query",
    });
    {
        const primaryVecs = new Map<number, Float32Array>();
        for (const r of rows) {
            primaryVecs.set(r.id, new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4));
        }
        const overlaps: number[] = [];
        for (const q of queries) {
            const [pq, sq] = [await primary.embed(q), await provider.embed(q)];
            if (!pq || !sq) {
                console.warn(`  query embed failed: "${q}"`);
                continue;
            }
            const topBy = (qv: Float32Array, vecs: Map<number, Float32Array>) =>
                [...vecs.entries()]
                    .map(([id, v]) => [id, cosine(qv, v)] as const)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 10)
                    .map(([id]) => id);
            const pTop = new Set(topBy(pq, primaryVecs));
            const sTop = topBy(sq, synapseVecs);
            const overlap = sTop.filter((id) => pTop.has(id)).length / 10;
            overlaps.push(overlap);
            console.log(`  overlap@10 ${overlap.toFixed(1)}  "${q}"`);
        }
        overlaps.sort((a, b) => a - b);
        console.log(
            `rank overlap: mean=${(overlaps.reduce((s, o) => s + o, 0) / overlaps.length).toFixed(2)} min=${overlaps[0]?.toFixed(2)} (n=${overlaps.length}; informal preview, NOT the P10 gate)`,
        );
    }
}

step("done");
process.exit(0);
