// The historian-voice A/B, as the rubric in design/architecture/historian-prompt-rubric.md describes it.
//
// One variable: the prompt text inside the vendor bundle the Host actually loads. Everything else - the
// generation, the fixture, the provider, the model - is identical between arms, which is what makes the two
// reports comparable at all. The loop already reports which variant a run carried
// (`observations.historianPrompt`) and how that run's compartments judged against the mechanical obligations
// (`observations.historianRubric`), so this driver only has to swap the text and keep the outputs apart.
//
//   node tools/ab-historian-voice.mjs --generation-root D:\\_gen-x --manifest <probe-fixture.json> \
//     [--card <card-or-worldbook-dir>] [--require-chapter] [--arm current|legacy|both]
//
// Restores the bundle to the CURRENT prompt on every exit, including failure, so an interrupted run cannot
// leave a generation silently carrying the other arm's prompt.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const VENDOR = join(repo, "vendor", "magic-context");
const PROMPT_PATH = "packages/plugin/src/hooks/magic-context/ongoing-interaction-historian-prompt.source.md";
const VOICE_COMMIT = "37bc69238";
const LOOP = join(repo, "tools/live-run/memory/run-memory-live-loop.mjs");
const MARKER_CURRENT = 'write "I" for the companion and "you" for the player';

const escapeForTemplate = (text) => text.replace(/\\/gu, "\\\\").replace(/`/gu, "\\`").replace(/\$\{/gu, "\\${");

function bundlePath(generationRoot) {
  const generations = join(generationRoot, "generations");
  const generation = readdirSync(generations)[0];
  const dist = join(generations, generation, "node_modules/@cortexkit/pi-magic-context/dist");
  for (const name of readdirSync(dist)) {
    if (!name.endsWith(".js")) continue;
    const text = readFileSync(join(dist, name), "utf8");
    if (text.includes(MARKER_CURRENT) || text.includes("## Voice")) return join(dist, name);
  }
  throw new Error("no thrown bundle carries the historian prompt");
}

const currentPrompt = () =>
  readFileSync(join(VENDOR, PROMPT_PATH), "utf8").trimEnd();
const legacyPrompt = () =>
  execFileSync("git", ["-C", VENDOR, "show", `${VOICE_COMMIT}^:${PROMPT_PATH}`], { encoding: "utf8" }).trimEnd();

function setArm(bundle, arm) {
  const text = readFileSync(bundle, "utf8");
  const current = escapeForTemplate(currentPrompt());
  const legacy = escapeForTemplate(legacyPrompt());
  const [from, to] = arm === "legacy" ? [current, legacy] : [legacy, current];
  if (!text.includes(from)) throw new Error(`the bundle does not carry the ${arm === "legacy" ? "current" : "legacy"} prompt to swap out`);
  writeFileSync(bundle, text.replace(from, to));
}

function runArm({ generationRoot, manifest, card, requireChapter, arm, report }) {
  const bundle = bundlePath(generationRoot);
  setArm(bundle, arm);
  try {
    const args = [LOOP, "--report", report, "--manifest", manifest, "--require-historian-rubric"];
    if (card !== undefined) args.push("--card", card);
    if (requireChapter) args.push("--require-chapter");
    const child = spawnSync(process.execPath, args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GAMEBUDDY_MEMORY_LOOP_OUTPUT_ROOT: generationRoot },
    });
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(report, "utf8"));
    } catch {
      parsed = undefined;
    }
    return {
      arm,
      exit: child.status,
      variant: parsed?.historianPrompt?.variant ?? null,
      compartmentsChecked: parsed?.historianRubric?.compartmentsChecked ?? 0,
      violations: parsed?.historianRubric?.violations ?? [],
      turn: parsed?.chat?.turnState ?? null,
      reason: child.status === 0 ? null : (parsed?.chat?.verdictReason ?? "run did not complete"),
    };
  } finally {
    setArm(bundle, arm === "legacy" ? "current" : "legacy");
  }
}

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
};
const generationRoot = flag("--generation-root");
const manifest = flag("--manifest");
if (generationRoot === undefined || manifest === undefined)
  throw new Error("usage: --generation-root <dir> --manifest <probe-fixture.json> [--card <path>] [--require-chapter] [--arm current|legacy|both]");
const card = flag("--card");
const requireChapter = argv.includes("--require-chapter");
const requested = flag("--arm") ?? "both";
const arms = requested === "both" ? ["current", "legacy"] : [requested];
if (arms.some((arm) => arm !== "current" && arm !== "legacy")) throw new Error("--arm takes current, legacy or both");

for (const arm of arms) {
  const report = join(repo, ".live-runs", `historian-voice-ab-${arm}.json`);
  process.stdout.write(`${JSON.stringify(runArm({ generationRoot, manifest, card, requireChapter, arm, report }))}\n`);
}
