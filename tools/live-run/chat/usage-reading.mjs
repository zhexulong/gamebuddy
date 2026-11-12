/**
 * What the run's turns cost, read from the run's own Pi session records: the per-turn usages, the peak context the
 * conversation reached, the cache breaks, and the one line a reader of the log gets.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { cacheBreaks, peakContext, readUsages, sumOf } from "../../perf/run-cost-usage.mjs";
import { isPass, judgeObserved } from "../core/evidence-verdict.mjs";
import { safeReasonCode } from "./chat-audit-values.mjs";
export const CHAT_USAGE_SCHEMA = "chat_run_audit/usage/v1";

/** Every `.jsonl` session record under this run's identity context, or the reason none could be listed. */
function runSessionRecords(personaCwd) {
  if (typeof personaCwd !== "string" || personaCwd.length === 0)
    return Object.freeze({ records: [], reason: "runtime_cwd_not_established" });
  const surfacesRoot = join(personaCwd, "surface-sessions");
  let surfaces;
  try {
    surfaces = readdirSync(surfacesRoot, { withFileTypes: true });
  } catch {
    return Object.freeze({ records: [], reason: "no_surface_sessions_directory" });
  }
  const records = [];
  for (const surface of surfaces) {
    if (!surface.isDirectory()) continue;
    let entries;
    try {
      entries = readdirSync(join(surfacesRoot, surface.name, "sessions"), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries)
      if (entry.isFile() && entry.name.endsWith(".jsonl"))
        records.push(join(surfacesRoot, surface.name, "sessions", entry.name));
  }
  records.sort();
  const reason = records.length === 0 ? "no_session_record_for_run_surface_session" : null;
  return Object.freeze({ records: Object.freeze(records), reason });
}

/** The reading in its published shape; `state` and `reason` come from the evidence verdict, never from a zero. */
function usageReading({ verdict, sessionRecord, usages }) {
  const measurable = isPass(verdict);
  const peak = measurable ? peakContext(usages) : { peak: null, at: null };
  const cacheRead = measurable ? sumOf(usages, "cacheRead") : 0;
  const billable = measurable ? sumOf(usages, "input") + cacheRead : 0;
  return Object.freeze({
    schema: CHAT_USAGE_SCHEMA,
    state: verdict.state,
    reason: verdict.reason,
    // The file every number below was derived from, so a reader never has to trust a bare figure.
    sessionRecord,
    turns: measurable ? usages.length : null,
    peakInputPlusCacheRead: peak.peak,
    peakAt: peak.at,
    cacheHitRate: measurable && billable > 0 ? cacheRead / billable : null,
    cacheBreaks: measurable ? Object.freeze(cacheBreaks(usages)) : null,
  });
}

/** The reading, or the named reason there is none. Never throws: a diagnostic must not fail the run it measured. */
export function readRunUsage({ personaCwd }) {
  const unobserved = (reason, sessionRecord = null) =>
    usageReading({ verdict: judgeObserved({ observed: false, reason }), sessionRecord, usages: [] });
  const found = runSessionRecords(personaCwd);
  // Two records in one run are two possible answers, and picking either would report a neighbour's tokens as this
  // run's. The count names what to go and look at.
  if (found.records.length > 1) return unobserved(`session_record_ambiguous:${found.records.length}`);
  const sessionRecord = found.records[0] ?? null;
  if (sessionRecord === null) return unobserved(found.reason);
  let usages;
  try {
    ({ usages } = readUsages(sessionRecord));
  } catch (error) {
    return unobserved(`session_record_unreadable:${safeReasonCode(error)}`, sessionRecord);
  }
  // A record holding no provider turn is unobserved too: there is no number to publish, and a zero would be a
  // measurement nobody took.
  if (usages.length === 0) return unobserved("no_provider_usage_in_session_record", sessionRecord);
  return usageReading({ verdict: judgeObserved({ observed: true, ok: true }), sessionRecord, usages });
}

/** One line a human reading the log can use without opening the run directory. */
export function narrateUsage(usage) {
  const where = usage.sessionRecord === null ? "" : ` source=${usage.sessionRecord}`;
  if (usage.state !== "verified")
    return `[chat-live-audit] usage state=${usage.state} reason=${usage.reason}${where} (an unobserved reading is not zero)`;
  const hitRate = usage.cacheHitRate === null ? "n/a" : `${(usage.cacheHitRate * 100).toFixed(1)}%`;
  return (
    `[chat-live-audit] usage state=verified turns=${usage.turns} ` +
    `peakInputPlusCacheRead=${usage.peakInputPlusCacheRead} cacheHitRate=${hitRate} ` +
    `cacheBreaks=${usage.cacheBreaks.length}${where}`
  );
}
