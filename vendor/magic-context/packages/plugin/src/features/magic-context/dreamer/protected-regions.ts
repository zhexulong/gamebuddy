export interface EnforceProtectedRegionsResult {
    /** The text to persist (candidate, repaired candidate, or original on reject). */
    text: string;
    violated: boolean;
}

const PROTECTED_START_TOKEN = "mc:protected START";
const PROTECTED_END_TOKEN = "mc:protected END";

export interface ProtectedBlock {
    /** Full identifying start-marker line (the line containing mc:protected START). */
    startMarkerLine: string;
    /** Bytes from START line through END line inclusive. */
    block: string;
}

/** Extract every mc:protected region from `text`, keyed by the full START marker line. */
export function extractProtectedBlocks(text: string): ProtectedBlock[] {
    const lines = text.split("\n");
    const blocks: ProtectedBlock[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line.includes(PROTECTED_START_TOKEN)) {
            const startMarkerLine = line;
            const startIdx = i;
            while (i < lines.length && !lines[i].includes(PROTECTED_END_TOKEN)) {
                i += 1;
            }
            if (i >= lines.length) {
                break;
            }
            const endIdx = i;
            const block = lines.slice(startIdx, endIdx + 1).join("\n");
            blocks.push({ startMarkerLine, block });
            i += 1;
            continue;
        }
        i += 1;
    }
    return blocks;
}

function findCandidateBlockSpan(
    candidate: string,
    startMarkerLine: string,
): { start: number; end: number; block: string } | null {
    const lines = candidate.split("\n");
    for (let i = 0; i < lines.length; i++) {
        if (lines[i] !== startMarkerLine) {
            continue;
        }
        const startIdx = i;
        while (i < lines.length && !lines[i].includes(PROTECTED_END_TOKEN)) {
            i += 1;
        }
        if (i >= lines.length) {
            return null;
        }
        const endIdx = i;
        const block = lines.slice(startIdx, endIdx + 1).join("\n");
        return { start: startIdx, end: endIdx, block };
    }
    return null;
}

function spliceProtectedBlock(
    text: string,
    startMarkerLine: string,
    replacementBlock: string,
): string {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        if (lines[i] !== startMarkerLine) {
            continue;
        }
        const startIdx = i;
        while (i < lines.length && !lines[i].includes(PROTECTED_END_TOKEN)) {
            i += 1;
        }
        if (i >= lines.length) {
            return text;
        }
        const endIdx = i;
        const replacementLines = replacementBlock.split("\n");
        const next = [...lines.slice(0, startIdx), ...replacementLines, ...lines.slice(endIdx + 1)];
        return next.join("\n");
    }
    return text;
}

/**
 * Enforce that every mc:protected region present in `original` is byte-identical
 * in `candidate`. Returns the text to actually write and whether a violation was repaired.
 */
export function enforceProtectedRegions(
    original: string,
    candidate: string,
): EnforceProtectedRegionsResult {
    const originalBlocks = extractProtectedBlocks(original);
    if (originalBlocks.length === 0) {
        return { text: candidate, violated: false };
    }

    let text = candidate;
    let violated = false;

    for (const { startMarkerLine, block: originalBlock } of originalBlocks) {
        const span = findCandidateBlockSpan(text, startMarkerLine);
        if (!span) {
            return { text: original, violated: true };
        }
        if (span.block !== originalBlock) {
            text = spliceProtectedBlock(text, startMarkerLine, originalBlock);
            violated = true;
        }
    }

    return { text, violated };
}
