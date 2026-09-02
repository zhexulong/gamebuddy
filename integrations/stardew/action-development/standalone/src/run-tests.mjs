import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEST_DIRECTORY = path.join(PACKAGE_DIRECTORY, "tests");
const SAFE_TEST_FILE = /^[a-z0-9][a-z0-9-]*\.test\.mjs$/;

function fail(code) {
  throw new Error(`stardew_action_test_launcher_${code}`);
}

export async function listPackageTests() {
  let entries;
  try { entries = await readdir(TEST_DIRECTORY, { withFileTypes: true }); } catch { fail("tests_unreadable"); }
  const tests = entries
    .filter((entry) => entry.isFile() && SAFE_TEST_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (tests.length === 0) fail("tests_missing");
  return Object.freeze(tests.map((name) => `tests/${name}`));
}

export async function runPackageTests({ spawnProcess = spawn } = {}) {
  if (typeof spawnProcess !== "function") fail("invalid_spawn");
  const tests = await listPackageTests();
  await new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, ["--test", "--test-concurrency=1", ...tests], { cwd: PACKAGE_DIRECTORY, shell: false, stdio: "inherit", windowsHide: true });
    child.once("error", () => reject(new Error("stardew_action_test_launcher_failed")));
    child.once("close", (code, signal) => code === 0 && !signal ? resolve() : reject(new Error("stardew_action_test_launcher_failed")));
  });
  return tests;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPackageTests().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
