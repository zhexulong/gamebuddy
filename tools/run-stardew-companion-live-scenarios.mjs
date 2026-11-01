/*
 * The live arm of the companion scenario suite - and it is NOT a live run.
 *
 * This file is a declaration of absence: production live attachment is unavailable in this build, so
 * the arm reports `blocked` with `production_live_attachment_unavailable` and exits 2, every time.
 * The forbidden-flag guard refuses any argument that would let it be driven by a fixture instead,
 * because that would make it report a pass it did not earn.
 *
 * What it settles: that nobody can mistake the fixture arm
 * (`run-stardew-companion-fixture.mjs`) for evidence about a real install. It is listed as an
 * instrument so `pnpm eval` shows it beside the arms that DO run - a name that promises a live run and
 * silently does nothing is worse than no script at all.
 */
const forbidden = new Set(["--mode", "--fixture-adapter", "--adapter", "--preflight-only", "--summary"]);
const hasForbidden = process.argv
  .slice(2)
  .some(
    (argument) =>
      forbidden.has(argument) ||
      argument.startsWith("--fixture-adapter=") ||
      argument.startsWith("--adapter=") ||
      argument.startsWith("--summary="),
  );
console.log(
  JSON.stringify({
    schema: "gamebuddy_stardew_companion_live_evidence/v1",
    state: "blocked",
    evidenceClass: "target_live",
    reasonCodes: [hasForbidden ? "live_cli_forbidden_cross_class_input" : "production_live_attachment_unavailable"],
  }),
);
process.exitCode = 2;
