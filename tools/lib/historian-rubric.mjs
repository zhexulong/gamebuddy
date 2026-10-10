// Historian output rubric: the checks a prompt change must not break, applied to what the run produced.
//
// The obligations, their provenance and the ones that CANNOT be judged mechanically are written down in
// `design/architecture/historian-prompt-rubric.md`. This module implements the mechanical half, so a
// prompt edit is compared on facts instead of on how the summary sounds to the person who wrote it:
//
//   - `no role labels` / `no transcript references` / `no internal markers` are INVARIANTS: the
//     compartments are read back into the companion's own context, so third-person log voice and
//     message ordinals in prose are defects, not style.
//   - coverage (every compartment names its range, tiers present) is an INVARIANT of the output
//     contract, because publication depends on ordinal coverage.
//   - the gate semantics are the upstream rules the prompt exists to teach; they are checked on the
//     text because a prompt edit is exactly what could quietly relax them.
//
// Nothing here scores narrative quality, tone or dramatisation. Those are listed as unjudged in the
// document rather than approximated by a heuristic that would read as coverage.
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Third-person log voice. The companion's own recollection must not read as someone else's notes. */
const ROLE_LABEL = /\bthe (?:player|user|assistant|agent|human)\b/iu;
/** Transcript references: ordinals belong in the attributes, never in the prose. */
const TRANSCRIPT_REFERENCE = /\b(?:msg|msgs|message|messages|turn|turns|line|lines)\s*#?\d+/iu;
/** Anything the model was told never to surface. */
const INTERNAL_MARKER =
  /<\s*thinking|tool_call|tool result|sub[-_ ]?agent|orchestrator|system prompt|hidden (?:prompt|instruction)/iu;

const TIER_TAGS = ["p1", "p2", "p3", "p4"];

/** Read every compartment this run's continuity produced, newest schema shape. */
export function readCompartments(root) {
  const contexts = join(root, "contexts");
  if (!existsSync(contexts)) return [];
  const rows = [];
  for (const contextId of readdirSync(contexts)) {
    const dbPath = join(contexts, contextId, "data", "cortexkit", "magic-context", "context.db");
    if (!existsSync(dbPath)) continue;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch {
      continue;
    }
    try {
      const columns = db
        .prepare("PRAGMA table_info(compartments)")
        .all()
        .map((column) => column.name);
      const tiers = TIER_TAGS.filter((tier) => columns.includes(tier));
      const selected = ["sequence", "title", ...tiers].join(", ");
      for (const row of db.prepare(`SELECT ${selected} FROM compartments ORDER BY sequence`).all()) {
        rows.push({ ...row, tiers: tiers.map((tier) => String(row[tier] ?? "")) });
      }
    } catch {
      /* an older or unrelated database is not this rubric's business */
    } finally {
      db.close();
    }
  }
  return rows;
}

/**
 * Apply the mechanical obligations to `compartments`.
 *
 * Returns one row per compartment plus the aggregate, so a report can show WHICH compartment broke an
 * obligation instead of only that something did.
 */
export function checkHistorianRubric(compartments) {
  const violations = [];
  for (const compartment of compartments) {
    const prose = [compartment.title, ...compartment.tiers].join("\n");
    const where = `sequence ${String(compartment.sequence)}`;
    if (ROLE_LABEL.test(prose)) violations.push({ obligation: "no-role-labels", where });
    if (TRANSCRIPT_REFERENCE.test(prose)) violations.push({ obligation: "no-transcript-references", where });
    if (INTERNAL_MARKER.test(prose)) violations.push({ obligation: "no-internal-markers", where });
    if (compartment.title.trim().length === 0) violations.push({ obligation: "title-present", where });
    if (compartment.tiers[0].trim().length === 0) violations.push({ obligation: "p1-present", where });
  }
  return Object.freeze({
    compartmentsChecked: compartments.length,
    violations: Object.freeze(violations),
    // Named so a reader can see the scope: these are the obligations this function can decide.
    checkedObligations: Object.freeze([
      "no-role-labels",
      "no-transcript-references",
      "no-internal-markers",
      "title-present",
      "p1-present",
    ]),
  });
}

/**
 * Which historian prompt the run actually carried, identified from the built extension the run loaded.
 *
 * A prompt change is invisible in a report unless the report names the variant, and the freshness gate
 * only keeps the source and the generated file in step - it says nothing about which bundle a given run
 * mounted. The marker sentence is the one `## Voice` always emits, so its presence is the variant.
 *
 * The locator searches rather than assuming a layout: a generation keeps its runtime closure under
 * `generations/<id>/`, and the launcher resolves the same package by name, so pinning one relative path
 * here would silently stop finding it the next time that layout moves.
 */
export function identifyHistorianPrompt(generationRoot) {
  const packageName = join("node_modules", "@cortexkit", "pi-magic-context", "dist");
  const candidates = [join(generationRoot, packageName)];
  const generations = join(generationRoot, "generations");
  if (existsSync(generations)) {
    for (const generation of readdirSync(generations)) candidates.push(join(generations, generation, packageName));
  }
  for (const distDir of candidates) {
    if (!existsSync(distDir)) continue;
    for (const entry of readdirSync(distDir)) {
      if (!entry.endsWith(".js")) continue;
      let source;
      try {
        source = readFileSync(join(distDir, entry), "utf8");
      } catch {
        continue;
      }
      if (!source.includes("Ongoing Interaction Memory Domain")) continue;
      return Object.freeze({
        variant: source.includes('write "I" for the companion and "you" for the player')
          ? "companion-voice"
          : "legacy-third-person",
        carrier: entry,
        dist: distDir,
      });
    }
  }
  return Object.freeze({ variant: "unknown", carrier: null, dist: null });
}
