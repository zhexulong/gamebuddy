/** Extract the complete root element body for Dreamer XML manifests.
 *  A missing closing root is treated as truncation and rejects the whole output,
 *  so a length-capped model response can never apply a prefix of mutations. */
export function extractCompleteManifestBody(text: string, rootName: string): string {
    const escapedRoot = rootName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rootMatch = new RegExp(
        `<${escapedRoot}\\b[^>]*>([\\s\\S]*?)<\\/${escapedRoot}>`,
        "i",
    ).exec(text);
    if (rootMatch) return rootMatch[1];

    const hasOpenRoot = new RegExp(`<${escapedRoot}\\b`, "i").test(text);
    const hasCloseRoot = new RegExp(`<\\/${escapedRoot}>`, "i").test(text);
    if (hasOpenRoot && !hasCloseRoot) {
        throw new Error(`${rootName} manifest missing closing root tag`);
    }
    throw new Error(`${rootName} manifest missing complete root element`);
}

export function assertNoDuplicateManifestIds(ids: readonly number[], rootName: string): void {
    const seen = new Set<number>();
    for (const id of ids) {
        if (seen.has(id)) throw new Error(`${rootName} manifest contains duplicate id ${id}`);
        seen.add(id);
    }
}

export function assertManifestCoversExactly(
    ids: readonly number[],
    expectedIds: ReadonlySet<number>,
    rootName: string,
): void {
    assertNoDuplicateManifestIds(ids, rootName);
    for (const id of ids) {
        if (!expectedIds.has(id)) throw new Error(`${rootName} manifest contains unknown id ${id}`);
    }
    for (const id of expectedIds) {
        if (!ids.includes(id)) throw new Error(`${rootName} manifest missing id ${id}`);
    }
}
