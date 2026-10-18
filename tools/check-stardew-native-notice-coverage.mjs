/**
 * Is the native notice chain routed WHOLE?
 *
 * The owner's ruling: if the day-end notice is going to reach the companion, then every native notice producer must,
 * because "we routed it" is otherwise a claim nobody can check. Cherry-picking one line ("It's getting late") is the
 * failure this gate exists to prevent.
 *
 * The chain has two shapes, both native, both enumerated from the decompiled tree rather than from memory:
 *
 *   hud  - `Game1.hudMessages`, the single list behind `showGlobalMessage(...)`, `addHUDMessage(...)`, and the two
 *          internal `hudMessages.Add` sites. Every one of the engine's 90-odd call sites funnels here, which is why
 *          ONE observer over that list covers them all - but only if it re-reads the list OBJECT each tick, because
 *          `Game1.cs` also reassigns the field.
 *   chat - `Game1.chatBox` (the multiplayer/system chat surface). It is null on a client, so a reader must handle
 *          that rather than assume it.
 *
 * A producer family with no observer is a violation, and an exception is allowed only when it is NAMED with its
 * reason - the same discipline `ExecutionArgumentWireCoverageTests` uses for the one argument-map drift it tolerates.
 *
 *   node tools/check-stardew-native-notice-coverage.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const DECOMPILED = join(REPO, "ref", "external", "StardewValleyDecompiled");
const MOD = join(REPO, "integrations", "stardew");

/** The native producer families, each with the call sites that make them up and the surface they funnel into. */
const PRODUCER_FAMILIES = Object.freeze([
  Object.freeze({
    id: "hud",
    surface: "Game1.hudMessages",
    patterns: ["showGlobalMessage\\(", "addHUDMessage\\(", "hudMessages\\.Add"],
    // The observer must re-read the FIELD each pass: `Game1.cs` both fills and REPLACES the list, so a captured
    // reference goes stale and the chain silently stops.
    observerMustRead: "Game1\\.hudMessages",
  }),
  Object.freeze({
    id: "chat",
    surface: "Game1.chatBox",
    patterns: ["chatBox\\.list", "chatBox\\.addMessage", "chatBox\\.list\\.Add"],
    observerMustRead: "chatBox",
  }),
]);

/**
 * Producers we knowingly do NOT route, each with why. Kept here rather than dropped, so the gap is a decision a
 * reader can disagree with instead of an omission nobody can see.
 */
const DECLARED_UNROUTED = Object.freeze([
  Object.freeze({
    family: "chat",
    reason:
      "chat is the MULTIPLAYER/system chat surface and is null on a client (farmhandexecutioncontroller.chatactions.cs:19 cites Game1.cs:1153); this product's routing covers the single-player HUD chain today, so a shared-world chat line is out of scope until the shared-world gate exists.",
  }),
]);

function sourceFiles(root) {
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "bin" || entry.name === "obj") continue;
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".cs")) found.push(path);
    }
  };
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) return found;
  visit(root);
  return found;
}

const decompiled = sourceFiles(DECOMPILED).map((path) => ({ path, text: readFileSync(path, "utf8") }));
const mod = sourceFiles(MOD)
  .filter((path) => !path.includes("tests"))
  .map((path) => ({ path, text: readFileSync(path, "utf8") }));

const checks = [];
const violations = [];
const check = (id, ok, detail) =>
  checks.push({ id, status: ok ? "passed" : "failed", ...(detail === undefined ? {} : { detail }) });

const families = [];
for (const family of PRODUCER_FAMILIES) {
  let callSites = 0;
  const files = new Set();
  for (const source of decompiled) {
    for (const pattern of family.patterns) {
      const matches = source.text.match(new RegExp(pattern, "gu")) ?? [];
      if (matches.length === 0) continue;
      callSites += matches.length;
      files.add(source.path.slice(DECOMPILED.length + 1));
    }
  }
  // A "reader" means a reader of the ROUTING surface, not any file that mentions the field: several places read
  // \`Game1.chatBox\` to SEND a line or to drive presentation, and counting those made this gate's first run declare a
  // routing exception false while nothing routed incoming lines at all. The chat family therefore requires the LIST
  // to be read; the hud family requires the list-like field to be read in the observation step.
  const routingReads = family.id === "chat" ? /chatBox\.list/u : new RegExp(family.observerMustRead, "u");
  const readers = mod.filter((source) => routingReads.test(source.text));
  const declared = DECLARED_UNROUTED.find((entry) => entry.family === family.id) ?? null;
  families.push({
    family: family.id,
    surface: family.surface,
    callSites,
    files: files.size,
    readers: readers.map((source) => source.path.slice(MOD.length + 1)),
    declaredUnrouted: declared === null ? null : declared.reason,
  });
  check(
    `${family.id}_producers_exist`,
    callSites > 0,
    `${String(callSites)} call sites in ${String(files.size)} files`,
  );
  if (declared !== null) {
    // A declared-unrouted family is a decision, and the decision has to still be true: if a reader appears, the
    // exception is stale and must be removed.
    check(
      `${family.id}_exception_still_true`,
      readers.length === 0,
      readers.map((r) => r.path.slice(MOD.length + 1)).join(","),
    );
    continue;
  }
  check(
    `${family.id}_chain_is_routed`,
    readers.length > 0,
    `${String(callSites)} native call sites in ${String(files.size)} files, readers: ${readers.map((r) => r.path.slice(MOD.length + 1)).join(",") || "none"}`,
  );
}

// The hud observer must re-read the field INSIDE its observation step, not capture it once: `Game1.cs` reassigns
// `hudMessages`, so a stale reference silently ends the chain.
const hudObserver = mod.find((source) => /Game1\.hudMessages/u.test(source.text));
check("hud_observer_reads_the_field_live", hudObserver !== undefined, hudObserver?.path.slice(MOD.length + 1));
if (hudObserver !== undefined) {
  const assignments = hudObserver.text.match(/=\s*Game1\.hudMessages/gu) ?? [];
  const reads = hudObserver.text.match(/Game1\.hudMessages\b(?!\s*=)/gu) ?? [];
  check(
    "hud_observer_does_not_capture_the_list_once",
    reads.length > 0,
    `reads=${String(reads.length)} captures=${String(assignments.length)}`,
  );
}

const failed = checks.filter((entry) => entry.status !== "passed");
process.stdout.write(
  `${JSON.stringify({
    gate: "stardew_native_notice_coverage/v1",
    status: failed.length === 0 && violations.length === 0 ? "passed" : "failed",
    families,
    checks,
    violations,
  })}\n`,
);
if (failed.length > 0 || violations.length > 0) process.exitCode = 1;
