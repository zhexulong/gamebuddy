import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { escapeXmlAttr, escapeXmlContent } from "./compartment-storage";

const PROJECT_DOC_FILES = ["ARCHITECTURE.md", "STRUCTURE.md"] as const;
const PROJECT_DOCS_DELIMITER = "\n\n---\n\n";

// Project docs are repo-supplied content rendered into the trusted m[0]
// baseline. A malicious repo could make ARCHITECTURE.md a SYMLINK to a file
// outside the repo (e.g. ~/.ssh/id_rsa) to exfiltrate its contents into the
// prompt. We use lstat (does NOT follow symlinks) and require a regular file,
// so a symlinked doc is treated as absent. We also cap the size so an
// oversized doc can't blow up the prompt.
const MAX_PROJECT_DOC_BYTES = 256 * 1024;

type DocFileFingerprint = {
    exists: boolean;
    mtimeMs: number;
    size: number;
};

type ProjectDocsCacheEntry = {
    directoryMtimeMs: number;
    files: Map<string, DocFileFingerprint>;
    cachedHash: string;
    cachedRendered: string;
};

const docsCache = new Map<string, ProjectDocsCacheEntry>();

function canonicalizeDocContent(raw: string): string {
    return raw
        .replace(/^\uFEFF/, "")
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/, ""))
        .join("\n")
        .replace(/\n+$/, "");
}

function fingerprintFile(filePath: string): DocFileFingerprint {
    try {
        // lstat, NOT stat: a symlink must not be followed. isFile() is false for
        // a symlink, so a symlinked doc fingerprints as absent (and is skipped
        // by readCanonicalPieces, which applies the same guard).
        const stat = lstatSync(filePath);
        const isReadableDoc = stat.isFile() && stat.size <= MAX_PROJECT_DOC_BYTES;
        return {
            exists: isReadableDoc,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
        };
    } catch {
        return { exists: false, mtimeMs: 0, size: 0 };
    }
}

function readDirectoryMtimeMs(projectDirectory: string): number {
    try {
        return statSync(projectDirectory).mtimeMs;
    } catch {
        return 0;
    }
}

function fingerprintsEqual(a: DocFileFingerprint | undefined, b: DocFileFingerprint): boolean {
    return a?.exists === b.exists && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function cacheFilesEqual(
    cachedFiles: Map<string, DocFileFingerprint>,
    currentFiles: Map<string, DocFileFingerprint>,
): boolean {
    for (const [filePath, current] of currentFiles) {
        if (!fingerprintsEqual(cachedFiles.get(filePath), current)) {
            return false;
        }
    }
    return true;
}

function readCurrentFingerprints(projectDirectory: string): {
    directoryMtimeMs: number;
    files: Map<string, DocFileFingerprint>;
} {
    const files = new Map<string, DocFileFingerprint>();
    for (const filename of PROJECT_DOC_FILES) {
        const filePath = path.join(projectDirectory, filename);
        files.set(filePath, fingerprintFile(filePath));
    }
    return { directoryMtimeMs: readDirectoryMtimeMs(projectDirectory), files };
}

function readCanonicalPieces(
    projectDirectory: string,
    files: Map<string, DocFileFingerprint>,
): { hashPieces: string[]; renderedSections: string[] } {
    const hashPieces: string[] = [];
    const renderedSections: string[] = [];

    for (const filename of PROJECT_DOC_FILES) {
        const filePath = path.join(projectDirectory, filename);
        const fingerprint = files.get(filePath);
        if (!fingerprint?.exists) {
            continue;
        }

        // Re-check at read time (close the TOCTOU between fingerprint and read):
        // refuse to follow a symlink or read an oversized file even if the path
        // was swapped to a symlink after fingerprinting.
        let safeToRead = false;
        try {
            const st = lstatSync(filePath);
            safeToRead = st.isFile() && st.size <= MAX_PROJECT_DOC_BYTES;
        } catch {
            safeToRead = false;
        }
        if (!safeToRead) {
            continue;
        }

        const canonicalContent = canonicalizeDocContent(readFileSync(filePath, "utf8"));
        hashPieces.push(`file:${filename}\n${canonicalContent}`);
        renderedSections.push(
            `<file name="${escapeXmlAttr(filename)}">\n${escapeXmlContent(canonicalContent)}\n</file>`,
        );
    }

    return { hashPieces, renderedSections };
}

function buildRenderedBlock(renderedSections: string[]): string {
    if (renderedSections.length === 0) {
        return "";
    }
    return `<project-docs>\n${renderedSections.join("\n\n")}\n</project-docs>`;
}

function hashCanonicalPieces(hashPieces: string[]): string {
    if (hashPieces.length === 0) {
        return "";
    }
    return createHash("sha256")
        .update(hashPieces.join(PROJECT_DOCS_DELIMITER), "utf8")
        .digest("hex");
}

export function readProjectDocsCanonical(projectDirectory: string): {
    renderedBlock: string;
    canonicalHash: string;
} {
    const canonicalDirectory = path.resolve(projectDirectory);
    const current = readCurrentFingerprints(canonicalDirectory);
    const cached = docsCache.get(canonicalDirectory);

    if (cached && cacheFilesEqual(cached.files, current.files)) {
        cached.directoryMtimeMs = current.directoryMtimeMs;
        return {
            renderedBlock: cached.cachedRendered,
            canonicalHash: cached.cachedHash,
        };
    }

    const { hashPieces, renderedSections } = readCanonicalPieces(canonicalDirectory, current.files);
    const canonicalHash = hashCanonicalPieces(hashPieces);
    const renderedBlock = buildRenderedBlock(renderedSections);

    docsCache.set(canonicalDirectory, {
        directoryMtimeMs: current.directoryMtimeMs,
        files: current.files,
        cachedHash: canonicalHash,
        cachedRendered: renderedBlock,
    });

    return { renderedBlock, canonicalHash };
}

export function computeProjectDocsHash(projectDirectory: string): string {
    return readProjectDocsCanonical(projectDirectory).canonicalHash;
}
