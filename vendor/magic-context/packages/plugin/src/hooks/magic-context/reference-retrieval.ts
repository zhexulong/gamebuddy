/**
 * Reference retrieval for the v2 historian prompt (E1.6b).
 *
 * The historian receives two reference blocks (replacing the old unbounded
 * `<existing_state>` compartment dump):
 *
 *   <compartment_examples_from_other_projects>  — 4 rotating cross-project SEEDS
 *       (permanent floor). Calibration anchors for importance scoring, tier
 *       decay, paraphrase rhythm, and fact-extraction shape. Never dedup-able.
 *
 *   <session_references>                          — last 6 compartments THIS
 *       session wrote, full stored form (all tiers + importance + episode_type).
 *       Continuity + same-project format/importance calibration. RECENCY-based
 *       (no embedding at historian time — embedding K/L/M was dropped; see
 *       AUDIT E1 input-model decisions). ctx_search semantic retrieval over
 *       compartments is served by per-compartment chunk embeddings computed on
 *       publish (compartment-embedding.ts).
 *
 * Budget: 4 seeds + up to 6 session refs = the validated 10-example budget.
 * Embedding work at historian time: ZERO.
 */
import { escapeXmlAttr, escapeXmlContent } from "../../features/magic-context/compartment-storage";
import { REFERENCE_SEEDS, type ReferenceSeed } from "./reference-seeds.generated";

/**
 * Structural minimum a compartment must satisfy to render as a session
 * reference. Both `Compartment` (stored rows, incremental runner) and
 * `CandidateCompartment` (in-flight recomp staging) are assignable — they
 * differ only in null/undefined widening on the tier/importance fields.
 */
export interface ReferenceCompartment {
    startMessage: number;
    endMessage: number;
    title: string;
    content: string;
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    importance?: number | null;
    episodeType?: string | null;
}

/** Permanent seed floor — never drops, even when the session is mature. */
export const SEED_FLOOR = 4;
/** Recency window of this-session compartments shown for continuity/calibration. */
export const SESSION_REF_WINDOW = 6;

/**
 * Importance bands the 60-seed corpus is balanced across (12 per band). We pick
 * one seed from each of 4 bands per run so every run sees the full importance
 * range (anti-drift anchor) rather than 4 clustered scores. The fifth band
 * (mid) is intentionally not always represented — 4 picks across 5 bands still
 * spans low→high, which is what calibration needs.
 */
const SEED_BANDS: ReadonlyArray<readonly [number, number]> = [
    [85, 100], // very high
    [60, 84], // high
    [30, 59], // mid
    [10, 29], // low-mid
    [1, 9], // low
];

function seedBandIndex(importance: number): number {
    for (let i = 0; i < SEED_BANDS.length; i++) {
        const [lo, hi] = SEED_BANDS[i];
        if (importance >= lo && importance <= hi) return i;
    }
    // Defensive: importance is validated 1-100, but clamp out-of-range to nearest band.
    return importance > 100 ? 0 : SEED_BANDS.length - 1;
}

/** Group seeds by importance band, preserving corpus order within each band. */
function seedsByBand(): ReferenceSeed[][] {
    const bands: ReferenceSeed[][] = SEED_BANDS.map(() => []);
    for (const seed of REFERENCE_SEEDS) {
        bands[seedBandIndex(seed.importance)].push(seed);
    }
    return bands;
}

/**
 * Deterministic non-cryptographic hash (FNV-1a). The seed selection MUST be
 * stable for a given (sessionId, chunkStart) so a historian re-run on the same
 * chunk — e.g. after a discarded last compartment, or a retried transient
 * failure — sees the identical reference block. Reproducibility, not security.
 */
function fnv1a(input: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        // h *= 16777619, kept in 32-bit unsigned range
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
}

/**
 * Select 4 diverse, importance-band-spanning seeds, deterministically rotated
 * by (sessionId, chunkStart) so different runs see different 4-seed combos
 * (≈15 distinct combinations before repeat across the 60-seed corpus) while a
 * given chunk always resolves to the same 4.
 *
 * Strategy: pick one seed from each of the first SEED_FLOOR bands (very-high,
 * high, mid, low-mid by default), rotating WITHIN each band by the hash so the
 * specific seed varies run to run. This guarantees band coverage on every run
 * (never 4 high-importance seeds) while still rotating the corpus.
 */
export function selectSeeds(
    sessionId: string,
    chunkStart: number,
    count = SEED_FLOOR,
): ReferenceSeed[] {
    const bands = seedsByBand();
    const seed = fnv1a(`${sessionId}:${chunkStart}`);
    const picks: ReferenceSeed[] = [];

    // Walk bands round-robin so `count` picks spread across the importance range.
    // With count=4 and 5 bands this covers 4 distinct bands; the rotation offset
    // also shifts WHICH 4 bands when count<bands, so the mid band isn't always
    // the one skipped.
    const bandOrder: number[] = [];
    for (let i = 0; i < SEED_BANDS.length; i++) {
        bandOrder.push((i + (seed % SEED_BANDS.length)) % SEED_BANDS.length);
    }

    let bi = 0;
    let guard = 0;
    while (picks.length < count && guard < SEED_BANDS.length * 4) {
        const band = bands[bandOrder[bi % bandOrder.length]];
        bi++;
        guard++;
        if (band.length === 0) continue;
        // Rotate within the band by the hash + how many we've already taken so two
        // picks from the same band (if a band is empty and we wrap) differ.
        const idx = (seed + picks.length) % band.length;
        const candidate = band[idx];
        if (!picks.includes(candidate)) picks.push(candidate);
    }

    // Fallback: if band-walking under-fills (tiny/oddly-distributed corpus),
    // top up from the flat corpus deterministically.
    for (let i = 0; picks.length < count && i < REFERENCE_SEEDS.length; i++) {
        const candidate = REFERENCE_SEEDS[(seed + i) % REFERENCE_SEEDS.length];
        if (!picks.includes(candidate)) picks.push(candidate);
    }

    return picks;
}

/** Render the cross-project calibration block. Empty string if no seeds. */
export function renderSeedExamplesBlock(seeds: ReferenceSeed[]): string {
    if (seeds.length === 0) return "";
    const body = seeds.map((s) => s.block).join("\n\n");
    return `<compartment_examples_from_other_projects>\n${body}\n</compartment_examples_from_other_projects>`;
}

/**
 * Render one this-session compartment in its full stored form for the
 * `<session_references>` block. v2 rows emit all four tiers; legacy rows (no
 * tiers) fall back to flat `content`. importance/episode_type are shown so the
 * historian calibrates against its own prior scoring.
 */
function renderSessionRefCompartment(c: ReferenceCompartment): string {
    const importance = c.importance ?? 50;
    const attrs =
        `start="${c.startMessage}" end="${c.endMessage}" title="${escapeXmlAttr(c.title)}"` +
        (c.episodeType ? ` episode_type="${escapeXmlAttr(c.episodeType)}"` : "") +
        ` importance="${importance}"`;

    // Tier presence: a row is v2-tiered ONLY when `p1` is a non-empty string
    // (matches the compartment parser's contract + the NEEDS_UPGRADE predicate
    // `legacy=1 OR p1 IS NULL OR p1=''`). Legacy rows (NULL p1) AND malformed
    // pseudo-v2 rows (`p1=''` from an interrupted upgrade) both fall through to
    // flat `content` — otherwise the reference block emitted empty <p1>/<p2>/<p3>
    // and lost the row's continuity/calibration content.
    // Tier bodies are XML-escaped: user/assistant text containing <, >, & would
    // otherwise produce malformed XML in the historian's reference-input prompt.
    if (typeof c.p1 === "string" && c.p1.length > 0) {
        // v2 tiered row: show all four paraphrase tiers exactly as stored. p4 may be
        // empty (self-closing) per the three valid P4 shapes.
        const p4 = c.p4 && c.p4.length > 0 ? `<p4>\n${escapeXmlContent(c.p4)}\n</p4>` : "<p4/>";
        return [
            `<compartment ${attrs}>`,
            `<p1>\n${escapeXmlContent(c.p1)}\n</p1>`,
            `<p2>\n${escapeXmlContent(c.p2 ?? "")}\n</p2>`,
            `<p3>\n${escapeXmlContent(c.p3 ?? "")}\n</p3>`,
            p4,
            `</compartment>`,
        ].join("\n");
    }

    // Legacy (pre-v2) row: no tiers, show flat content. The historian treats this
    // as continuity context only; it never has to reproduce this shape.
    return `<compartment ${attrs}>\n${escapeXmlContent(c.content)}\n</compartment>`;
}

/**
 * Render the continuity block from the last `SESSION_REF_WINDOW` persisted
 * compartments. `allCompartments` is the session's full ordered compartment
 * list (ascending by sequence/endMessage). Empty string when the session has
 * no prior compartments (young session — seeds carry calibration alone).
 */
export function renderSessionReferencesBlock(allCompartments: ReferenceCompartment[]): string {
    if (allCompartments.length === 0) return "";
    const recent = allCompartments.slice(-SESSION_REF_WINDOW);
    const body = recent.map(renderSessionRefCompartment).join("\n\n");
    return `<session_references>\n${body}\n</session_references>`;
}

export interface ReferenceBlocks {
    /** `<compartment_examples_from_other_projects>` — always present (4-seed floor). */
    seedExamples: string;
    /** `<session_references>` — empty for a young session with no prior compartments. */
    sessionReferences: string;
}

/**
 * Build both reference blocks for a historian run. Pure + deterministic for a
 * given (sessionId, chunkStart, compartments) — no embedding, no DB, no clock.
 */
export function buildReferenceBlocks(args: {
    sessionId: string;
    chunkStart: number;
    /** Full ordered list of this session's persisted compartments (asc). */
    sessionCompartments: ReferenceCompartment[];
}): ReferenceBlocks {
    const seeds = selectSeeds(args.sessionId, args.chunkStart);
    return {
        seedExamples: renderSeedExamplesBlock(seeds),
        sessionReferences: renderSessionReferencesBlock(args.sessionCompartments),
    };
}
