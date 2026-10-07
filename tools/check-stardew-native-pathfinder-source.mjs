#!/usr/bin/env node
/**
 * Source gate: every production PathFindController construction must use an
 * owned goal predicate and leave evidence of the native plan or its refusal.
 *
 * The coordinate overloads pass PathFindController.isAtEndPoint. On the target
 * game version that constructor has a no-farmers branch which places the actor
 * directly and leaves pathToEndPoint null. A source-only check cannot execute
 * the game, but it can make that dangerous overload unrepresentable in the Mod
 * tree and require the adjacent evidence contract at every call site.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const DEFAULT_ROOTS = ["integrations/stardew"];
const SOURCE_EXTENSIONS = new Set([".cs", ".ts"]);
const EXCLUDED_PARTS = new Set(["bin", "obj", "tests", "__tests__"]);

function shouldScan(path) {
  const lower = path.toLowerCase();
  if (![...SOURCE_EXTENSIONS].some((extension) => lower.endsWith(extension))) return false;
  return !lower.split(/[\\/]/u).some((part) => EXCLUDED_PARTS.has(part));
}

function collectFiles(root) {
  const files = [];
  const visit = (path) => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
    } else if (shouldScan(path)) {
      files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

function stripComments(source) {
  let output = "";
  let inBlock = false;
  let inString = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (inBlock) {
      if (character === "*" && next === "/") {
        inBlock = false;
        output += "  ";
        index += 1;
      } else {
        output += character === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (!inString && character === "/" && next === "*") {
      inBlock = true;
      output += "  ";
      index += 1;
      continue;
    }
    if (!inString && character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if ((character === '"' || character === "'") && source[index - 1] !== "\\") {
      inString = inString === character ? null : inString ?? character;
    }
    output += character;
  }
  return output;
}

function matchingParen(source, open) {
  let depth = 0;
  let quote = null;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if ((character === '"' || character === "'") && source[index - 1] !== "\\") {
      quote = quote === character ? null : quote ?? character;
      continue;
    }
    if (quote) continue;
    if (character === "(") depth += 1;
    else if (character === ")" && --depth === 0) return index;
  }
  return -1;
}

function splitArguments(source) {
  const argumentsFound = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if ((character === '"' || character === "'") && source[index - 1] !== "\\") {
      quote = quote === character ? null : quote ?? character;
      continue;
    }
    if (quote) continue;
    if (["(", "[", "{", "<"].includes(character)) depth += 1;
    else if ([")", "]", "}", ">"].includes(character)) depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      argumentsFound.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  argumentsFound.push(source.slice(start).trim());
  return argumentsFound;
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function sourcePath(path) {
  return relative(REPOSITORY_ROOT, path).replaceAll("\\", "/");
}

function inspectSource(path, source) {
  const clean = stripComments(source);
  const findings = [];
  const callPattern = /new\s+PathFindController\s*\(/gu;
  let match;
  let callCount = 0;
  while ((match = callPattern.exec(clean)) !== null) {
    callCount += 1;
    const open = clean.indexOf("(", match.index);
    const close = matchingParen(clean, open);
    if (close < 0) {
      findings.push({ path: sourcePath(path), line: lineNumber(clean, match.index), code: "pathfinder_call_unbalanced" });
      continue;
    }
    const args = splitArguments(clean.slice(open + 1, close));
    const line = lineNumber(clean, match.index);
    const goal = args[2] ?? "";
    const ownedPredicate = goal.includes("=>") || /\b(?:IsArrivalTile|IsAtEnd|Arrival)\s*\(/u.test(goal);
    if (!ownedPredicate || /\bisAtEndPoint\b|PathFindController\.isAtEnd/u.test(goal)) {
      findings.push({
        path: sourcePath(path),
        line,
        code: "native_pathfinder_goal_not_owned_predicate",
        detail: goal.slice(0, 120),
      });
    }
  }

  // Call-site evidence is intentionally source-local. A future caller cannot
  // satisfy this by pointing to an unrelated planner's receipt elsewhere.
  if (callCount > 0 && !/(pathToEndPoint|planned_tiles\s*=|bed_walk_unplanned|no_native_path|path_unplanned|movement_refused)/u.test(clean)) {
    findings.push({
      path: sourcePath(path),
      line: 1,
      code: "native_pathfinder_missing_plan_or_refusal_evidence",
    });
  }
  return findings;
}

export function checkStardewNativePathfinderSource({ roots = DEFAULT_ROOTS, sourceOverrides = {} } = {}) {
  const findings = [];
  const paths = new Set();
  for (const root of roots) {
    const resolved = resolve(REPOSITORY_ROOT, root);
    for (const path of collectFiles(resolved)) paths.add(path);
  }
  for (const [relativePath, source] of Object.entries(sourceOverrides)) {
    paths.add(resolve(REPOSITORY_ROOT, relativePath));
    sourceOverrides[relativePath] = source;
  }
  for (const path of [...paths].sort()) {
    const relativePath = relative(REPOSITORY_ROOT, path).replaceAll("\\", "/");
    const source = Object.hasOwn(sourceOverrides, relativePath)
      ? sourceOverrides[relativePath]
      : readFileSync(path, "utf8");
    findings.push(...inspectSource(path, source));
  }
  return Object.freeze({
    gate: "stardew-native-pathfinder-source/v1",
    findings: Object.freeze(findings),
    ok: findings.length === 0,
  });
}

function main() {
  const report = checkStardewNativePathfinderSource();
  for (const finding of report.findings) {
    process.stdout.write(`  ${finding.path}:${finding.line} ${finding.code}${finding.detail ? ` (${finding.detail})` : ""}\n`);
  }
  process.stdout.write(`stardew native pathfinder source gate: ${report.findings.length} finding(s)\n`);
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
