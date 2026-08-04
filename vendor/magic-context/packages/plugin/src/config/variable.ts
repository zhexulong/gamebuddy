import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import { stripJsonComments } from "../shared/jsonc-parser";

export interface SubstituteInput {
    /** Raw config text before JSONC parsing. */
    text: string;
    /**
     * Path of the config file the text came from. Used to resolve relative
     * `{file:...}` references and to emit useful warnings. Pass undefined for
     * virtual/synthetic inputs (tests) — in that case `{file:}` tokens with
     * relative paths resolve against `cwd`, which is rarely what callers want,
     * so callers should prefer passing a real path when one exists.
     */
    configPath?: string;
    /**
     * Project-level config files are untrusted repository input. Do not expand
     * secret-bearing tokens there; leave them literal and warn instead.
     */
    isProjectConfig?: boolean;
}

export interface SubstituteResult {
    /** Config text with all `{env:X}` and `{file:path}` tokens replaced. */
    text: string;
    /**
     * Human-readable warnings for missing env vars, unreadable files, and
     * unresolved tokens that fell back to empty string. Safe to surface to the
     * user via logger/toast/startup notification.
     */
    warnings: string[];
}

const ENV_PATTERN = /\{env:([^}]+)\}/g;
const FILE_PATTERN = /\{file:([^}]+)\}/g;

/**
 * Directories that almost never belong in a config file's `{file:}` inline.
 * Returns a short human label when `resolvedPath` sits inside one, else null.
 * Used to WARN (not block) on user-level config — see the call site.
 */
function sensitiveFilePathReason(resolvedPath: string): string | null {
    const home = homedir();
    const sensitiveDirs: Array<{ dir: string; label: string }> = [
        { dir: resolve(home, ".ssh"), label: "SSH keys" },
        { dir: resolve(home, ".aws"), label: "AWS credentials" },
        { dir: resolve(home, ".gnupg"), label: "GnuPG keyring" },
        { dir: resolve(home, ".config", "gh"), label: "GitHub CLI auth" },
    ];
    for (const { dir, label } of sensitiveDirs) {
        if (resolvedPath === dir || resolvedPath.startsWith(`${dir}/`)) {
            return label;
        }
    }
    return null;
}

/**
 * Expand `{env:VAR}` and `{file:path}` tokens in raw config text.
 *
 * Mirrors OpenCode's `ConfigVariable.substitute` semantics so users can share
 * the same patterns across `opencode.json(c)` and `magic-context.jsonc`:
 *   - `{env:VAR}` → `process.env.VAR` (trimmed key), JSON-escaped for safe inlining, empty string when missing
 *   - `{file:~/path}` → contents of `~/path`, JSON-escaped for safe inlining
 *   - `{file:./rel}` or `{file:rel}` → resolved against the config file's dir
 *   - `{file:/abs}` → resolved as absolute
 *
 * Unlike OpenCode we treat missing values as warnings rather than hard errors:
 * magic-context config is less critical than the main OpenCode config, and a
 * typo in an optional embedding key should not prevent the plugin from loading
 * with other (valid) settings.
 *
 * File and env value substitution is JSON-escaped (wrapped then unwrapped
 * through `JSON.stringify`) so line breaks, quotes, and backslashes survive
 * the subsequent JSONC parse.
 */
export function substituteConfigVariables(input: SubstituteInput): SubstituteResult {
    const warnings: string[] = [];
    let text = input.text;

    if (input.isProjectConfig) {
        const hasEnvTokens = ENV_PATTERN.test(text);
        const hasFileTokens = FILE_PATTERN.test(text);
        ENV_PATTERN.lastIndex = 0;
        FILE_PATTERN.lastIndex = 0;
        if (hasEnvTokens || hasFileTokens) {
            const tokenTypes = [
                hasEnvTokens ? "{env:}" : undefined,
                hasFileTokens ? "{file:}" : undefined,
            ]
                .filter(Boolean)
                .join(" and ");
            warnings.push(
                `Project-level config no longer supports ${tokenTypes} tokens for security reasons; leaving tokens literal. Move secret expansion to user-level config.`,
            );
        }
        return { text, warnings };
    }

    // Strip JSONC comments before substitution so tokens in comments cannot
    // trigger env/file side effects. The shared parser helper is string-aware,
    // so URL strings and literal comment markers inside strings are preserved.
    text = stripJsonComments(text);

    text = text.replace(ENV_PATTERN, (_, rawName: string) => {
        const varName = rawName.trim();
        const value = varName ? process.env[varName] : undefined;
        if (value === undefined || value === "") {
            warnings.push(
                `Environment variable ${varName} is not set (referenced via {env:${varName}}); using empty string`,
            );
            return "";
        }

        return JSON.stringify(value).slice(1, -1);
    });

    const fileMatches = Array.from(text.matchAll(FILE_PATTERN));
    if (fileMatches.length === 0) {
        return { text, warnings };
    }

    const configDir = input.configPath ? dirname(input.configPath) : process.cwd();

    let output = "";
    let cursor = 0;

    for (const match of fileMatches) {
        const token = match[0];
        const rawPath = match[1] ?? "";
        const index = match.index ?? 0;

        output += text.slice(cursor, index);
        cursor = index + token.length;

        // Skip tokens inside line comments: agents-only feature, matches OpenCode.
        // We run before JSONC parsing so raw comments are still in the text.
        const lineStart = text.lastIndexOf("\n", index - 1) + 1;
        const prefix = text.slice(lineStart, index).trimStart();
        if (prefix.startsWith("//")) {
            output += token;
            continue;
        }

        let filePath = rawPath.trim();
        if (filePath.startsWith("~/")) {
            filePath = resolve(homedir(), filePath.slice(2));
        } else if (!isAbsolute(filePath)) {
            filePath = resolve(configDir, filePath);
        }

        // Warn (don't block — this is user-level config, mirroring OpenCode's
        // {file:} semantics) when a {file:} token resolves into a known-sensitive
        // directory. A user pasting `{file:~/.ssh/id_rsa}` from a copied snippet
        // would otherwise silently inline a private key into the prompt.
        const sensitiveReason = sensitiveFilePathReason(filePath);
        if (sensitiveReason) {
            warnings.push(
                `${token} resolves to a sensitive path (${sensitiveReason}: ${filePath}); ` +
                    "inlining its contents into config — make sure this is intentional.",
            );
        }

        if (!existsSync(filePath)) {
            warnings.push(
                `File not found for ${token} (resolved to ${filePath}); using empty string`,
            );
            continue;
        }

        let contents: string;
        try {
            contents = readFileSync(filePath, "utf-8").trim();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(
                `Failed to read file for ${token} (${filePath}): ${message}; using empty string`,
            );
            continue;
        }

        // JSON-escape so embedded quotes, newlines, and backslashes don't break
        // the surrounding JSONC. Slice(1, -1) strips the outer quotes that
        // JSON.stringify adds so the token stays inside the caller's own string.
        output += JSON.stringify(contents).slice(1, -1);
    }

    output += text.slice(cursor);
    return { text: output, warnings };
}
