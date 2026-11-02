import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEST_DIRECTORY = path.join(PACKAGE_DIRECTORY, "tests");
const SAFE_TEST_FILE = /^[a-z0-9][a-z0-9-]*\.test\.mjs$/u;

/*
 * A test that cannot run without a licensed game folder says so in its own header:
 *
 *   // requires-game-folder: <why it needs one>
 *
 * The declaration lives in the file that has the requirement, the same way this repository's gates
 * carry their own `red-proof:` marker. A central list would be a second spelling of a fact whose owner
 * is the test - and the first time a new such test was added, the list would not know.
 *
 * Why the name matters: a skipped test that is not named is indistinguishable from a test that passed,
 * and the whole reason this runner grew the concept is that `static-verifier-real-tracer` failed for a
 * month on hosted runners for a reason that had nothing to do with the code it checks.
 */
const GAME_FOLDER_MARKER = /^\s*\/\/\s*requires-game-folder:\s*(\S.*)$/u;

function fail(code) {
  throw new Error(`stardew_action_test_launcher_${code}`);
}

async function gameFolderIsUsable(environment) {
  const configured = environment.GAMEBUDDY_STARDEW_GAME_PATH;
  if (typeof configured !== "string" || configured.trim().length === 0) return false;
  try {
    await readFile(path.join(configured, "Stardew Valley.dll"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Split the package's tests into the ones that can run here and the ones that declare a prerequisite
 * this machine does not meet, with the reason each gave.
 */
export async function listPackageTests({ environment = process.env } = {}) {
  let entries;
  try {
    entries = await readdir(TEST_DIRECTORY, { withFileTypes: true });
  } catch {
    fail("tests_unreadable");
  }
  const names = entries
    .filter((entry) => entry.isFile() && SAFE_TEST_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) fail("tests_missing");

  const gameFolder = await gameFolderIsUsable(environment);
  const runnable = [];
  const blocked = [];
  for (const name of names) {
    const source = await readFile(path.join(TEST_DIRECTORY, name), "utf8");
    const declared = GAME_FOLDER_MARKER.exec(source.split("\n").find((line) => GAME_FOLDER_MARKER.test(line)) ?? "");
    if (declared !== null && !gameFolder) {
      blocked.push(Object.freeze({ entry: `tests/${name}`, reason: declared[1].trim() }));
      continue;
    }
    runnable.push(`tests/${name}`);
  }
  return Object.freeze({
    tests: Object.freeze(runnable),
    blocked: Object.freeze(blocked),
  });
}

/**
 * Run the package's tests. Resolves `{ tests, blocked }`; rejects on a non-zero exit.
 *
 * `exitCode` is returned rather than thrown for the blocked case so the caller that owns the meaning of
 * "ran, but did not run everything" decides it. `portfolio.mjs` already treats exit 2 as `blocked`.
 */
export async function runPackageTests({ spawnProcess = spawn, environment = process.env } = {}) {
  if (typeof spawnProcess !== "function") fail("invalid_spawn");
  const { tests, blocked } = await listPackageTests({ environment });
  for (const entry of blocked) {
    process.stderr.write(`stardew_action_test_not_run: ${entry.entry}: ${entry.reason}\n`);
  }
  if (tests.length === 0) fail("every_test_needs_a_game_folder");
  await new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
      cwd: PACKAGE_DIRECTORY,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", () => reject(new Error("stardew_action_test_launcher_failed")));
    child.once("close", (code, signal) => (code === 0 && !signal ? resolve() : reject(new Error("stardew_action_test_launcher_failed"))));
  });
  return Object.freeze({ tests, blocked });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPackageTests().then(
    ({ blocked }) => {
      /* Exit 2 means "everything that could run, ran, and passed; something could not run here". */
      if (blocked.length > 0) process.exitCode = 2;
    },
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
