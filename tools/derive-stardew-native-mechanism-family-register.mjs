import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { deriveNativeInteractionMechanismFamilyRegister } from "./lib/stardew-native-mechanism-family-register.mjs";
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[++index];
    if (!key?.startsWith("--") || !value || value.startsWith("--"))
      fail(
        "mechanism_family_register_arguments_invalid",
        "Usage: --mechanism-report <exact-report.json> --out <family-register.json>",
      );
    result[key.slice(2)] = value;
  }
  if (!result["mechanism-report"] || !result.out)
    fail(
      "mechanism_family_register_arguments_required",
      "Usage: --mechanism-report <exact-report.json> --out <family-register.json>",
    );
  return result;
}
async function main() {
  const input = args(process.argv.slice(2).filter((value) => value !== "--"));
  let report;
  try {
    report = JSON.parse(await readFile(input["mechanism-report"], "utf8"));
  } catch (error) {
    fail("mechanism_family_register_report_invalid", `Could not read exact mechanism report: ${error.message}`);
  }
  const output = deriveNativeInteractionMechanismFamilyRegister(report);
  const destination = path.resolve(input.out);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`);
  await rename(temporary, destination);
  process.stdout.write(
    `${JSON.stringify({ artifactKind: output.artifactKind, inputMechanismCount: output.inputMechanismCount, familyCount: output.familyCount })}\n`,
  );
}
main().catch((error) => {
  process.stderr.write(`${error.code ?? "mechanism_family_register_failed"}: ${error.message}\n`);
  process.exitCode = 1;
});
