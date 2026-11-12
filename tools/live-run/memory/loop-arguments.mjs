/**
 * Unique per run so each loop gets its own Memory partition, never a stale one - unless the caller names a
 * continuity, which is how a run is pointed at history that already exists under a known partition.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

// The same bounded BCP-47 shape the Host stores for the companion language
// (settings/player-preference-store.ts). Spelled here for the same reason the browser
// contract spells it: the shape is bounded, the language set is the player's choice.
const COMPANION_LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,16}){0,3}$/;

export function createIdentity(requestedContinuityId) {
  const suffix = randomBytes(6).toString("hex");
  return Object.freeze({
    playerId: `memory_loop_player_${suffix}`,
    companionId: `memory_loop_companion_${suffix}`,
    continuityId: requestedContinuityId ?? `memory_loop_continuity_${suffix}`,
  });
}

export function usage() {
  return "usage: node tools/live-run/memory/run-memory-live-loop.mjs --report <path> [--manifest <probe-fixture.json>] [--seed <text>] [--question <text>] [--card <character-card.json|worldbook.json-dir>] [--language <bcp47>] [--fixture-fold-threshold <tokens>] [--require-chapter] [--reflect]";
}

export function parseArguments(argv) {
  // Flags that stand alone. Everything else takes exactly one value; treating a boolean as
  // value-taking made `--require-chapter` demand an argument it never has.
  const booleanFlags = new Set(["--require-chapter", "--require-historian-rubric", "--reflect"]);
  const flags = new Map([
    ["--report", undefined],
    ["--root", undefined],
    ["--continuity", undefined],
    ["--seed", undefined],
    ["--question", undefined],
    ["--manifest", undefined],
    ["--card", undefined],
    ["--language", undefined],
    // Compress the fold's window-derived trigger for this run, so a fold (and therefore a chapter)
    // happens inside a CI-sized conversation. This sets the Host's TEST-ONLY channel, which the runtime
    // writes into its OWN user-scope config inside the run's root - the only scope Magic Context accepts
    // a lowered trigger from (a project file may only raise it). Never an operator surface.
    ["--fixture-fold-threshold", undefined],
    // Refuse to pass when no chapter appeared, so a fold fixture cannot silently stop folding.
    ["--require-chapter", undefined],
    // Same idea for the historian output obligations: a run may only be cited as evidence when the
    // mechanical obligations in historian-prompt-rubric.md held.
    ["--require-historian-rubric", undefined],
    // The candidate arm of reflect-outcome-plan.md: one reflection between the seeded turns and the
    // probe, so the ONLY difference between two otherwise identical runs is whether that reflection ran.
    ["--reflect", undefined],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") return Object.freeze({ help: true });
    if (!flags.has(flag)) throw new Error(`${usage()} (unknown flag: ${flag})`);
    if (booleanFlags.has(flag)) {
      flags.set(flag, "true");
      continue;
    }
    const value = argv[index + 1];
    // A value that is itself a known flag means the caller forgot it; refusing is
    // better than silently consuming the next flag as text.
    if (value === undefined || flags.has(value)) throw new Error(usage());
    flags.set(flag, value);
    index += 1;
  }
  const language = flags.get("--language");
  if (language !== undefined && !COMPANION_LOCALE_PATTERN.test(language))
    throw new Error(`${usage()} (--language must be a bounded BCP-47 tag, for example zh-CN or ja-JP)`);
  const requireChapter = flags.get("--require-chapter");
  if (requireChapter !== undefined && requireChapter !== "true")
    throw new Error(`${usage()} (--require-chapter takes no value)`);
  const requireHistorianRubric = flags.get("--require-historian-rubric");
  if (requireHistorianRubric !== undefined && requireHistorianRubric !== "true")
    throw new Error(`${usage()} (--require-historian-rubric takes no value)`);
  const reflect = flags.get("--reflect");
  if (reflect !== undefined && reflect !== "true") throw new Error(`${usage()} (--reflect takes no value)`);
  const foldThreshold = flags.get("--fixture-fold-threshold");
  if (foldThreshold !== undefined && !/^[1-9][0-9]{2,6}$/u.test(foldThreshold))
    throw new Error(`${usage()} (--fixture-fold-threshold is a token count, for example 6000)`);
  const reportPath = flags.get("--report");
  if (typeof reportPath !== "string" || reportPath.length === 0) throw new Error(usage());
  return Object.freeze({
    help: false,
    reportPath: resolve(reportPath),
    manifestPath: flags.get("--manifest"),
    cardPath: flags.get("--card"),
    language,
    foldThreshold: foldThreshold === undefined ? undefined : Number.parseInt(foldThreshold, 10),
    requireChapter: requireChapter === "true",
    requireHistorianRubric: requireHistorianRubric === "true",
    reflect: reflect === "true",
    root: flags.get("--root"),
    continuityId: flags.get("--continuity"),
    seed: flags.get("--seed"),
    question: flags.get("--question"),
  });
}
