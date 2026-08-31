import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
    type PiDiagnosticReport,
    renderDiagnosticsMarkdown,
    sanitizeString,
} from "./diagnostics-pi";
import { capBodyToGithubLimit, extractRecentErrors } from "./issue-body";

export function sanitizeLogContent(content: string): string {
    return sanitizeString(content);
}

function formatTimestamp(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return [
        String(date.getFullYear()),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        "-",
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ].join("");
}

export interface BundledIssueReport {
    /** Capped markdown suitable for a GitHub issue body. */
    path: string;
    bodyMarkdown: string;
    /** Full sanitized markdown when the GitHub body had to be capped. */
    fullPath?: string;
    truncated: boolean;
}

/**
 * Drop log lines that reference a session ID OTHER than `sessionId`.
 * See logs-opencode.ts for the rationale; this Pi variant uses the same
 * approach because Pi historian logs include the OpenCode-style `ses_*`
 * shape for its own child sessions and that's what the picker presents.
 */
function filterLogLinesBySession(lines: string[], sessionId: string | null): string[] {
    if (!sessionId) return lines;
    const otherSessionPattern = /\bses_[A-Za-z0-9]{8,32}\b/g;
    return lines.filter((line) => {
        const matches = line.match(otherSessionPattern);
        if (!matches) return true;
        return matches.every((id) => id === sessionId);
    });
}

export async function bundleIssueReport(
    report: PiDiagnosticReport,
    description: string,
    title: string,
    options: { cwd?: string; now?: Date; sessionFilter?: string | null } = {},
): Promise<BundledIssueReport> {
    const LOG_TAIL_LINES = 400;
    const allLogLines = report.logFile.exists
        ? readFileSync(report.logFile.path, "utf-8").split(/\r?\n/)
        : [];
    const logLines = filterLogLinesBySession(allLogLines, options.sessionFilter ?? null);
    const recentLog = sanitizeLogContent(logLines.slice(-LOG_TAIL_LINES).join("\n")).trim();

    // Pull the most recent 20 ERROR-shaped lines into their own dedicated
    // section. See logs-opencode.ts and issue-body.ts for the full
    // rationale: this section survives even when the main log block is
    // truncated to fit GitHub's ~64KB issue body limit. We scan a wide
    // window so that a flood of debug noise after the error doesn't push
    // the cause out of view.
    const errorScanWindow = sanitizeLogContent(logLines.slice(-4000).join("\n"));
    const recentErrorLines = extractRecentErrors(errorScanWindow, 20);

    const rawBodyMarkdown = [
        "## Title",
        `[pi] ${sanitizeString(title)}`,
        "",
        "## Description",
        sanitizeString(description),
        "",
        "## Environment",
        `- Pi plugin: v${report.pluginVersion}`,
        `- Pi: ${report.piVersion ?? "not installed"}`,
        `- OS: ${report.platform} ${report.arch}`,
        `- Node: ${report.nodeVersion}`,
        "",
        "## Diagnostics",
        renderDiagnosticsMarkdown(report),
        "",
        "## Recent errors (last 20, sanitized)",
        recentErrorLines.length === 0
            ? "_No error-shaped log lines found in recent history._"
            : ["```", recentErrorLines.join("\n"), "```"].join("\n"),
        "",
        `## Log (last ${LOG_TAIL_LINES} lines, sanitized)`,
        "```",
        recentLog || "<no log output>",
        "```",
    ].join("\n");

    // Cap the body at GitHub's ~64KB issue limit. If the rendered report
    // is already short enough this is a pass-through; otherwise the main
    // log block gets shrunk from the top (older lines first) and a
    // truncation marker inserted. The error section above survives intact.
    const bodyMarkdown = capBodyToGithubLimit(rawBodyMarkdown);
    const truncated = bodyMarkdown !== rawBodyMarkdown;

    const cwd = options.cwd ?? process.cwd();
    const timestamp = formatTimestamp(options.now ?? new Date());
    const path = join(cwd, `magic-context-pi-issue-${timestamp}.md`);
    writeFileSync(path, `${bodyMarkdown}\n`);

    // Keep the complete sanitized report as a local attachment when the issue
    // body had to be reduced to fit GitHub's limit.
    const fullPath = truncated
        ? join(cwd, `magic-context-pi-issue-${timestamp}-full.md`)
        : undefined;
    if (fullPath) writeFileSync(fullPath, `${rawBodyMarkdown}\n`);

    return { path, bodyMarkdown, ...(fullPath ? { fullPath } : {}), truncated };
}
