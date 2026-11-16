#!/usr/bin/env node
/**
 * Guard: a reader obtains a value by parsing another language's SOURCE, instead of from a published artifact or a
 * declared constant.
 *
 * WHY (measured 2026-11-16). 98 places in this tree read another language's source text to obtain a value, and most of
 * them are legitimate: a fixture read, a data artifact, a derive script that must read source. The narrow case that can
 * lie is a reader that EXTRACTS a value out of a source file it cannot type-check:
 *
 *   string source = File.ReadAllText(Path.Combine(RepositoryRoot(), "host", "src", "fact-brief.ts"));
 *   Match share = Regex.Match(source, @"evidence:\s*(?<chars>[0-9]+)");
 *
 * That is `e34023f2`'s defect, replayed: `MODEL_FIELD_CEILINGS.evidence` became `EVIDENCE_CEILING_CHARS`
 * (`67ce595a`), the expression found no digits, `ModelShare` threw, and three tests that existed to measure the budget
 * measured nothing. The test asserted that a line of text contains digits, not that a value is what it should be - and
 * when the implementation's shape moved, the reading went SILENT rather than stale. The fix (`e34023f2`,
 * `1b7d933d`) is the shape this gate requires: `host/src/model-field-budget.published.json` is data, and
 * `model-field-budget.published.test.ts` holds that artifact to `MODEL_FIELD_CEILINGS` - a drift is
 * `published_ceiling_drift:<field>`, not a zero.
 *
 * THE CLASS, mechanically (all three clauses, and each is printed with its count so a reader can check what was
 * excluded):
 *
 *   1. CROSS-LANGUAGE. The reader's own language (from its extension) is not the language of the file it reads.
 *      A C# test reading C# source, or a `.test.mjs` reading `.mjs`, is outside the class by construction - it can
 *      type-check, import, or at least share a shape with what it reads.
 *   2. SOURCE. The target ends in a source extension (`.ts .tsx .mts .cts .js .mjs .cjs .jsx .cs .py .ps1`). A JSON
 *      record, a Markdown table, a fixture, a build artifact - anything a program publishes FOR readers - is not this
 *      class, and the `published.json` half of today's fix is exactly that distinction.
 *   3. A VALUE. The read's text is reduced to a value by a REGEX WITH A CAPTURE GROUP whose groups are read out
 *      (`match(...)[1]`, `.groups.<name>`, `Groups["body"]`, `int.Parse(share.Groups["chars"].Value)`), including one
 *      hop through a value derived from such a match. A pattern asserted to EXIST (`assert.match`, `Regex.IsMatch`,
 *      `.includes`) is a different, legitimate job and is counted `shape`; text used whole is counted `content`.
 *
 * A call spelled inside a STRING, a COMMENT or a REGEX literal is not a read: `scanText` masks all three before anything
 * is counted. Both halves are load-bearing, and both were found by running this gate over its own falsifier - a fixture
 * carrying `readFileSync("...")` inside a template literal was counted as a reader of a file that does not exist, and a
 * regex literal's first quote opened a bogus string that swallowed the rest of `tools/check-surface-journeys.mjs` and
 * lost its two real sites. So the scanner knows line comments, block comments, `#` comments for Python/PowerShell, and a
 * `/` that can only open a regex where an operand may start.
 *
 * Documented boundaries, so the absent count is a statement and not an assumption:
 *
 *   - a value sliced out of a bare `.split('=')[1]` / `.IndexOf` / `.Substring` is NOT this class. It has no declared
 *     anchor, so the gate cannot tell which token was meant, and enumerating it is a separate unit rather than a
 *     silent widening of this rule.
 *   - a read whose path is an UNRESOLVED expression (a parameter, a directory scan, a `Directory.GetFiles` loop) is
 *     counted `unresolved` and not judged: this gate reads the path a call names, not the paths a loop visits. It is by
 *     far the largest bucket, and it is printed every run rather than assumed away.
 *   - ONE hop through a path variable is resolved (`HandlerFile = "..."`, `path = Path.Combine(Root(), "host", "x.ts")`)
 *     and no more, and only when that name is assigned EXACTLY ONCE in the file: `path` assigned in five methods is five
 *     values, and resolving every read of it to the first would name a file the reader never opened.
 *   - the value is looked for in a 2,500-character window either side of the read, clipped to the read's own block. A
 *     body scan per site is what made this gate take 79 seconds on a tree with a 428 KB module in it; a value taken out
 *     further from the read than the window reaches is a documented false negative.
 *
 * THE PROPERTY: no reader obtains a value by parsing another language's source. Every VALUE site is a finding -
 * `value_read_from_another_languages_source:<file>:<value>` - unless it is recorded in
 * `tools/baselines/value-read-from-source.json` with what the fix would be. The baseline is recorded debt, not a mute
 * button: an entry whose site is gone (fixed, or its pattern changed) is
 * `value_read_baseline_stale:<file>:<value>` and must be deleted, so the list only shrinks, and a NEW site is red until
 * someone fixes it or writes the reason it is still owed. Measured on this tree:
 *
 *   `readers 3213 · read calls 13065 · cross-language source sites 411 in 171 files`
 *   `clauses: foreign source 411 · value 25 · shape 60 · content 326 · recorded 25 · finding 0`
 *   `excluded: same-language 799 · non-source target 1016 · unresolved 10839`
 *
 * ZERO IS BLOCKED, three ways: no reader, no read call, and no cross-language source site at all. The third is the
 * population the verdict rests on, so a tree that reads only artifacts is a blocked reading and never a clean one.
 *
 * WHAT THIS IS NOT: a claim that reading another language's source is wrong. Four fifths of this tree's
 * cross-language readers are shape assertions or whole-content uses, and they are counted rather than judged.
 *
 * Usage:
 *   node tools/check-cross-language-value-reads.mjs                  # the reading; exit 1 on a finding, 2 when blocked
 *   node tools/check-cross-language-value-reads.mjs --json           # the whole report
 *   node tools/check-cross-language-value-reads.mjs --root <dir>     # read another tree (a falsifier's fixture)
 *
 * red-proof: history  the commit before `e34023f2` reads `host/src/fact-brief.ts` in
 *   `SweepTargetRefusalNamingTests.cs` for `evidence:\s*(?<chars>[0-9]+)` and the gate names it
 *   `value_read_from_another_languages_source:…SweepTargetRefusalNamingTests.cs:evidence`; the same file at HEAD reads
 *   `host/src/model-field-budget.published.json` and leaves the population (tools/check-cross-language-value-reads.test.mjs)
 * red-proof: inject  a baselined site whose pattern changed -> `value_read_baseline_stale`, naming the entry, while the
 *   unrecorded site of the same value stays a `value_read_from_another_languages_source` finding
 *   (tools/check-cross-language-value-reads.test.mjs)
 *
 * No game, no network, no model. It reads files and parses their text.
 */
export const gateDeclaration = {
  id: "check-cross-language-value-reads",
  domain: "data",
  tier: "l2",
  kind: "contract",
};

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE_PATH = "tools/baselines/value-read-from-source.json";

/** The languages this gate knows, by extension. A file outside this map is not a reader and not a source target. */
export const LANGUAGES = Object.freeze({
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".cs": "csharp",
  ".py": "python",
  ".ps1": "powershell",
});
const SOURCE_EXTENSIONS = Object.keys(LANGUAGES);
/** A literal that names a source file: clause 2, applied to the string rather than to the file. */
const SOURCE_LITERAL = new RegExp(`(?:${SOURCE_EXTENSIONS.map((ext) => ext.replace(".", "\\.")).join("|")})$`, "u");
/** A literal that names a file at all, so a target that is a `.json` artifact is counted rather than called unresolved. */
const FILE_LITERAL = /\.[A-Za-z0-9]{1,5}$/u;
/** The cheap prefilter: a file with no source extension in its text cannot name one. */
/**
 * A call that obtains a file's TEXT. The name rule is the vocabulary this tree uses for it - `readFileSync`,
 * `ReadAllText`, `readRepository`, `ReadRepositoryFile`, `read`, `Read` - so a new helper joins by being named like one.
 */
const READ_CALLEE = /(?:^|\.)[\w$]*(?:read|Read|load|Load)[\w$]*$/u;
const CALL = /([A-Za-z_$][\w$.:]*)\s*\(/gu;
/** A variable that holds a path: a literal, or an assembly (`Path.Combine(Root(), "host", "src", "x.json")`). */
const PATH_ASSIGNMENT =
  /(?:const|let|var|final|static\s+readonly\s+string|const\s+string|string|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]{0,300});/gu;
/** A regex whose body has a CAPTURE group: a numbered `(` or a named `(?<name>`. Lookarounds and `(?:` are not. */
const HAS_CAPTURE = /\((?!\?)|\(\?<[A-Za-z_]/u;
/** A capture group read out of a match: `[1]`, `.groups.x`, `Groups["body"]`, `Groups[2]`. */
const GROUP_READ = /(?:\.Groups\s*\[|\?\.\s*groups\b|\.groups\b|\.Groups\.Values|\[\s*[1-9]\s*\])/u;
const JS_REGEX_APPLICATION =
  /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:\?\.)?\.\s*(match|matchAll|exec)\s*\(\s*\/((?:\\.|[^/\n])*)\//gu;
const CS_REGEX_APPLICATION =
  /Regex\s*\.\s*(?:Match|Matches|MatchCount)\s*\(\s*([^,;]+?)\s*,\s*(?:@"((?:[^"]|"")*)"|"((?:[^"\\]|\\.)*)")/gu;
/** How far either side of a read the value it is reduced to is looked for, and how far back its own block may open. */
const WINDOW = 2_500;
const ENCLOSING_LIMIT = 20_000;
const DERIVED_BINDING = /(?:Match|var|string|const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]{0,400}?);/gu;
const ASSIGNED_TO = /([A-Za-z_$][\w$]*)\s*=\s*[^=]*$/u;

const extOf = (path) => /\.[A-Za-z0-9]+$/u.exec(path)?.[0].toLowerCase() ?? "";
const normalize = (path) => String(path).replace(/\\/gu, "/");
const languageOf = (path) => LANGUAGES[extOf(path)] ?? null;

/** The files of a tree: the index when it is a repository, a walk when it is a fixture. */
export function treeFiles({ root }) {
  if (existsSync(join(root, ".git"))) {
    return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
      .split("\0")
      .filter(Boolean)
      .map(normalize);
  }
  const files = [];
  const walk = (prefix) => {
    for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk("");
  return files.sort();
}

/** Every string literal of a text with its offsets: one pass, `\` escapes, a template keeps its `${...}`. */
/**
 * One pass over a source text: the string literals it holds, and a mask of every offset that is NOT code.
 *
 * The mask covers literal BODIES and COMMENTS, and both halves are load-bearing. A literal body is where a fixture, a
 * docblock or a falsifier QUOTES a read - `tools/check-cross-language-value-reads.test.mjs` carries
 * `readFileSync("...")` inside template strings, and reading that as a reader made this gate flag its own test file.
 * Comments matter for the same reason and one worse one: an apostrophe in `// the run's own` used to open a bogus
 * single-quote literal that swallowed the next real string, so the template literals after it went unmasked. So the
 * scanner knows line comments, block comments and, for Python and PowerShell, `#`.
 *
 * It is also the reason this gate runs in seconds: asking "is this offset inside one of N literals" per character is
 * O(text x literals), which took 74 seconds before the mask existed.
 */
const REGEX_PRECEDERS = new Set([
  "=",
  "(",
  ",",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "~",
  "^",
  "<",
  ">",
]);

/** The last character before `offset` that is not a space or a tab: what decides whether a `/` opens a regex. */
function previousMeaningful(text, offset) {
  let back = offset - 1;
  while (back >= 0 && (text[back] === " " || text[back] === "\t")) back -= 1;
  return back < 0 ? "\n" : text[back];
}

/** The end of a comment starting at `offset`, or null when there is none there. Line comments stop at the newline. */
function commentEndAt(text, offset, hashComments) {
  const char = text[offset];
  const next = text[offset + 1];
  const lineEnd = () => {
    const at = text.indexOf("\n", offset);
    return at === -1 ? text.length : at;
  };
  if (char === "/" && next === "/") return lineEnd();
  if (char === "/" && next === "*") {
    const at = text.indexOf("*/", offset + 2);
    return at === -1 ? text.length : at + 2;
  }
  if (hashComments && char === "#") return lineEnd();
  return null;
}

/** The end of a regex literal starting at `offset`, or null when the `/` there cannot open one. */
function regexEndAt(text, offset) {
  if (text[offset] !== "/") return null;
  if (!REGEX_PRECEDERS.has(previousMeaningful(text, offset))) return null;
  let end = offset + 1;
  let inClass = false;
  while (end < text.length) {
    const at = text[end];
    if (at === "\\") {
      end += 2;
      continue;
    }
    if (at === "\n") break;
    if (at === "[") inClass = true;
    else if (at === "]") inClass = false;
    else if (at === "/" && !inClass) break;
    end += 1;
  }
  const closed = end < text.length && text[end] === "/";
  return closed ? end + 1 : end;
}

/** The end of the string literal starting at `offset`, and whether it closed. A template literal may span lines. */
function literalEndAt(text, offset) {
  const quote = text[offset];
  let end = offset + 1;
  while (end < text.length) {
    if (text[end] === "\\") {
      end += 2;
      continue;
    }
    if (text[end] === quote) return { end, closed: true };
    if (quote !== "`" && text[end] === "\n") break;
    end += 1;
  }
  return { end, closed: false };
}

export function scanText(text, language) {
  const literals = [];
  const skip = new Uint8Array(text.length);
  const hashComments = language === "python" || language === "powershell";
  let index = 0;
  while (index < text.length) {
    const commentEnd = commentEndAt(text, index, hashComments);
    if (commentEnd !== null) {
      skip.fill(1, index, commentEnd);
      index = commentEnd;
      continue;
    }
    const regexEnd = regexEndAt(text, index);
    if (regexEnd !== null) {
      skip.fill(1, index, regexEnd);
      index = regexEnd;
      continue;
    }
    if (text[index] === '"' || text[index] === "'" || text[index] === "`") {
      const { end, closed } = literalEndAt(text, index);
      const stop = closed ? end + 1 : end;
      skip.fill(1, index, stop);
      if (closed) literals.push({ start: index, end, body: text.slice(index + 1, end) });
      index = stop;
      continue;
    }
    index += 1;
  }
  return { literals, skip };
}

/** The argument text of the call whose `(` is at `open`. */
function argsOf(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return text.slice(open + 1, open + 400);
}

/** The literals of one expression, joined up to and including the first that names a file. */
function pathFrom(expression) {
  const parts = [];
  for (const literal of scanText(String(expression), "javascript").literals) {
    const part = literal.body.replace(/\$\{[^}]*\}/gu, "");
    parts.push(part);
    if (FILE_LITERAL.test(part.trim())) break;
  }
  const joined = parts
    .join("/")
    .replace(/\/{2,}/gu, "/")
    .trim();
  return FILE_LITERAL.test(joined) ? joined : null;
}

/**
 * The path variables a file declares, so one hop through `HandlerFile` / `HostPacking` / `path = Path.Combine(...)`
 * resolves.
 *
 * Two rules keep this a reading rather than a guess. One hop and no more: a variable assigned from another variable is
 * not followed, and the site is counted `unresolved`. And a name must be assigned EXACTLY ONCE in the file: `path` or
 * `file` assigned in five methods is five different values, and resolving every read of that name to whichever
 * assignment came first would name a target the reader never opened.
 */
function pathVariables(text, skip) {
  const seen = new Map();
  for (const match of text.matchAll(PATH_ASSIGNMENT)) {
    if (skip[match.index] === 1) continue;
    const [name] = [match[1]];
    const path = pathFrom(match[2]);
    const record = seen.get(name) ?? { count: 0, path: null };
    seen.set(name, { count: record.count + 1, path: record.count === 0 ? path : null });
  }
  const variables = new Map();
  for (const [name, record] of seen) if (record.count === 1 && record.path !== null) variables.set(name, record.path);
  return variables;
}

/** The path a read call names: literals joined up to its first file name, then one hop through a path variable. */
export function resolveTarget(args, variables) {
  const direct = pathFrom(args);
  if (direct !== null) return direct;
  for (const identifier of args.matchAll(/[A-Za-z_$][\w$]*/gu)) {
    const variable = variables.get(identifier[0]);
    if (variable !== undefined) return variable;
  }
  return null;
}

/** The variable a read's text is bound to, from the statement the call sits in. */
function bindingBefore(text, callStart) {
  const lineStart = text.lastIndexOf("\n", callStart - 1) + 1;
  const before = text.slice(Math.max(lineStart - 400, 0), callStart);
  const match = ASSIGNED_TO.exec(before);
  const candidate = match?.[1] ?? null;
  return candidate === null || /^(?:return|new|await|else|in|of)$/u.test(candidate) ? null : candidate;
}

/**
 * The offset of the `{` that opens the block a read sits in, or -1 when the file opens it no closer than
 * `ENCLOSING_LIMIT` characters back.
 *
 * The block is never read to its end: the analysis below reads a WINDOW around the read, because a body scan per site
 * is what made this gate take 79 seconds on a tree with a 428 KB module in it. The limit is stated rather than silent -
 * a read whose block opened further back is analysed in the same window as a module-scope one.
 */
function enclosingBraceStart(text, offset, skip) {
  let depth = 0;
  const floor = Math.max(0, offset - ENCLOSING_LIMIT);
  for (let index = offset; index >= floor; index -= 1) {
    if (skip[index] === 1) continue;
    if (text[index] === "}") depth += 1;
    else if (text[index] === "{") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

/** The text a site is judged by: the window around the read, clipped to its own block. */
function windowOf(text, callStart, blockStart) {
  const from = Math.max(blockStart + 1, callStart - WINDOW);
  const to = Math.min(text.length, callStart + 2 * WINDOW);
  return { from, text: text.slice(from, to) };
}

/**
 * The names one body derives from a regex match, read once per body: `name -> the identifiers its expression names`.
 *
 * The edge list is what makes the taint reachable without rescanning the body per site: `Match declaration =
 * Regex.Match(source, ...)` derives `declaration` from `source`, and that is how a second regex over
 * `declaration.Groups["body"].Value` still counts as reading the file.
 */
function derivedEdges(body) {
  const edges = [];
  for (const match of body.matchAll(DERIVED_BINDING)) {
    const [, name, expression] = match;
    if (!/\.\s*(?:match|matchAll|exec)\s*\(|Regex\s*\.\s*(?:Match|Matches|MatchCount)\s*\(/u.test(expression)) continue;
    edges.push({
      name,
      references: new Set([...expression.matchAll(/[A-Za-z_$][\w$]*/gu)].map((identifier) => identifier[0])),
    });
  }
  return edges;
}

/** The names carrying the read's text inside one body: the bound name, plus the edges it reaches (four rounds). */
function taintedNames(edges, seed) {
  const names = new Set(typeof seed === "string" ? [seed] : []);
  for (let round = 0; round < 4; round += 1) {
    let grew = false;
    for (const edge of edges) {
      if (names.has(edge.name)) continue;
      if ([...names].some((known) => edge.references.has(known))) {
        names.add(edge.name);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return names;
}

/** The regex applications of one body: receiver and pattern, for the JS and the C# spelling. */
function regexApplications(body) {
  const applications = [];
  for (const match of body.matchAll(JS_REGEX_APPLICATION))
    applications.push({ end: match.index + match[0].length, receiver: match[1], pattern: match[3] });
  for (const match of body.matchAll(CS_REGEX_APPLICATION)) {
    // A C# non-verbatim string spells a backslash twice; the regex the program sees has one.
    const pattern = (match[2] ?? (match[3] ?? "").replace(/\\\\/gu, "\\")).replace(/""/gu, '"');
    applications.push({ end: match.index + match[0].length, receiver: match[1], pattern });
  }
  return applications.sort((left, right) => left.end - right.end);
}

/**
 * The value a body lifts out of a name, as `{ value, pattern }`, or null.
 *
 * A pattern with a capture group is one half; the other is a group READ, within 300 characters of the application
 * (the next line, in the shape `Match share = Regex.Match(...)` / `share.Groups["chars"].Value`). Both halves are
 * required, so `assert.match(source, /pattern/)` stays `shape`.
 *
 * A body with several lifts reports the LAST - the one furthest down the chain. `SweepTargetRefusalNamingTests.cs`
 * before `e34023f2` matched the ceilings block with `(?<body>...)` and then took `evidence` out of that group, and it
 * is `evidence` that the finding must name: the outer match is how the value was reached, not the value.
 */
export function valueLift(body, applications, names) {
  let lifted = null;
  for (const application of applications) {
    if (!HAS_CAPTURE.test(application.pattern)) continue;
    const root = /[A-Za-z_$][\w$]*/u.exec(application.receiver)?.[0] ?? "";
    if (!names.has(root)) continue;
    if (!GROUP_READ.test(body.slice(application.end, application.end + 300))) continue;
    lifted = { value: labelOf(application.pattern), pattern: application.pattern };
  }
  return lifted;
}

/**
 * The word a pattern names its value by, in order of how much it says: the key before the first capture group
 * (`evidence:`), the group's own name (`(?<chars>`), an identifier inside the group (`(\w+_PANEL)`), the last word
 * before it, and finally the pattern itself - shortened to a handle, because the detail line prints it whole.
 */
export function labelOf(pattern) {
  const stripped = pattern.replace(/\\[\s\S]/gu, " ").replace(/\[[^\]]*\]/gu, " ");
  const firstGroup = /\((?!\?)[^)]*|\(\?<[A-Za-z_]/u.exec(stripped);
  const prefix = firstGroup === null ? stripped : stripped.slice(0, firstGroup.index);
  const key = [...prefix.matchAll(/([A-Za-z_][\w]*)\s*[:=]/gu)].at(-1)?.[1];
  if (key !== undefined) return key;
  const groupName = /\(\?<([A-Za-z_][\w]*)>/u.exec(stripped)?.[1];
  if (groupName !== undefined) return groupName;
  const insideGroup = [...(firstGroup?.[0] ?? "").matchAll(/[A-Za-z_][\w]*/gu)].at(-1)?.[0];
  if (insideGroup !== undefined) return insideGroup;
  return firstGroup === null
    ? "whole"
    : `group_${(stripped.slice(0, firstGroup.index).match(/\(/gu) ?? []).length + 1}`;
}

/** A pattern or substring asserted to EXIST over a name: the legitimate neighbour of the class. */
function shapeProbe(body, names) {
  for (const name of names) {
    const escaped = name.replace(/\$/gu, "\\$");
    if (new RegExp(`\\b${escaped}\\b\\s*(?:\\?\\.)?\\.\\s*(?:match|matchAll|test)\\s*\\(`, "u").test(body))
      return { name, how: "pattern" };
    if (
      new RegExp(`\\b${escaped}\\b\\s*(?:\\?\\.)?\\.\\s*(?:includes|startsWith|indexOf)\\s*\\(`, "u").test(body) ||
      new RegExp(`${escaped}\\s*\\.\\s*(?:Contains|IndexOf|StartsWith|EndsWith)\\s*\\(`, "u").test(body) ||
      new RegExp(`Regex\\s*\\.\\s*IsMatch\\s*\\(\\s*${escaped}\\b`, "u").test(body)
    )
      return { name, how: "substring" };
  }
  return null;
}

/** What kind of file does the reading: the census's own split, so `test` can be told from `gate`/`derive`/`lib`. */
export function kindOf(file) {
  if (/(?:\.test\.[cm]?[jt]sx?|Tests?\.cs)$/u.test(file)) return "test";
  if (/(?:^|\/)(?:check|audit)-[^/]*$/u.test(file) || /^tools\//u.test(file))
    return /(?:^|\/)check-|audit-/u.test(file) ? "gate" : "derive";
  return "lib";
}

/** Every read site of one tree: the three clauses decided per site, plus the counts that explain the exclusions. */
export function readSites({ root }) {
  const counts = {
    readers: 0,
    readCalls: 0,
    foreignSource: 0,
    sameLanguage: 0,
    nonSourceTarget: 0,
    unresolved: 0,
  };
  const sites = [];
  for (const file of treeFiles({ root })) {
    const readerLanguage = languageOf(file);
    if (readerLanguage === null) continue;
    const text = readFileSync(join(root, file), "utf8");
    counts.readers += 1;
    const { skip } = scanText(text, readerLanguage);
    const constants = pathVariables(text, skip);
    const analysisCache = new Map();
    const newlines = [...text.matchAll(/\n/gu)].map((newline) => newline.index);
    const lineOf = (offset) => {
      let low = 0;
      let high = newlines.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (newlines[middle] < offset) low = middle + 1;
        else high = middle;
      }
      return low + 1;
    };
    for (const match of text.matchAll(CALL)) {
      if (!READ_CALLEE.test(match[1].trim())) continue;
      // A call spelled inside a string or a comment is not a call: a fixture, a docblock or this gate's own falsifier
      // quotes code, and reading that as a reader made the gate flag its own test file for the fixtures it carries.
      if (skip[match.index] === 1) continue;
      counts.readCalls += 1;
      const args = argsOf(text, match.index + match[0].length - 1);
      const target = resolveTarget(args, constants);
      if (target === null) {
        counts.unresolved += 1;
        continue;
      }
      if (!SOURCE_LITERAL.test(target)) {
        counts.nonSourceTarget += 1;
        continue;
      }
      const targetLanguage = languageOf(target);
      if (targetLanguage === null || targetLanguage === readerLanguage) {
        counts.sameLanguage += 1;
        continue;
      }
      counts.foreignSource += 1;
      const { lifted, shaped } = classifySite(text, match.index, skip, analysisCache);
      sites.push({
        file,
        line: lineOf(match.index),
        callee: match[1].trim(),
        target,
        readerLanguage,
        targetLanguage,
        kind: kindOf(file),
        value: lifted === null ? null : lifted.value,
        pattern: lifted === null ? null : lifted.pattern,
        shape: shaped === null ? null : shaped.how,
        siteClass: classOf(lifted, shaped),
      });
    }
  }
  return { counts, sites };
}

/** Which of the three classes a site falls in. Written out rather than nested, because the partition is the point. */
function classOf(lifted, shaped) {
  if (lifted !== null) return "value";
  if (shaped !== null) return "shape";
  return "content";
}

/** What one foreign-source read does with the text: a value lifted out of it, a pattern asserted over it, or neither. */
function classifySite(text, callStart, skip, analysisCache) {
  const scope = windowOf(text, callStart, enclosingBraceStart(text, callStart, skip));
  let analysis = analysisCache.get(scope.from);
  if (analysis === undefined) {
    analysis = { applications: regexApplications(scope.text), edges: derivedEdges(scope.text) };
    analysisCache.set(scope.from, analysis);
  }
  const names = taintedNames(analysis.edges, bindingBefore(text, callStart));
  const lifted = valueLift(scope.text, analysis.applications, names);
  return { lifted, shaped: lifted === null ? shapeProbe(scope.text, names) : null };
}

/** The baseline the recorded debt is read from: `{ sites: [{ file, target, value, pattern, owed }] }`. */
export function readBaseline({ root }) {
  const path = join(root, BASELINE_PATH);
  if (!existsSync(path)) return { sites: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed.sites))
    throw new Error(`${BASELINE_PATH} must carry a "sites" array; it carries ${typeof parsed.sites}`);
  return parsed;
}

const identityOf = (site) => `${normalize(site.file)} -> ${normalize(site.target)} ~ /${site.pattern}/`;

/**
 * The reading: every site classified, and the value sites held to the baseline in both directions.
 *
 * `findings` names each unrecorded value site with the code the brief fixes, and each recorded site that no longer
 * exists - so the baseline can only shrink.
 */
export function checkValueReads({ root }) {
  const { counts, sites } = readSites({ root });
  const values = sites.filter((site) => site.siteClass === "value");
  const baseline = readBaseline({ root });
  const recorded = new Map(baseline.sites.map((entry) => [identityOf(entry), entry]));
  const present = new Set(values.map((site) => identityOf(site)));
  const findings = [];
  for (const site of values) {
    if (recorded.has(identityOf(site))) continue;
    findings.push({
      code: "value_read_from_another_languages_source",
      file: site.file,
      value: site.value,
      detail: `${site.file}:${site.line} reads ${site.target} with /${site.pattern}/ and takes \`${site.value}\` out of it`,
    });
  }
  for (const [identity, entry] of recorded) {
    if (present.has(identity)) continue;
    findings.push({
      code: "value_read_baseline_stale",
      file: entry.file,
      value: entry.value,
      detail: `${entry.file}: the baseline records \`${entry.value}\` out of ${entry.target}, and no site matches it now`,
    });
  }
  const byKind = Object.fromEntries(["test", "gate", "derive", "lib"].map((kind) => [kind, 0]));
  for (const site of values) byKind[site.kind] += 1;
  return {
    gate: "cross_language_value_reads/v1",
    counts: {
      ...counts,
      sites: sites.length,
      value: values.length,
      recorded: values.length - findings.filter((f) => f.code === "value_read_from_another_languages_source").length,
      ...byKind,
    },
    sites,
    values,
    baseline: baseline.sites,
    findings,
    status: findings.length === 0 ? "passed" : "failed",
  };
}

/** The census lines: the predicate with a count per clause, so the exclusions can be checked rather than trusted. */
export function describeCensus(report) {
  const { counts } = report;
  const shapes = report.sites.filter((site) => site.siteClass === "shape").length;
  const contents = report.sites.filter((site) => site.siteClass === "content").length;
  return [
    `readers ${counts.readers} · read calls ${counts.readCalls} · cross-language source sites ${counts.foreignSource} in ${new Set(report.sites.map((site) => site.file)).size} file(s)`,
    `clauses: foreign source ${counts.foreignSource} · value ${counts.value} · shape ${shapes} · content ${contents}`,
    `excluded: same-language ${counts.sameLanguage} · non-source target ${counts.nonSourceTarget} · unresolved ${counts.unresolved}`,
    `values by kind: test ${counts.test} · gate ${counts.gate} · derive ${counts.derive} · lib ${counts.lib} · recorded ${counts.recorded} · finding ${report.findings.filter((finding) => finding.code === "value_read_from_another_languages_source").length}`,
  ];
}

/** 2 when nothing was examined, 1 on a finding, 0 otherwise: the three answers a gate may give. */
function exitCodeOf(report, blocked) {
  if (blocked) return 2;
  if (report.findings.length === 0) return 0;
  return 1;
}

function main() {
  const argv = process.argv.slice(2);
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag === -1 ? REPOSITORY_ROOT : resolve(argv[rootFlag + 1]);
  const report = checkValueReads({ root });
  // Three zeros, told apart: no reader, no read call, and no cross-language source site at all. The last one is the
  // population the whole verdict rests on, so a tree that reads only artifacts is a blocked reading, never a clean one.
  const blocked = report.counts.readers === 0 || report.counts.readCalls === 0 || report.counts.foreignSource === 0;
  const exitCode = exitCodeOf(report, blocked);
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return exitCode;
  }
  if (blocked) {
    process.stdout.write(
      `value_reads_blocked: ${root} holds readers ${report.counts.readers} · read calls ${report.counts.readCalls} · cross-language source sites ${report.counts.foreignSource}, so nothing was judged\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ gate: "cross_language_value_reads/v1", status: "blocked", population: 0, detail: "no cross-language source read site to judge" })}\n`,
    );
    return exitCode;
  }
  for (const line of describeCensus(report)) process.stdout.write(`${line}\n`);
  for (const finding of report.findings)
    process.stdout.write(`\u2716 ${finding.code}:${finding.file}:${finding.value} - ${finding.detail}\n`);
  process.stdout.write(
    `${JSON.stringify({
      gate: "cross_language_value_reads/v1",
      status: report.status,
      population: report.counts.foreignSource,
      values: report.counts.value,
      checks: [
        {
          id: "value_read_from_another_languages_source",
          status: report.findings.some((finding) => finding.code === "value_read_from_another_languages_source")
            ? "failed"
            : "passed",
        },
        {
          id: "value_read_baseline_stale",
          status: report.findings.some((finding) => finding.code === "value_read_baseline_stale") ? "failed" : "passed",
        },
      ],
    })}\n`,
  );
  return exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
