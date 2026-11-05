/**
 * The one C# text reader the Stardew analysis tools share.
 *
 * Why it is a module: two tools ask questions of the same Mod source - the discovery-collection gate
 * ("does this `Discover*` read the collection its entities live in?") and the action-inventory
 * reconciliation's observation-gap sections ("does ANY discovery read this collection? which tile
 * channel does the Mod read? what does this handler mutate?"). A second reader would answer the same
 * question twice and the copies would drift, which is the defect class this repository keeps paying
 * for, so the scan lives here and both import it.
 *
 * It is a TEXT reader, not a C# parser: every question below is about which identifier appears in a
 * function BODY, and a body is delimited by brackets that survive comment and string removal. The
 * decompiled engine side is parsed with tree-sitter elsewhere; this side never needed an AST.
 *
 * Comment immunity is the point of `codeOnly`: the furniture defect survived for months because
 * `location.furniture` appeared once in a COMMENT and a grep counted it. A commented-out scan is not
 * a scan.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../../../..", import.meta.url)));
export const MOD_ROOT = "integrations/stardew";
const SOURCE_EXTENSION = ".cs";
/** Not source: the suite tree, the published artifacts of a dotnet build, and the node package. */
const EXCLUDED_DIRECTORIES = Object.freeze(["bin", "obj", "tests", "action-development"]);

/**
 * The source with comments and string/char literals removed, so a collection named in prose or in a
 * message is not counted as a read. Newlines are preserved: positions stay comparable.
 */
export function codeOnly(source) {
  let out = "";
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index++;
      out += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index++;
      index++;
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      index++;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === quote) break;
        index++;
      }
      out += '""';
      continue;
    }
    out += character;
  }
  return out;
}

/**
 * The source with comments removed and string/char literals INTACT.
 *
 * The tile-channel question is the reason this variant exists: the engine's channels are named by
 * string literal (`Properties["Action"]`), so `codeOnly` - which blanks literals - would erase the
 * only evidence. Comments are still stripped, because a commented-out read is not a read.
 */
export function withoutComments(source) {
  let out = "";
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index++;
      out += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index++;
      index++;
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      const start = index;
      index++;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === quote) break;
        index++;
      }
      out += source.slice(start, index + 1);
      continue;
    }
    out += character;
  }
  return out;
}

/** The index of the bracket that closes the one at `open`, or -1. */
const CLOSING_BRACKET = Object.freeze({ "{": "}", "(": ")", "[": "]" });

export function matchingBracket(code, open) {
  const opener = code[open];
  const closer = CLOSING_BRACKET[opener];
  let depth = 0;
  for (let index = open; index < code.length; index++) {
    if (code[index] === opener) depth++;
    else if (code[index] === closer) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * The body that follows the parameter list ending at `close`, or null when this occurrence is a call
 * rather than a declaration. A declaration is followed by `{` or `=>`; a call by an operator, a
 * bracket or a terminator.
 */
export function bodyAfterParameters(code, close) {
  let index = close + 1;
  while (index < code.length && /\s/.test(code[index])) index++;
  if (code.startsWith("=>", index)) {
    let depth = 0;
    for (let cursor = index; cursor < code.length; cursor++) {
      const character = code[cursor];
      if (character === "(" || character === "{" || character === "[") depth++;
      else if (character === ")" || character === "}" || character === "]") depth--;
      else if (character === ";" && depth === 0) return code.slice(index, cursor + 1);
    }
    return null;
  }
  if (code[index] !== "{") return null;
  const end = matchingBracket(code, index);
  return end < 0 ? null : code.slice(index, end + 1);
}

/** Every `Discover*` declaration in `sources`, with the body the reads are collected from. */
export function parseDiscoveries(sources) {
  const discoveries = [];
  for (const { path, source } of sources) {
    const code = codeOnly(source);
    for (const match of code.matchAll(/IReadOnlyList<(Bridge\w+)>\s+(Discover\w+)\s*\(/gu)) {
      const open = code.indexOf("(", match.index + match[0].length - 1);
      const close = matchingBracket(code, open);
      if (close < 0) continue;
      const body = bodyAfterParameters(code, close);
      if (body === null) continue;
      discoveries.push({ path, name: match[2], row: match[1], body });
    }
  }
  return discoveries;
}

/** The declared body of the method named `name`, or null when no declaration of it exists. */
export function methodBody(sources, name) {
  const pattern = new RegExp(`\\b${name}\\s*(?:<[^<>]{0,80}>)?\\s*\\(`, "gu");
  for (const { source } of sources) {
    const code = codeOnly(source);
    for (const match of code.matchAll(pattern)) {
      const open = code.indexOf("(", match.index + match[0].length - 1);
      const close = matchingBracket(code, open);
      if (close < 0) continue;
      const body = bodyAfterParameters(code, close);
      if (body !== null) return body;
    }
  }
  return null;
}

/** The per-location collections a body reads, e.g. `location.objects`, `location?.furniture`. */
export function collectionsRead(body, collections) {
  const reads = new Set();
  for (const collection of collections) {
    const pattern = new RegExp(`[A-Za-z_][\\w.]*\\s*\\??\\s*\\.\\s*${collection}\\b`, "u");
    if (pattern.test(body)) reads.add(collection);
  }
  return reads;
}

/** The `.cs` files under the Mod root, relative to the repository root, sorted for a stable report. */
export function readModSources({ root = REPOSITORY_ROOT, modRoot = MOD_ROOT } = {}) {
  const sources = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.includes(entry.name)) continue;
        walk(join(directory, entry.name));
        continue;
      }
      if (!entry.name.endsWith(SOURCE_EXTENSION)) continue;
      const absolute = join(directory, entry.name);
      if (!statSync(absolute).isFile()) continue;
      sources.push({ path: relative(root, absolute).replaceAll("\\", "/"), source: readFileSync(absolute, "utf8") });
    }
  };
  walk(join(root, modRoot));
  return sources;
}
