import { createHash } from "node:crypto";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { deriveNativeVirtualMemberInvocationRegister } from "./lib/stardew-native-virtual-member-invocation-register.mjs";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i],
      value = argv[++i];
    if (!key?.startsWith("--") || !value || value.startsWith("--"))
      fail(
        "virtual_member_invocation_register_arguments_invalid",
        "Usage: --source-root <exact-source-root> --method <Tool-virtual-member> --out <report.json>",
      );
    result[key.slice(2)] = value;
  }
  if (!result["source-root"] || !result.method || !result.out)
    fail(
      "virtual_member_invocation_register_arguments_required",
      "Usage: --source-root <exact-source-root> --method <Tool-virtual-member> --out <report.json>",
    );
  return result;
}
async function sources(root) {
  const todo = [root],
    output = {};
  while (todo.length) {
    const directory = todo.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) todo.push(absolute);
      else if (entry.isFile() && entry.name.endsWith(".cs")) {
        const text = await readFile(absolute, "utf8");
        output[path.relative(root, absolute).replaceAll("\\", "/")] = {
          text,
          sha256: createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
        };
      }
    }
  }
  return output;
}
async function main() {
  const input = args(process.argv.slice(2).filter((x) => x !== "--"));
  const report = await deriveNativeVirtualMemberInvocationRegister({
    sourceFiles: await sources(path.resolve(input["source-root"])),
    methodName: input.method,
  });
  const temporary = `${path.resolve(input.out)}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, path.resolve(input.out));
  process.stdout.write(
    `${JSON.stringify({ artifactKind: report.artifactKind, methodName: report.methodName, implementationCount: report.implementationCount, invocationCount: report.implementations.reduce((sum, item) => sum + item.invocationCount, 0) })}\n`,
  );
}
main().catch((error) => {
  process.stderr.write(`${error.code ?? "virtual_member_invocation_register_failed"}: ${error.message}\n`);
  process.exitCode = 1;
});
