import * as fs from "node:fs";
import * as path from "node:path";
import { getMagicContextLogPath } from "./data-path";

const isTestEnv = process.env.NODE_ENV === "test";

let buffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 500;
const BUFFER_SIZE_LIMIT = 50;

// Cache the last log directory we mkdir'd successfully so we only retry the
// filesystem call when the resolved path actually changes. The path is
// re-evaluated on every flush because `setHarness("pi")` runs after module
// load on Pi; we MUST NOT freeze it at import time, or Pi's first flush
// could land in the OpenCode subtree.
let lastEnsuredDir: string | null = null;

function ensureDir(filePath: string): void {
    const dir = path.dirname(filePath);
    if (dir === lastEnsuredDir) return;
    try {
        fs.mkdirSync(dir, { recursive: true });
        lastEnsuredDir = dir;
    } catch {
        // Intentional: logging must never throw. If mkdir fails we still
        // try the append; failure there is also swallowed.
    }
}

function flush(): void {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    if (buffer.length === 0) return;
    const data = buffer.join("");
    buffer = [];
    try {
        const logFile = getMagicContextLogPath();
        ensureDir(logFile);
        fs.appendFileSync(logFile, data);
    } catch {
        // Intentional: logging must never throw
    }
}

function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
    }, FLUSH_INTERVAL_MS);
}

export function log(message: string, data?: unknown): void {
    if (isTestEnv) return;
    try {
        const timestamp = new Date().toISOString();
        const serialized =
            data === undefined
                ? ""
                : data instanceof Error
                  ? ` ${data.message}${data.stack ? `\n${data.stack}` : ""}`
                  : ` ${JSON.stringify(data)}`;
        buffer.push(`[${timestamp}] ${message}${serialized}\n`);
        if (buffer.length >= BUFFER_SIZE_LIMIT) {
            flush();
        } else {
            scheduleFlush();
        }
    } catch {
        // Intentional: logging must never throw
    }
}

export function sessionLog(sessionId: string, message: string, data?: unknown): void {
    log(`[magic-context][${sessionId}] ${message}`, data);
}

/**
 * Resolve the current log file path. The path is harness-aware (see
 * {@link getMagicContextLogPath}) and re-evaluated on every call, so callers
 * who format diagnostic output with this value always see the path the next
 * flush will actually use.
 */
export function getLogFilePath(): string {
    return getMagicContextLogPath();
}

// Flush remaining buffer on process exit
if (!isTestEnv) {
    process.on("exit", flush);
}
