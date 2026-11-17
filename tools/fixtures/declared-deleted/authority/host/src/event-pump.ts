/**
 * FIXTURE: `host/src/event-pump.ts` at HEAD, with exactly ONE defect injected.
 *
 * The defect is the drift `tools/check-declared-deleted-facts.mjs` exists to catch: `body_idle` is gone from
 * `HELD_SEMANTIC_PROGRESS_KINDS`, so `buildFactTurnConsequence` classifies `semantic:body_idle` by its default -
 * `decision` - and a kind `design/fact-authority.md` declares a not-fact can open a turn again. Everything else is the
 * real shape: four tables, an EMPTY in-flight table on one line, and a builder that reads each table by name.
 *
 * The gate must name the member: `declared_deleted_doc_and_code_disagree:body_idle`.
 */

export const HELD_RECEIPT_PROGRESS_STATES: Readonly<Record<string, string>> = Object.freeze({
  accepted: "the terminal receipt for the same execution wakes the model",
  running: "the terminal receipt for the same execution wakes the model",
  meaningful_progress: "the terminal receipt for the same execution wakes the model",
});

export const HELD_SEMANTIC_PROGRESS_KINDS: Readonly<Record<string, string>> = Object.freeze({
  execution_started: "the receipt for the same execution wakes the model, and its terminal does too",
  route_progress: "the node's own completion or rejection arrives as a receipt fact",
});

export const IN_FLIGHT_RECEIPT_PROGRESS_STATES: Readonly<Record<string, string>> = Object.freeze({});

export const SETTLED_PROGRAM_OUTCOMES = Object.freeze({
  succeeded: Object.freeze({ why: "every node did what it was told" }),
  refused: Object.freeze({ why: "at least one node was refused" }),
});

export const FACT_TURN_CONSEQUENCE: Readonly<Record<string, string>> = buildFactTurnConsequence();

function buildFactTurnConsequence(): Readonly<Record<string, string>> {
  const table: Record<string, string> = {
    snapshot: "progress",
    world_fact: "decision",
    lifecycle: "decision",
  };
  for (const state of ["accepted", "running", "meaningful_progress"].map(String))
    table[`receipt:${state}`] = "decision";
  for (const state of Object.keys(HELD_RECEIPT_PROGRESS_STATES)) table[`receipt:${state}`] = "progress";
  for (const state of Object.keys(IN_FLIGHT_RECEIPT_PROGRESS_STATES)) table[`receipt:${state}`] = "in_flight_progress";
  for (const kind of Object.keys(HELD_SEMANTIC_PROGRESS_KINDS)) table[`semantic:${kind}`] = "progress";
  for (const outcome of Object.keys(SETTLED_PROGRAM_OUTCOMES)) table[`settled:${outcome}`] = "decision";
  return Object.freeze(table);
}
