/**
 * Provider usage, read from a run's own Pi session `.jsonl` - the one record where `cacheRead`/`cacheWrite` exist.
 *
 * WHY THIS IS A MODULE (measured 2026-10-31): `tools/perf/report-run-cost.mjs` already derived `input + cacheRead`
 * from the session record to answer "what did this run cost", while the Chat live loop measured nothing at all - its
 * 2,439 lines never mention `usage`. Two spellings of this parse disagree the day one of them learns a new usage
 * field, and then two artifacts quote different numbers for the same run. The parser therefore lives here and both
 * readers import it.
 *
 * The session record is the source, never the run trace: the harness narrows `usage` to four keys and drops
 * `cacheRead`/`cacheWrite`, so a trace cannot answer the cache question at all.
 */
import { readFileSync } from "node:fs";

/** Every message's provider usage in order, plus the tool-definition sizes the session recorded. */
export function readUsages(sessionPath) {
  const usages = [];
  const toolsAdded = [];
  for (const line of readFileSync(sessionPath, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.message?.usage !== undefined) usages.push({ ...entry.message.usage, at: entry.timestamp ?? null });
    if (entry.systemMessage?.toolsAdded !== undefined) toolsAdded.push(entry.systemMessage.toolsAdded);
  }
  return { usages, toolsAdded };
}

export const sumOf = (usages, key) => usages.reduce((total, usage) => total + (Number(usage[key]) || 0), 0);

/**
 * The peak the context threshold is about: `input + cacheRead`.
 *
 * Named explicitly because it is NOT `totalTokens` and NOT `input`. Quoting either of those as "context" is the
 * mistake this reading exists to make impossible.
 */
export function peakContext(usages) {
  let peak = 0;
  let at = null;
  for (const usage of usages) {
    const value = (Number(usage.input) || 0) + (Number(usage.cacheRead) || 0);
    if (value > peak) {
      peak = value;
      at = usage.at;
    }
  }
  return { peak, at };
}

/** Turns where the cache stopped being used after it had been, i.e. where the prompt prefix broke. */
export function cacheBreaks(usages) {
  const breaks = [];
  for (let index = 1; index < usages.length; index += 1) {
    const previous = Number(usages[index - 1].cacheRead) || 0;
    const current = Number(usages[index].cacheRead) || 0;
    // A miss after a hit means the prefix changed: the prompt was rewritten, not extended.
    if (previous > 0 && current === 0) breaks.push({ turn: index, at: usages[index].at, previousCacheRead: previous });
  }
  return breaks;
}
