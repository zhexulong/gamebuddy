import { nextDueAtMs } from "../dreamer/cron";
import {
    SMART_NOTE_CHECK_CEILING_MS,
    SMART_NOTE_CHECK_DEFAULT_INTERVAL_MS,
    SMART_NOTE_CHECK_FLOOR_MS,
} from "./types";

export interface SmartNoteScheduleOptions {
    now?: number;
    noteId?: number;
    hash?: string | null;
    floorMs?: number;
    ceilingMs?: number;
}

export function nextSmartNoteCheckDueAt(
    cron: string | null | undefined,
    options: SmartNoteScheduleOptions = {},
): number {
    const now = options.now ?? Date.now();
    const floorMs = options.floorMs ?? SMART_NOTE_CHECK_FLOOR_MS;
    const ceilingMs = options.ceilingMs ?? SMART_NOTE_CHECK_CEILING_MS;
    const rawNext = cron?.trim() ? nextDueAtMs(cron, now, undefined, ceilingMs) : null;
    const rawDelta = rawNext ? rawNext - now : SMART_NOTE_CHECK_DEFAULT_INTERVAL_MS;
    const clamped = Math.min(ceilingMs, Math.max(floorMs, rawDelta));
    const jittered = clamped + deterministicJitterMs(clamped, options.noteId, options.hash);
    const bounded = Math.min(ceilingMs, Math.max(floorMs, jittered));
    return now + bounded;
}

function deterministicJitterMs(intervalMs: number, noteId?: number, hash?: string | null): number {
    const max = Math.min(60_000, Math.floor(intervalMs * 0.1));
    if (max <= 0) return 0;
    const seed = `${noteId ?? 0}:${hash ?? ""}`;
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    const unsigned = h >>> 0;
    return (unsigned % (max * 2 + 1)) - max;
}
