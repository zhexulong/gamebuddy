import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Find an executable on `$PATH` using Node primitives only.
 *
 * Why not shell out to `which`/`where`?
 *
 * - Some minimal Linux images (Alpine, slim Docker images, NixOS sandboxes,
 *   `bunx` sandboxes) don't ship `which` in `$PATH`, causing
 *   `execFileSync("which", ...)` to throw before it even gets to the lookup.
 * - User PATH wrappers and exotic setups (custom dispatchers, mise/asdf
 *   shims, bwrap launchers) can interact strangely with shell builtins.
 * - Node's `process.env.PATH` + `path.delimiter` is portable, deterministic,
 *   and doesn't depend on any external tool being present.
 *
 * Behavior notes:
 * - Walks `process.env.PATH` left-to-right, returning the first match.
 *   This matches what `which` (and shell resolution) would return.
 * - On Windows: tries `binary.exe`, `binary.cmd`, `binary.bat`, `binary.com`
 *   in that order for each PATH dir (mirroring `PATHEXT` lookup behavior
 *   for the common cases — we don't read PATHEXT itself because the typical
 *   user binary is `.exe`).
 * - On POSIX: checks the file exists, is a regular file (or a symlink to
 *   one — `statSync` follows symlinks by default), and is executable
 *   by the current user (`accessSync` with `X_OK`).
 * - Returns `null` if PATH is empty/missing or no match is found.
 *
 * This intentionally does NOT execute the discovered binary; callers that
 * need version/feature info should do that separately.
 */
export function findOnPath(binary: string): string | null {
    const PATH = process.env.PATH;
    if (typeof PATH !== "string" || PATH.length === 0) return null;

    const isWindows = process.platform === "win32";
    const dirs = PATH.split(delimiter);

    // Windows: try common executable extensions per directory.
    // POSIX: just the bare name.
    const candidates = isWindows
        ? [`${binary}.exe`, `${binary}.cmd`, `${binary}.bat`, `${binary}.com`]
        : [binary];

    for (const dir of dirs) {
        if (!dir) continue; // empty PATH segments (rare but valid)
        for (const candidate of candidates) {
            const fullPath = join(dir, candidate);
            if (isExecutableFile(fullPath, isWindows)) return fullPath;
        }
    }
    return null;
}

export function isExecutableFile(path: string, isWindows = process.platform === "win32"): boolean {
    try {
        if (!existsSync(path)) return false;
        // statSync follows symlinks by default — important because wrapper
        // scripts and tool-version shims are often symlinks. We want the
        // target to be a regular file or directory entry that resolves
        // to one, not a broken symlink.
        const st = statSync(path);
        if (!st.isFile()) return false;
        if (isWindows) {
            // Windows doesn't have execute permission bits the way POSIX
            // does — the .exe/.cmd/.bat extension match is the contract.
            return true;
        }
        // POSIX: check X_OK for the current user/group/other.
        accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}
