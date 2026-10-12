// The historian-voice A/B, as the rubric in design/architecture/historian-prompt-rubric.md describes it.
//
// One variable: the prompt text the Host loads. Everything else - the fixture, the provider, the model - is
// identical between arms, which is what makes the two verdicts comparable.
//
// Two hard-won rules are encoded here, because breaking either one produces a confident, wrong answer:
//
//   1. Switch the arm by REWRITING THE PROMPT SOURCE and REBUILDING, never by editing a built bundle. The
//      prompt lives inside a template literal in the output; an escaped search that misses leaves both arms
//      holding the same prompt while their labels differ, which is worse than failing.
//   2. Take the run root from what the fixture PRINTS (`kept root: ...`), never from a guess about the temp
//      directory. Guessing reported `compartments=0` for runs that had in fact folded, and that false zero
//      was believed for a day.
//
// Restores the prompt source and the generated prompt on every exit, including failure. It never touches
// the fixture, so there is nothing of its own to undo there.
//
//   node tools/ab-historian-voice.mjs --arm both
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHistorianRubric, readCompartments } from "./lib/historian-rubric.mjs";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const vendor = join(repo, "vendor/magic-context");
const promptPath = "packages/plugin/src/hooks/magic-context/ongoing-interaction-historian-prompt.source.md";
const promptFile = join(vendor, promptPath);
const generatedFile = join(
  vendor,
  "packages/plugin/src/hooks/magic-context/ongoing-interaction-historian-prompt.generated.ts",
);
const VOICE_COMMIT = "37bc69238";
const THRESHOLD_TOKENS = "4000";
const PROTECTED_TOKENS = "4000";

const git = (...args) => execFileSync("git", ["-C", vendor, ...args], { encoding: "utf8" });
// `bun` is a `.cmd` shim on Windows, which Node cannot spawn directly.
const bun = (args, cwd) => execFileSync("cmd", ["/c", "bun", ...args], { cwd, encoding: "utf8", stdio: "pipe" });

const currentPrompt = () => readFileSync(promptFile, "utf8");
const legacyPrompt = () => `${git("show", `${VOICE_COMMIT}^:${promptPath}`).trimEnd()}\n`;
const restorePrompt = () => git("checkout", "--", promptPath, "packages/plugin/src/hooks/magic-context/ongoing-interaction-historian-prompt.generated.ts");

function setPrompt(text) {
  writeFileSync(promptFile, `${text.trimEnd()}\n`);
  bun(["scripts/build-ongoing-interaction-historian-prompt.ts"], join(vendor, "packages/plugin"));
  bun(["run", "build"], join(vendor, "packages/pi-plugin"));
}

function runFixture() {
  // Self-contained: compile just this fixture into a scratch output, then run it. Depending on a scratch
  // harness in `_gate-run` would make a committed tool unusable for anyone else.
  const outDir = join(repo, "host/.ab-voice");
  const config = join(repo, "host/tsconfig.ab-voice.json");
  rmSync(outDir, { recursive: true, force: true });
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        extends: "./tsconfig.json",
        include: [],
        files: ["src/pi-magic-context-chapter-fold.test.ts"],
        compilerOptions: {
          noEmit: false,
          noEmitOnError: false,
          declaration: false,
          declarationMap: false,
          sourceMap: false,
          outDir: ".ab-voice",
          rootDir: "src",
        },
      },
      null,
      2,
    )}\n`,
  );
  let out = "";
  try {
    execFileSync(process.execPath, [join(repo, "host/node_modules/typescript/lib/tsc.js"), "-p", config], {
      cwd: join(repo, "host"),
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch {
    // `noEmitOnError` is off: the emit is what matters, and other lanes' type errors are not this tool's job.
  }
  try {
    out = execFileSync(process.execPath, ["--test", join(outDir, "pi-magic-context-chapter-fold.test.js")], {
      cwd: join(repo, "host"),
      encoding: "utf8",
      env: { ...process.env, TMP: "D:/_agt-tmp", TEMP: "D:/_agt-tmp" },
    });
  } catch (error) {
    out = String(error?.stdout ?? error?.message ?? error);
  } finally {
    rmSync(config, { force: true });
  }
  const kept = /kept root: (.+)/u.exec(out);
  if (kept === null) throw new Error(`the fixture reported no kept root: ${out.trim().split("\n").slice(-3).join(" | ")}`);
  return kept[1].trim();
}

const argv = process.argv.slice(2);
const at = argv.indexOf("--arm");
const requested = at < 0 ? "both" : argv[at + 1];
const arms = requested === "both" ? ["current", "legacy"] : [requested];
if (arms.some((arm) => arm !== "current" && arm !== "legacy")) throw new Error("--arm takes current, legacy or both");

try {
  // The fixture keeps its root only when asked, and the fold needs the trigger compressed for a CI-sized
  // conversation - both are its own documented switches, not changes to the fixture.
  process.env.GAMEBUDDY_CHAPTER_FOLD_FORCE = "1";
  process.env.GAMEBUDDY_CHAPTER_FOLD_KEEP_ROOT = "1";
  process.env.GAMEBUDDY_MAGIC_CONTEXT_TEST_EXECUTE_THRESHOLD_TOKENS = THRESHOLD_TOKENS;
  process.env.GAMEBUDDY_MAGIC_CONTEXT_TEST_PROTECTED_TOKENS = PROTECTED_TOKENS;
  for (const arm of arms) {
    setPrompt(arm === "legacy" ? legacyPrompt() : currentPrompt());
    const root = runFixture();
    const compartments = readCompartments(root);
    const rubric = checkHistorianRubric(compartments);
    if (rubric.compartmentsChecked === 0)
      // Not a pass and not a silent zero: with nothing to judge, the arm measured nothing.
      process.stdout.write(`ARM ${arm}: NO COMPARTMENTS at ${root} - the fold did not happen, nothing was judged\n`);
    else
      process.stdout.write(
        `ARM ${arm}: compartments=${rubric.compartmentsChecked} violations=${JSON.stringify(rubric.violations)}\n`,
      );
  }
} finally {
  restorePrompt();
  rmSync(join(repo, "host/.ab-voice"), { recursive: true, force: true });
}
