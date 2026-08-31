/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";

import {
    incrementalLkgContentDigests,
    type LkgDigestEntry,
    lkgContentDigestFromFields,
    lkgContentFields,
} from "./lkg-slot";

function entry(id: string, text: string): LkgDigestEntry {
    const fields = lkgContentFields({ id, text });
    if (!fields) throw new Error("failed to flatten fixture");
    return { id, signature: `sig:${id}:${text}`, fields };
}

describe("incremental LKG content digests", () => {
    it("matches a full recompute and reuses an unchanged prefix", () => {
        const prefix = [entry("m1", "one"), entry("m2", "two"), entry("m3", "three")];
        const tail = [entry("m4", "four"), entry("m5", "five")];
        const original = [...prefix, ...tail];
        const fullOriginal = original.map((item) => lkgContentDigestFromFields(item.fields));

        const first = incrementalLkgContentDigests(original);
        expect(first.reusedPrefix).toBe(0);
        expect(first.digests).toEqual(fullOriginal);

        const unchanged = incrementalLkgContentDigests(original, {
            ids: original.map((item) => item.id),
            signatures: original.map((item) => item.signature),
            digests: first.digests,
        });
        expect(unchanged.reusedPrefix).toBe(original.length);
        expect(unchanged.digests).toEqual(fullOriginal);

        const mutated = [...prefix, entry("m4", "FOUR-CHANGED"), tail[1]!];
        const fullMutated = mutated.map((item) => lkgContentDigestFromFields(item.fields));
        const incremental = incrementalLkgContentDigests(mutated, {
            ids: original.map((item) => item.id),
            signatures: original.map((item) => item.signature),
            digests: first.digests,
        });
        expect(incremental.reusedPrefix).toBe(prefix.length);
        expect(incremental.digests).toEqual(fullMutated);
        expect(incremental.digests.slice(0, prefix.length)).toEqual(
            fullOriginal.slice(0, prefix.length),
        );
        expect(incremental.digests[prefix.length]).not.toBe(fullOriginal[prefix.length]);
    });
});
