/**
 * Which native fields the model is never shown, and why that is allowed.
 *
 * The defect this exists for is not one missing field - it is the SHAPE of how fields go missing.
 * `SNAPSHOT_KEYS` (`host/src/protocol.ts:1599`) declares what the Mod publishes. Four projections decide what
 * reaches the model: `snapshot-projection.ts` (the user-turn fact block),
 * `runtime-core.internal.ts` (the `<runtime-environment>` line), `stardew-observation-budget.ts` (the
 * `stardew_observe` payload) and `body-program-script.ts` (the plan builder's action set). When the native layer
 * grows a field, nothing forces any of them to notice.
 *
 * Measured 2026-10-28: `actorDispositionDetail` had been on the wire since the disposition work
 * (`farmhandexecutioncontroller.cs:2401`, `protocol.ts:272-276`), and a `ShippingMenu` owned the screen while the
 * projection said `Actionable: true`. The model read that as "nothing is in the way", announced it was going to
 * pick cauliflowers, and the game clock stayed frozen at 06:00 for 31 minutes.
 *
 * So: every key in `SNAPSHOT_KEYS` is either READ by one of the projections, or explicitly declared unread here
 * with the reason. A new native field is then a decision someone made, not a fact nobody noticed.
 *
 * This is a static check over source and types, not a render. It answers "does any projection look at this key",
 * which is the question that went unanswered. Whether a read field is RENDERED WELL is each projection's own
 * tests' job - this gate would not have caught a wrong label, and must not pretend to.
 */

/** Keys the projections are expected to read. The gate fails when one of these stops being read. */
export const REQUIRED_PROJECTED_KEYS = Object.freeze([
  "revision",
  "location",
  "tile",
  "stamina",
  "exhausted",
  "health",
  "currentTool",
  "actorDispositionKind",
  "actorDispositionDetail",
  "actorDispositionActionOwned",
  "dayOfMonth",
  "seasonIndex",
  "year",
  "timeOfDay",
  "weather",
  "catalogRevision",
  "capabilities",
]);

/**
 * Keys deliberately withheld from the model, each with the reason it is withheld.
 *
 * A reason here is not decoration: it is the record that someone looked. An entry that no longer has a reason is
 * the same as an unread field - the gate cannot tell the difference, and neither can the next reader.
 */
export const WITHHELD_SNAPSHOT_KEYS: Readonly<Record<string, string>> = Object.freeze({
  // Target families are not "withheld" so much as delivered per-family, bounded by `SNAPSHOT_FAMILY_RULES` and
  // read by the observation budget rather than the turn's fact block. They are listed by family below rather than
  // one by one.
});

/**
 * The four projections, each read as source text.
 *
 * Sources, not objects, because the question is "does this layer reference the key at all" - and importing the
 * projections would only answer it for the paths this test happens to construct.
 */
export const PROJECTION_SOURCES = Object.freeze([
  "host/src/snapshot-projection.ts",
  "host/src/runtime-core.internal.ts",
  "host/src/stardew-observation-budget.ts",
  "host/src/body-program-script.ts",
]);

/** Whether a projection source mentions a snapshot key in a field-position read. */
export function projectionReads(source: string, key: string): boolean {
  // A key is READ when it appears as `.key`, as `"key"` in a destructure, or as `snapshot.key`. A bare mention in
  // a comment is not a read, and the pattern requires a preceding dot or quote to say so.
  const patterns = [
    new RegExp(`\\.${key}\\b`),
    new RegExp(`["']${key}["']`),
    // A destructure binding is a read too: `const { actorDispositionDetail } = snapshot` names the key with no
    // dot and no quotes, and that is how the projections actually take most fields.
    new RegExp(`\\{[^}]*\\b${key}\\b[^}]*\\}\\s*=`),
  ];
  // Strip comments first: this file's own prose names keys it does not read, and a gate that counts its own
  // documentation as a read is the "check that reads the wrong thing" failure this repo keeps paying for.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
  return patterns.some((pattern) => pattern.test(code));
}
