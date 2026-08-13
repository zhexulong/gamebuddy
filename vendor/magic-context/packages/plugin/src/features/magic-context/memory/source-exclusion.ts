import type { Database } from "../../../shared/sqlite";

/**
 * Opaque, content-free identifiers for source material excluded from automatic
 * Memory promotion. This core service deliberately has no Pi dependency: Pi
 * and other adapters can validate or persist the same project-scoped policy.
 */
export type MemorySourceRef =
    | `pi-message:${string}:${string}`
    | `pi-range:${string}:${string}:${string}`
    | `host-receipt:${string}`;

export interface MemorySourceExclusionInput {
    projectPath: string;
    sourceRef: string;
}

const OPAQUE_SEGMENT = "[^\\s\\x00-\\x1F\\x7F:]+";
const MEMORY_SOURCE_REF = new RegExp(
    `^(?:pi-message:${OPAQUE_SEGMENT}:${OPAQUE_SEGMENT}|pi-range:${OPAQUE_SEGMENT}:${OPAQUE_SEGMENT}:${OPAQUE_SEGMENT}|host-receipt:${OPAQUE_SEGMENT})$`,
);

/** Reject malformed references before they can be persisted, queried, or promoted. */
export function validateMemorySourceRef(sourceRef: string): asserts sourceRef is MemorySourceRef {
    if (typeof sourceRef !== "string" || !MEMORY_SOURCE_REF.test(sourceRef)) {
        throw new Error("Invalid memory source reference");
    }
}

function validateInput({ projectPath, sourceRef }: MemorySourceExclusionInput): void {
    if (typeof projectPath !== "string" || projectPath.length === 0) {
        throw new Error("Invalid memory source exclusion project path");
    }
    validateMemorySourceRef(sourceRef);
}

/** Persist an idempotent, project-scoped exclusion without retaining source content. */
export function excludeMemorySource(
    db: Database,
    input: MemorySourceExclusionInput,
): void {
    validateInput(input);
    db.prepare(
        `INSERT OR IGNORE INTO memory_source_exclusions (project_path, source_ref, created_at)
         VALUES (?, ?, ?)`,
    ).run(input.projectPath, input.sourceRef, Date.now());
}

/** Return whether an exact opaque source reference is excluded for this project. */
export function isMemorySourceExcluded(
    db: Database,
    input: MemorySourceExclusionInput,
): boolean {
    validateInput(input);
    return (
        db
            .prepare(
                "SELECT 1 FROM memory_source_exclusions WHERE project_path = ? AND source_ref = ?",
            )
            .get(input.projectPath, input.sourceRef) !== null
    );
}

/**
 * Fail closed for malformed provenance: auto-promotion must not create a
 * Memory whose supplied source set cannot be safely governed.
 */
export function areMemorySourcesEligible(
    db: Database,
    projectPath: string,
    sourceRefs: readonly string[] | undefined,
): boolean {
    if (sourceRefs === undefined) return true;
    try {
        return !sourceRefs.some((sourceRef) =>
            isMemorySourceExcluded(db, { projectPath, sourceRef }),
        );
    } catch {
        return false;
    }
}
