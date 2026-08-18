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
