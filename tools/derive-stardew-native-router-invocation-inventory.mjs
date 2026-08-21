import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { deriveNativeRouterInvocationInventory } from "./lib/stardew-native-router-invocation-inventory.mjs";

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
        "router_inventory_arguments_invalid",
        "Usage: --source-root <exact-source-root> --source-path <relative.cs> --signature <exact-method-signature> --out <report.json>",
      );
    result[key.slice(2)] = value;
  }
  for (const key of ["source-root", "source-path", "signature", "out"])
    if (!result[key])
      fail(
        "router_inventory_arguments_required",
        "Usage: --source-root <exact-source-root> --source-path <relative.cs> --signature <exact-method-signature> --out <report.json>",
      );
  if (path.isAbsolute(result["source-path"]) || result["source-path"].split(/[\\/]/).includes(".."))
    fail("router_inventory_source_path_unsafe", "source-path must be a safe relative path.");
  return result;
}
async function main() {
  const input = args(process.argv.slice(2).filter((value) => value !== "--"));
  const sourcePath = input["source-path"].replaceAll("\\", "/");
  const source = await readFile(path.resolve(input["source-root"], sourcePath), "utf8");
  const report = await deriveNativeRouterInvocationInventory({
    source,
    relativePath: sourcePath,
    signature: input.signature,
  });
  const output = path.resolve(input.out);
  const temporary = `${output}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, output);
  process.stdout.write(
    `${JSON.stringify({ artifactKind: report.artifactKind, invocationCount: report.invocationCount, syntaxInventoryState: report.syntaxInventoryState })}\n`,
  );
}
main().catch((error) => {
  process.stderr.write(`${error.code ?? "router_inventory_failed"}: ${error.message}\n`);
  process.exitCode = 1;
});
