import { chmodSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write a file atomically: temp sibling + rename. Preserves prior mode when the
 * target already exists so user chmod settings survive doctor/setup rewrites.
 *
 * Ensures the parent directory exists first: the temp-sibling write (and rename)
 * both fail with ENOENT if the directory is missing. This matters for the
 * CortexKit config location (~/.config/cortexkit/, <project>/.cortexkit/), which
 * does not pre-exist on a fresh machine — so the very first setup must create it.
 * Doing it here kills the whole missing-parent class for every caller rather than
 * relying on each call site to remember an ensureDir.
 */
export function writeFileAtomic(targetPath: string, data: string): void {
    mkdirSync(dirname(targetPath), { recursive: true });
    const tmpPath = `${targetPath}.tmp`;
    writeFileSync(tmpPath, data, { encoding: "utf-8" });
    try {
        if (statSync(targetPath, { throwIfNoEntry: false })?.isFile()) {
            const mode = statSync(targetPath).mode & 0o777;
            chmodSync(tmpPath, mode);
        }
    } catch {
        // New file — default umask applies.
    }
    renameSync(tmpPath, targetPath);
}
