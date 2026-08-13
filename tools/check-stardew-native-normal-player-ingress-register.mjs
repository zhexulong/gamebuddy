import { readFile } from "node:fs/promises";
import path from "node:path";
import { verifyExactMechanismReportSources } from "./lib/stardew-native-mechanism-review-register.mjs";
import { validateNativeNormalPlayerIngressRegister } from "./lib/stardew-native-normal-player-ingress-register.mjs";
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[++i];
    if (!key?.startsWith("--") || !value || value.startsWith("--"))
      fail(
        "normal_player_ingress_arguments_invalid",
        "Usage: --register <ingress.json> --mechanism-report <exact-report.json> --source-root <fresh-exact-decompile-root>",
      );
    result[key.slice(2)] = value;
  }
  if (!result.register || !result["mechanism-report"] || !result["source-root"])
    fail(
      "normal_player_ingress_arguments_required",
      "Usage: --register <ingress.json> --mechanism-report <exact-report.json> --source-root <fresh-exact-decompile-root>",
    );
  return result;
}
async function json(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    fail("normal_player_ingress_json_invalid", `Could not read ${label}: ${error.message}`);
  }
}
async function exactSources(report, root) {
  const entries = await Promise.all(
    report.source.files.map(async (source) => [
      source.relativePath,
      { sha256: source.sha256, text: await readFile(path.join(root, source.relativePath), "utf8") },
    ]),
  );
  return Object.fromEntries(entries);
}
async function main() {
  const input = args(process.argv.slice(2).filter((value) => value !== "--"));
  const report = await json(input["mechanism-report"], "mechanism report");
  const register = await json(input.register, "ingress register");
  const sourceFiles = await exactSources(report, path.resolve(input["source-root"]));
  verifyExactMechanismReportSources(
    report,
    Object.fromEntries(Object.entries(sourceFiles).map(([relativePath, source]) => [relativePath, source.text])),
  );
  const result = validateNativeNormalPlayerIngressRegister(register, {
    expectedAttestation: {
      targetAssemblySha256: report.target.sha256,
      sourceManifestSha256: report.source.sourceManifestSha256,
    },
    sourceFiles,
  });
  process.stdout.write(
    `${JSON.stringify({ artifactKind: "native_normal_player_ingress_and_caller_register_check", ...result })}\n`,
  );
}
main().catch((error) => {
  process.stderr.write(`${error.code ?? "normal_player_ingress_check_failed"}: ${error.message}\n`);
  process.exitCode = 1;
});
