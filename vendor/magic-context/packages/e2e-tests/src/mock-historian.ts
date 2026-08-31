/**
 * Shared mock-historian payload builder for the e2e suite.
 *
 * The historian's output is validated before it is published (see
 * `validateHistorianOutput` in the plugin and `historian_validate.rs` in the
 * Rust module). Since strict tier validation landed, a compartment that lacks
 * the v2 paraphrase tiers is rejected: P1 is the required boundary, and a flat
 * v1-shaped compartment (bare prose, no `<p1>`) re-enters the retry chain and
 * never publishes. Every historian-publish e2e test therefore needs its mock
 * provider to answer with a valid v2 tiered compartment, or it times out
 * waiting for a publish that validation blocks.
 *
 * This helper emits the minimal valid v2 shape — a single compartment carrying
 * all four paraphrase tiers plus the `importance`/`episode_type` attributes and
 * the `<facts>`/`<events>` blocks — wrapped in the full `<output>` envelope with
 * a trailing `<unprocessed_from>` so the chunk reports as fully covered. It
 * mirrors the tiered fixture the cache-invariant tests already publish
 * successfully, so it satisfies both the TypeScript and Rust validation paths.
 */

export interface MockHistorianPayloadOptions {
    /** First raw ordinal the compartment covers (`<compartment start="...">`). */
    start: number;
    /** Last raw ordinal the compartment covers (`<compartment end="...">`). */
    end: number;
    /** Compartment title attribute. */
    title: string;
    /** P1 tier text — the fullest paraphrase and the required v2 boundary. */
    body: string;
    /** P2 tier text (shorter paraphrase). Defaults to `body`. */
    p2?: string;
    /** P3 tier text (shortest paraphrase). Defaults to `body`. */
    p3?: string;
    /** v2 decay-rate attribute (1-100). Defaults to 50. */
    importance?: number;
    /** v2 episode_type attribute. Defaults to "feature". */
    episodeType?: string;
}

/**
 * Build a valid v2 tiered historian `<output>` payload covering `start`..`end`.
 *
 * P4 is emitted self-closed (`<p4/>`), which the parser treats as an empty tier
 * — a legal v2 shape. `<unprocessed_from>` is set to `end + 1` so the validator
 * sees the whole chunk as consumed.
 */
export function buildMockHistorianPayload(options: MockHistorianPayloadOptions): string {
    const { start, end, title, body } = options;
    const p2 = options.p2 ?? body;
    const p3 = options.p3 ?? body;
    const importance = options.importance ?? 50;
    const episodeType = options.episodeType ?? "feature";

    return [
        "<output>",
        "<compartments>",
        `<compartment start="${start}" end="${end}" title="${escapeXml(title)}" importance="${importance}" episode_type="${escapeXml(episodeType)}">`,
        `<p1>${escapeXml(body)}</p1>`,
        `<p2>${escapeXml(p2)}</p2>`,
        `<p3>${escapeXml(p3)}</p3>`,
        "<p4/>",
        "</compartment>",
        "</compartments>",
        "<facts></facts>",
        "<events></events>",
        `<unprocessed_from>${end + 1}</unprocessed_from>`,
        "</output>",
    ].join("\n");
}

/** Escape the five XML-special characters so arbitrary prose stays well-formed. */
function escapeXml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
