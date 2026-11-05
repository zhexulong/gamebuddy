#!/usr/bin/env node
/**
 * Gate for "an exception's own text was published as a reason code".
 *
 * THE BUG CLASS IT EXISTS TO CATCH
 *
 * A reason code is a closed vocabulary: every consumer that switches on `reasonCode` - the multiday baseline's night
 * cause, the transport-loss verdict, the bundle's verdict rubric - matches tokens. An error message in that slot is not
 * a code: it is developer prose (`ReferenceError: path is not defined`), it differs on every occurrence, and it silently
 * routes every consumer into its default arm.
 *
 * Measured 2026-11-05 (`2026-11-05T11-37-35-764Z-multiday_routine`): a real run finished its whole day, wrote 189
 * receipts and a spoken summary, and then the result read
 *
 *   state: blocked, error: "path is not defined", failure: { reasonCode: "path is not defined", ... }
 *
 * - an exception message in the code slot, with no class, no stack and no site. The message must travel, but in a field
 * of its own (`errorMessage`, published beside `errorClass`/`errorStack`/`errorFrame` by `classifyFailure` in
 * `tools/lib/failure-dump.mjs`). What it may never be is the code.
 *
 * POPULATION
 *
 * Every `.mjs`/`.js` file under the scanned scope (default `tools/live-run`, the surface that publishes live-run
 * artifacts), parsed as syntax: the population is the FILESYSTEM, not a list, so a new runner joins it by existing.
 *
 * THE RULE, AND WHY IT IS NOT A LIST OF KNOWN-BAD SPELLINGS
 *
 * A `reasonCode` value may not read the caught error. Concretely, the value's own source text may not contain
 *
 *   - `.message` or `.stack` - the text of a throw, inlined into a code; or
 *   - a bare `error` / `err` / `exception` / `cause` - the catch binding itself, handed to a code slot, or passed to a
 *     helper that decides codes by reading it.
 *
 * Both shapes are refused wherever they appear in the expression, so `String(error.message)`, `` `${code}:${error}` ``,
 * `error?.message ?? "..."` and `safeCode(error)` are one finding, not four patterns to keep in step.
 *
 * The sanctioned shape is a value that reads a CLASSIFIED record - `classifyFailure(err)` returns
 * `{ reasonCode, errorClass, errorMessage, errorStack, errorFrame }`, and `thrown.reasonCode` contains no carrier - or a
 * literal, or a code a caller decided on. That is what "values read from a closed map" means here, and it is enforced by
 * the expression rather than by an allowlist of helpers: a helper that reads the error is exactly what this refuses.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 *   - It does not judge whether a literal is a *good* code: `"it broke"` is a literal and a worse code than
 *     `runner_internal_error`, but "this string is prose" is not decidable and a gate that guessed would be noise.
 *   - It does not follow the value into another function. `const code = error.message; ... reasonCode: code` is not
 *     reported, because the read and the assignment are two statements and this gate reads one expression. The class
 *     stays reachable that way - `tools/check-scope-references.mjs` and review are the layers for a value that travels.
 *   - It reads `{ reasonCode: <value> }` and `x.reasonCode = <value>` only. A SPREAD (`{ ...thrown }`) publishes a code
 *     without naming the key, and spreading a classifier's own record is the sanctioned shape, so both sides of that
 *     boundary are stated rather than inferred.
 *   - It parses `.mjs`/`.js` only. `.ts`/`.tsx` are not in this population: the surface this gate protects is the
 *     JavaScript harness.
 *
 * Usage:
 *   node tools/check-failure-reason-codes.mjs                 # tools/live-run (default scope)
 *   node tools/check-failure-reason-codes.mjs <dir> [<dir>]   # another scope, e.g. a pre-fix tree
 *   node tools/check-failure-reason-codes.mjs --json
 *
 * Exit code is 1 when any finding is reported, 0 otherwise.
 *
 * red-proof: the PRE-FIX tree, not a synthetic one - `git show <commit>:<runner>` into a scratch scope and this gate
 * names `run-stardew-native-local-agent-ab-live.mjs:2829`, `:2886` and `:4826` (`String(error?.message ?? error)` inside
 * a `reasonCode` template). See `tools/check-failure-reason-codes.test.mjs`.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseJavaScript } from "./lib/javascript-ast.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SCOPE = "tools/live-run";
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);
const SCANNED_EXTENSIONS = new Set([".js", ".mjs"]);

/** Rule ids a finding can carry. `source_unparsed` is not a skipped file: an unread file cannot be vouched for. */
export const REASON_CODE_RULES = Object.freeze(["error_text_as_reason_code", "source_unparsed"]);

/**
 * What a reason-code expression may not contain: the text of a throw, or the caught value itself.
 *
 * `thrown` is deliberately absent: that is the name of a CLASSIFIED record (`classifyFailure`'s result), whose
 * `reasonCode` is a token. The names here are the ones a `catch` binding is given in this tree.
 */
const ERROR_CARRIER = /\.message\b|\.stack\b|\b(?:error|err|exception|cause)\b/u;

const REASON_CODE_KEY = "reasonCode";

function parseArguments(argv) {
  const options = { paths: [], json: false };
  for (const argument of argv) {
    if (argument === "--json") options.json = true;
    else if (argument.startsWith("--")) throw new Error(`unknown option ${argument}`);
    else options.paths.push(argument);
  }
  if (options.paths.length === 0) options.paths.push(DEFAULT_SCOPE);
  return options;
}

async function collectFiles(target, out) {
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOTDIR") {
      if (SCANNED_EXTENSIONS.has(path.extname(target).toLowerCase())) out.add(path.resolve(target));
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await collectFiles(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SCANNED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.add(path.resolve(full));
  }
}

function relativeToRepository(absolutePath) {
  const relative = path.relative(REPOSITORY_ROOT, absolutePath);
  return relative.startsWith("..") ? absolutePath : relative.split(path.sep).join("/");
}

/** The key of a `pair`, without its quotes; `null` for a computed key this gate cannot read. */
function keyText(key) {
  if (key.type === "property_identifier") return key.text;
  if (key.type === "string") return key.text.slice(1, -1);
  return null;
}

/** Every reason-code expression in one source, as `{ node, text }`. */
function reasonCodeValues(root) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.type === "pair") {
      const key = node.childForFieldName("key");
      if (key !== null && keyText(key) === REASON_CODE_KEY) {
        const value = node.childForFieldName("value");
        if (value !== null) found.push({ node: value, text: value.text });
      }
    } else if (node.type === "assignment_expression") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (
        left !== null &&
        right !== null &&
        left.type === "member_expression" &&
        left.text.endsWith(`.${REASON_CODE_KEY}`)
      ) {
        found.push({ node: right, text: right.text });
      }
    }
    for (const child of node.namedChildren) stack.push(child);
  }
  return found;
}

/** The first recovery node in a tree that did not parse cleanly, in source order. */
function firstErrorNode(root) {
  let earliest = null;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.type === "ERROR" || node.isMissing) {
      if (earliest === null || node.startIndex < earliest.startIndex) earliest = node;
    }
    for (const child of node.children) stack.push(child);
  }
  return earliest;
}

function finding(rule, fileName, at, message) {
  return Object.freeze({ rule, fileName, line: at.row + 1, column: at.column + 1, message });
}

/** One file's findings, from its own bytes: a pure function of the source. */
export async function auditSource(source, fileName) {
  const root = (await parseJavaScript(source, fileName)).rootNode;
  if (root.hasError) {
    const errorNode = firstErrorNode(root);
    const at = errorNode?.startPosition ?? { row: 0, column: 0 };
    return Object.freeze({
      fileName,
      parsed: false,
      reasonCodeSites: 0,
      findings: Object.freeze([
        finding(
          "source_unparsed",
          fileName,
          at,
          `source does not parse at ${at.row + 1}:${at.column + 1}, so its reason codes were not read`,
        ),
      ]),
    });
  }
  const findings = [];
  const values = reasonCodeValues(root);
  for (const value of values) {
    if (!ERROR_CARRIER.test(value.text)) continue;
    findings.push(
      finding(
        "error_text_as_reason_code",
        fileName,
        value.node.startPosition,
        `reasonCode carries the thrown error's own text or the caught value (\`${value.text.replace(/\s+/gu, " ").slice(0, 120)}\`); classify the throw ONCE (\`classifyFailure\`) and publish \`thrown.reasonCode\`, keeping the message in errorMessage/errorClass/errorStack`,
      ),
    );
  }
  return Object.freeze({ fileName, parsed: true, reasonCodeSites: values.length, findings: Object.freeze(findings) });
}

export async function auditFile(filePath, { fileName = relativeToRepository(filePath) } = {}) {
  return await auditSource(await readFile(filePath, "utf8"), fileName);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const files = new Set();
  for (const target of options.paths) await collectFiles(path.resolve(REPOSITORY_ROOT, target), files);

  const ordered = [...files].sort();
  const findings = [];
  let reasonCodeSites = 0;
  const unparsed = [];
  for (const file of ordered) {
    const result = await auditFile(file);
    if (!result.parsed) unparsed.push(result.fileName);
    reasonCodeSites += result.reasonCodeSites;
    for (const item of result.findings) findings.push(item);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ filesScanned: ordered.length, reasonCodeSites, findings }, null, 2)}\n`);
  } else {
    for (const item of findings)
      process.stdout.write(`${item.fileName}:${item.line}:${item.column}  ${item.rule}  ${item.message}\n`);
    process.stdout.write(
      `failure reason codes: ${ordered.length} files, ${reasonCodeSites} reasonCode sites, ` +
        `${findings.length} findings, ${unparsed.length} unparsed\n`,
    );
  }
  process.exitCode = findings.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
