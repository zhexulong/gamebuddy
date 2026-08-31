export const PI_MAGIC_CONTEXT_PACKAGE_NAME = "@cortexkit/pi-magic-context";

function stripNpmPrefix(value: string): string {
    return value.startsWith("npm:") ? value.slice("npm:".length) : value;
}

function packageNameFromSpecifier(value: string): string {
    const normalized = stripNpmPrefix(value.trim());
    if (!normalized) return normalized;
    if (normalized.startsWith("@")) {
        const slash = normalized.indexOf("/");
        if (slash < 0) return normalized;
        const versionAt = normalized.indexOf("@", slash + 1);
        return versionAt > 0 ? normalized.slice(0, versionAt) : normalized;
    }
    const versionAt = normalized.indexOf("@");
    return versionAt > 0 ? normalized.slice(0, versionAt) : normalized;
}

export function getPiPackageEntryName(entry: unknown): string | null {
    if (typeof entry === "string") return packageNameFromSpecifier(entry);
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const object = entry as Record<string, unknown>;
        for (const key of ["name", "source"] as const) {
            const name = getPiPackageEntryName(object[key]);
            if (name) return name;
        }
    }
    return null;
}

export function isPiMagicContextPackageEntry(entry: unknown): boolean {
    if (typeof entry === "string") {
        return packageNameFromSpecifier(entry) === PI_MAGIC_CONTEXT_PACKAGE_NAME;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const object = entry as Record<string, unknown>;
        return (
            isPiMagicContextPackageEntry(object.name) || isPiMagicContextPackageEntry(object.source)
        );
    }
    return false;
}

export function getPiMagicContextPackageSpecifier(entry: unknown): string | null {
    if (typeof entry === "string") {
        return isPiMagicContextPackageEntry(entry) ? entry.trim() : null;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const object = entry as Record<string, unknown>;
        return (
            getPiMagicContextPackageSpecifier(object.source) ??
            getPiMagicContextPackageSpecifier(object.name)
        );
    }
    return null;
}

export function hasPiMagicContextPackage(entries: unknown[]): boolean {
    return entries.some(isPiMagicContextPackageEntry);
}

export function describePiPackageEntry(entry: unknown): string {
    if (typeof entry === "string") return entry;
    const name = getPiPackageEntryName(entry);
    if (name) return name;
    try {
        return JSON.stringify(entry);
    } catch {
        return String(entry);
    }
}
