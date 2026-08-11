import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const script = resolve(root, "tools", "verify-stardew-scaffold.ps1");

test("scaffold checker accepts the intentional partial ModEntry declaration", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /public sealed partial class ModEntry : Mod/);
  assert.doesNotMatch(source, /"public sealed class ModEntry : Mod"/);
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-ProjectRoot", root], { cwd: root, stdio: "pipe", windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`scaffold_checker_failed:${code}\n${output}`)));
  });
});
