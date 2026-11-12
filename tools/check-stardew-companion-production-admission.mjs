// red-proof: inject  the full flag set plus a dev-only override (`--fixture-adapter`), which the P7 CLI must refuse
//  -> `{"state":"blocked","evidenceClass":"production_admission_preflight","reasonCode":"admission_cli_forbidden_override"}`, exit 2; the same flag set without the override exits 0
import {
  parseProductionAdmissionInvocation,
  runProductionAdmissionPreflight,
  writeProductionAdmissionRecord,
} from "./lib/stardew-companion-production-admission.mjs";

try {
  const invocation = parseProductionAdmissionInvocation(process.argv.slice(2));
  const record = await runProductionAdmissionPreflight(invocation);
  await writeProductionAdmissionRecord(invocation.outputPath, record);
  console.log(JSON.stringify(record));
} catch (error) {
  console.error(
    JSON.stringify({
      state: "blocked",
      evidenceClass: "production_admission_preflight",
      reasonCode: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 2;
}
