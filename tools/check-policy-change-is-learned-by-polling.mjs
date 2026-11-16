#!/usr/bin/env node
/**
 * A RUNNING world learns an action-policy change from a MESSAGE, never from a poll of `config.json`.
 *
 * WHY. The Host already writes the player's action policy into the Mod's `config.json`, and the Mod used to
 * learn about it by re-reading that document on a 120-tick (2 s at 60 Hz) throttle
 * (`FarmhandPolicyRefreshThrottle.ShouldRefresh`). So a settings save reached a running world through the
 * filesystem: a read, a deserialize and a whole config parse on the game's main thread, twice a second, for
 * as long as a world was open - and the observable latency was "about two seconds", which is the interval
 * and not the delivery. The change now arrives as a `farmhand_action_policy_request` frame on the
 * authenticated pipe, carrying the same two denial keys the document carries; the document remains, because
 * a policy the player set while the game was CLOSED cannot arrive as a message - there was no pipe to
 * deliver it on - and it is read exactly once, in `Entry`.
 *
 * WHAT IT ASSERTS, over every `.cs` source of the Mod and its Core assembly:
 *
 *   1. every read of `config.json` is inside the ONE startup load (`ModEntry.Entry`), and
 *   2. the startup load exists at all - a Mod that never read the document could not honour a policy set
 *      before launch, and "no reads" must not read as "no polling".
 *
 * WHAT COUNTS AS A READ, named so the reading is not a matter of opinion: SMAPI's typed `ReadConfig<...>()`,
 * and a `File.Read*` / `File.OpenRead`-family call whose argument mentions `config`. Writes are not reads and
 * are not in the population: the Mod writes this document itself (`PersistVerifiedFarmhandScope` ->
 * `Helper.WriteConfig`), and a write is how the answer becomes durable for the next world load.
 *
 * THE POPULATION IS DERIVED, not listed: every `.cs` file under `integrations/stardew`, minus `tests/`
 * (a test reading the document is not a running world reading it) and minus build output (`bin/`, `obj/`). A
 * read added anywhere in the Mod joins this gate with no edit here, and the finding names the member
 * by file, line and enclosing call site. Zero examined is BLOCKED with exit 2, never green.
 *
 * red-proof: inject  a `Helper.ReadConfig<ModConfig>()` into a tick method (measured 2026-11-16 by adding one
 *                    to `ModEntry.ObserveBridgeGeneration`) -> exit 1:
 *                    "policy_change_is_learned_by_polling:integrations/stardew/ModEntry.cs:... read outside
 *                    the startup load by GameBuddy.Stardew.ModEntry+ObserveBridgeGeneration". The same defect
 *                    at the IL level is refused by the compiled contract
 *                    (`farmhandcapabilitypublicationprojectionmetadata.cs`, which scans every method body of
 *                    the built assembly for `IModHelper.ReadConfig`).
 * red-proof: inject  remove the startup load -> exit 2, "the startup load is missing".
 * red-proof: inject  point the scan at a tree with no `.cs` at all -> exit 2, "examined 0".
 */

export const gateDeclaration = {
  id: "check-policy-change-is-learned-by-polling",
  domain: "stardew",
  tier: "l0",
  kind: "contract",
};

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The Mod's source root: the one authority for "what the Mod compiles". */
export const MOD_SOURCE_ROOT = "integrations/stardew";

/** Directories whose `.cs` files are not the running Mod. */
const NOT_THE_MOD = new Set(["tests", "bin", "obj", "node_modules", ".git"]);

/** The one method allowed to read the document, and the reason the word `Entry` is a fact rather than a name. */
const STARTUP_LOAD_METHOD = "Entry";

/** SMAPI's typed config read, however the helper expression is spelled. */
const TYPED_CONFIG_READ = /\bReadConfig\s*(?:<[^>]*>)?\s*\(/gu;

/** A file read whose argument mentions the config document. Writes are deliberately not matched. */
const FILE_CONFIG_READ =
  /\bFile\s*\.\s*(?:ReadAllText|ReadAllTextAsync|ReadAllBytes|ReadAllBytesAsync|ReadLines|OpenRead|OpenText)\s*\(/gu;

/** A file read's argument names the config DOCUMENT when it names the document itself. */
const CONFIG_DOCUMENT_ARGUMENT =
  /config\.json|\b(?:ModConfigFile|modConfigFile|ConfigFilePath|configFilePath|ConfigPath|configPath)\b/u;

/** Everything the report needs about one read. */
const READ = "read";

/**
 * Every `.cs` file of the Mod, relative to `root`, sorted.
 *
 * The scan is the population's only source: no file list is maintained here, so a new source file is
 * examined without an edit and cannot leave the population silently.
 */
export function modSourceFiles(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (NOT_THE_MOD.has(entry.name)) continue;
        walk(join(directory, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".cs")) found.push(join(directory, entry.name));
    }
  };
  walk(join(root, MOD_SOURCE_ROOT));
  return found.map((path) => relative(root, path).replace(/\\/gu, "/")).sort();
}

/** Line and column of a byte offset, both 1-based. */
function positionOf(source, offset) {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/**
 * The span of the startup load's body, or null when the file declares no `Entry(IModHelper ...)`.
 *
 * Braces are matched from the signature's own block, because the honest question is "is this read inside
 * the one method that runs once", not "does the surrounding text look like a startup load".
 */
function startupLoadSpan(source) {
  const signature = new RegExp(`\\b${STARTUP_LOAD_METHOD}\\s*\\(\\s*IModHelper\\b`, "u").exec(source);
  if (signature === null) return null;
  const open = source.indexOf("{", signature.index + signature[0].length);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    if (character !== "}") continue;
    depth -= 1;
    if (depth === 0) return { start: open, end: index };
  }
  return null;
}

/** The argument text of the call whose `(` is at `open`, up to its matching `)`. */
function callArguments(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") depth += 1;
    if (character !== ")") continue;
    depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  return "";
}

/**
 * Every read of the config document in one file, classified by its call site.
 *
 * A read is `at startup` only when it sits inside the `Entry` body; everything else is `periodic`, because a
 * read that is not the startup load can run on a frame, on a timer or on a message, and it is the frame path
 * this gate exists to keep out.
 */
export function configReadsIn(relativePath, source) {
  const span = startupLoadSpan(source);
  const reads = [];
  const record = (offset) => {
    const { line, column } = positionOf(source, offset);
    const atStartup = span !== null && offset > span.start && offset < span.end;
    reads.push(
      Object.freeze({
        site: `${relativePath}:${line}:${column}`,
        line,
        column,
        atStartup,
      }),
    );
  };

  for (const match of source.matchAll(TYPED_CONFIG_READ)) record(match.index);

  for (const match of source.matchAll(FILE_CONFIG_READ)) {
    const open = source.indexOf("(", match.index);
    const argument = callArguments(source, open);
    // The DOCUMENT, not any expression that happens to contain the word: `this.config.ManifestPath` is the
    // Mod's config OBJECT (a different file, read on a different clock), and matching the bare token counted
    // it as a document read.
    if (!CONFIG_DOCUMENT_ARGUMENT.test(argument)) continue;
    record(match.index);
  }

  return reads.sort((left, right) => left.line - right.line || left.column - right.column);
}

/**
 * The verdict over one tree.
 *
 * `status` is `passed`, `failed` or `blocked`; `examined`/`atStartup`/`periodic` are the three numbers the
 * report prints, and `findings` names every drifting member by site.
 */
export function checkPolicyReads(root) {
  const files = modSourceFiles(root);
  const reads = [];
  for (const file of files) {
    for (const read of configReadsIn(file, readFileSync(join(root, file), "utf8"))) reads.push(read);
  }
  const atStartup = reads.filter((read) => read.atStartup);
  const periodic = reads.filter((read) => !read.atStartup);

  const findings = periodic.map((read) => `policy_change_is_learned_by_polling:${read.site}`);
  if (reads.length === 0) {
    return Object.freeze({
      status: "blocked",
      reason: "examined 0 · this gate found no config.json read at all, so a green run would prove nothing",
      examined: 0,
      files: files.length,
      atStartup: 0,
      periodic: 0,
      reads,
      findings,
    });
  }
  if (atStartup.length === 0) {
    return Object.freeze({
      status: "blocked",
      reason:
        "the startup load is missing: a policy the player set while the game was closed arrives only through config.json, and nothing reads it",
      examined: reads.length,
      files: files.length,
      atStartup: 0,
      periodic: periodic.length,
      reads,
      findings,
    });
  }
  return Object.freeze({
    status: findings.length === 0 ? "passed" : "failed",
    reason: null,
    examined: reads.length,
    files: files.length,
    atStartup: atStartup.length,
    periodic: periodic.length,
    reads,
    findings,
  });
}

/** The one report line the brief asks for, then every read with its call site. */
export function formatReport(verdict) {
  const lines = [
    `[policy-reads] files examined ${verdict.files} · config reads examined ${verdict.examined} · at startup ${verdict.atStartup} · periodic ${verdict.periodic}`,
  ];
  for (const read of verdict.reads) lines.push(`  ${read.atStartup ? "at startup" : "PERIODIC  "} ${read.site}`);
  return lines.join("\n");
}

function main() {
  const rootArgument = process.argv.indexOf("--root");
  const root =
    rootArgument >= 0 && process.argv[rootArgument + 1] !== undefined ? resolve(process.argv[rootArgument + 1]) : ROOT;
  const verdict = checkPolicyReads(root);
  console.log(formatReport(verdict));
  if (verdict.status === "blocked") {
    console.error(`[policy-reads] blocked: ${verdict.reason}`);
    process.exit(2);
  }
  if (verdict.status === "failed") {
    for (const finding of verdict.findings)
      console.error(
        `${finding} - config.json is read outside the startup load. A running world learns an action-policy change ` +
          "from the farmhand_action_policy_request frame; a read here is a poll of the durable document.",
      );
    process.exit(1);
  }
  console.log("[policy-reads] passed: the only config.json read is the startup load");
  process.exit(0);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();

export { READ };
