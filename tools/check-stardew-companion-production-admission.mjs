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
