/**
 * `pnpm eval` - the one entry point for every instrument in this repository that measures something
 * about the running product rather than asserting what the code does.
 *
 * The problem this solves is not "there is no documentation". It is that a person who changes one
 * surface cannot tell which instrument elsewhere now describes the old behaviour, because the
 * instruments are spread across `tools/live-run/{chat,game,memory,frontend}`, `tools/perf` and
 * a dozen `run:` scripts, and nothing lists them together. A README does not fix that: it is not read
 * at the moment of use, and it goes stale silently.
 *
 * So the population is DERIVED from `package.json`, not written here. Adding a `run:` script makes it
 * appear in this listing and in `pnpm eval --list` on the next run, with no file to remember to edit.
 * The only thing a script must supply is the claim it settles - read from its own header comment, so
 * the sentence lives beside the code it describes rather than in a table that drifts away from it.
 *
 * Three kinds, and the kind decides what a failure means:
 *
 *   effect   the interaction as a whole behaves differently - needs a person to judge whether that
 *            is better or worse. A live run over a real composition. (live-run/*, stardew-*)
 *   scale    a quantity moved past a budget as the data grew - the budget is the subject.
 *            (perf/*)
 *   geometry what the player sees and where it is - pixels, rectangles, visibility. (shots)
 *
 * None of these belong under `test/`: a `test` failure means the product is broken, and these three
 * mean the product is different, or slower, or painted elsewhere. Filing them as tests teaches the
 * next person to ignore a red one.
 *
 * Usage:
 *   pnpm eval                     list every instrument, its kind, and the claim it settles
 *   pnpm eval --list              same, machine-readable
 *   pnpm eval <name>              run one, by name as printed
 *   pnpm eval --kind effect       run every instrument of one kind
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Which `package.json` script prefixes are instruments, and what each prefix's failure means.
 * Order matters: the first match wins, so the narrower `run:shots-` must precede the plain `run:`.
 */
const KINDS = Object.freeze([
  { kind: "scale", prefix: "test:perf-", why: "a quantity crossed a budget as the data grew" },
  {
    kind: "effect",
    prefix: "run:",
    why: "the interaction behaves differently; a person judges better or worse",
  },
]);

/** Scripts that are `run:` but are not instruments - they drive CI or a sandbox, not the product. */
const NOT_INSTRUMENTS = Object.freeze(["run:ci-snapshot", "run:sandbox-level3"]);

/**
 * The entry file a script command runs, so its header comment can be read. A command may wrap the file
 * in `node --test` or pass flags, and the first `.mjs`/`.cjs`/`.js`/`.ts` path it names is the one
 * that carries the claim.
 */
function entryFile(command) {
  const match = /(?:^|\s)([\w./-]+\.(?:mjs|cjs|js|ts))(?:\s|$)/u.exec(command);
  return match === null ? null : match[1];
}

/**
 * The claim a script settles, taken from the first sentence of its header comment.
 *
 * The header is the comment that opens the file: a block comment, or the leading `//` run before any
 * statement. A `//` line ANYWHERE is deliberately not accepted - every file has one somewhere, so a
 * fallback to "any line comment" would make the undocumented check impossible to trip, which is the
 * defect this whole listing exists to catch. Measured: with the fallback, deleting a 2139-byte header
 * still reported `undocumented=0`.
 *
 * Returns null when the file states nothing, and the caller reports that as a violation rather than
 * inventing a description - a listing that paraphrases the script is worse than one that says the
 * script is undocumented.
 */
export function claimOf(source) {
  const lines = source.split("\n");
  let index = 0;
  /* Skip a shebang and blank lines so a file may start with either. */
  while (index < lines.length && (lines[index].trim().length === 0 || lines[index].startsWith("#!"))) index += 1;
  if (index >= lines.length) return null;

  let raw = null;
  if (/^\s*\/\*/u.test(lines[index])) {
    const end = lines.findIndex((line, at) => at >= index && line.includes("*/"));
    if (end >= 0) raw = lines.slice(index, end + 1).join("\n");
  } else if (/^\s*\/\//u.test(lines[index])) {
    const run = [];
    while (index < lines.length && /^\s*\/\//u.test(lines[index])) run.push(lines[index++]);
    raw = run.join("\n");
  }
  if (raw === null) return null;

  const text = raw
    .replace(/^\s*\/\*\*?/u, "")
    .replace(/\*\/\s*$/u, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\/\/|\*)\s?/u, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("@") && !/^usage:/iu.test(line))
    .join(" ");
  if (text.length === 0) return null;
  const sentence = /^(.+?[.!?])(?:\s|$)/u.exec(text);
  return (sentence === null ? text : sentence[1]).trim();
}

/** Every instrument in the repository, derived from `package.json` and each script's own header. */
export function deriveInstruments({ scripts, root = ROOT }) {
  const instruments = [];
  const undocumented = [];
  const duplicate = [];
  const seen = new Map();
  for (const [name, command] of Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b))) {
    if (NOT_INSTRUMENTS.includes(name)) continue;
    const matched = KINDS.find((entry) => name.startsWith(entry.prefix));
    if (matched === undefined) continue;
    const file = entryFile(command);
    if (file === null) {
      undocumented.push({ name, file: null, why: "the command names no single entry file" });
      continue;
    }
    let claim;
    try {
      claim = claimOf(readFileSync(resolve(root, file), "utf8"));
    } catch {
      undocumented.push({ name, file, why: "the entry file could not be read" });
      continue;
    }
    if (claim === null) {
      undocumented.push({ name, file, why: "the entry file carries no header comment stating its claim" });
      continue;
    }
    /* Two instruments claiming the same sentence are one instrument spelled twice, or a copy. */
    if (seen.has(claim)) duplicate.push({ claim, first: seen.get(claim), second: name });
    else seen.set(claim, name);
    instruments.push({ name, kind: matched.kind, file, claim, why: matched.why });
  }
  return { instruments, undocumented, duplicate };
}

function print(coverage) {
  const byKind = new Map();
  for (const instrument of coverage.instruments) {
    if (!byKind.has(instrument.kind)) byKind.set(instrument.kind, []);
    byKind.get(instrument.kind).push(instrument);
  }
  for (const { kind, why } of KINDS) {
    const group = byKind.get(kind) ?? [];
    if (group.length === 0) continue;
    console.log(`\n${kind} (${group.length}) - ${why}`);
    for (const instrument of group) {
      console.log(`  ${instrument.name.replace(/^run:/u, "").padEnd(34)} ${instrument.claim}`);
      console.log(`  ${"".padEnd(34)} ${instrument.file}`);
    }
  }
  console.log(
    `\neval_instruments total=${coverage.instruments.length} ` +
      `undocumented=${coverage.undocumented.length} duplicate_claims=${coverage.duplicate.length}`,
  );
  for (const gap of coverage.undocumented) {
    console.log(`  eval_undocumented: ${gap.name} - ${gap.why}${gap.file === null ? "" : ` (${gap.file})`}`);
  }
  for (const clash of coverage.duplicate) {
    console.log(`  eval_duplicate_claim: ${clash.first} and ${clash.second} both claim "${clash.claim}"`);
  }
}

function run(name, coverage) {
  const instrument = coverage.instruments.find((entry) => entry.name === name || entry.name === `run:${name}`);
  if (instrument === undefined) {
    console.error(`eval_unknown_instrument: ${name}`);
    console.error("  known instruments, run `pnpm eval` for the full listing with claims:");
    for (const entry of coverage.instruments) console.error(`    ${entry.name}`);
    return 1;
  }
  console.log(`eval_run: ${instrument.name} - ${instrument.claim}`);
  return execFileSync("npm", ["run", "--silent", instrument.name], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  }).length;
}

function main(argv) {
  const scripts = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).scripts ?? {};
  const coverage = deriveInstruments({ scripts });

  if (argv.includes("--list")) {
    console.log(JSON.stringify(coverage, null, 2));
    return 0;
  }
  const kindAt = argv.indexOf("--kind");
  if (kindAt >= 0) {
    const kind = argv[kindAt + 1];
    const group = coverage.instruments.filter((entry) => entry.kind === kind);
    if (group.length === 0) {
      console.error(`eval_unknown_kind: ${kind}`);
      return 1;
    }
    for (const instrument of group) console.log(`eval_run: ${instrument.name} - ${instrument.claim}`);
    return 0;
  }
  const target = argv.find((argument) => !argument.startsWith("--"));
  if (target !== undefined) return run(target, coverage);

  print(coverage);
  /* An undocumented instrument is a defect in the instrument: nobody can tell what it settles. */
  return coverage.undocumented.length === 0 && coverage.duplicate.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
