import { lstat, readFile } from "node:fs/promises";

/**
 * Conservative default ceiling for small configuration files. Every persisted
 * ChatThread artifact passes its own explicit frozen budget instead; no caller
 * may request an unbounded read.
 */
export const STRICT_JSON_READER_DEFAULT_BUDGET_BYTES = 65_536;
/** Absolute frozen ceiling: the largest owned artifact is the prepared transaction (21 MiB). */
export const STRICT_JSON_READER_MAX_BUDGET_BYTES = 21 * 1024 * 1024;
const MAX_DEPTH = 32;

/**
 * Reads one bounded, stable JSON file without allowing JSON.parse to collapse
 * duplicate decoded object keys. Callers own path policy and error taxonomy.
 * The caller selects the byte budget; the reader still rejects duplicate
 * decoded keys, invalid UTF-8, unstable reads, and files over that budget.
 */
export async function readStrictJsonFile(
  path: string,
  maxBytes: number = STRICT_JSON_READER_DEFAULT_BUDGET_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > STRICT_JSON_READER_MAX_BUDGET_BYTES)
    throw new Error("invalid_strict_json_budget");
  let source: string;
  try {
    source = await readBoundedUtf8File(path, maxBytes);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") throw error;
    throw invalid();
  }
  try {
    return parseStrictJson(source);
  } catch {
    throw invalid();
  }
}

/**
 * Parses one already-bounded UTF-8 JSON document without silently collapsing
 * duplicate decoded object keys. Transport callers own their byte framing and
 * external error taxonomy.
 */
export function parseStrictJson(source: string): unknown {
  if (hasDuplicateKeysOrInvalidJson(source)) throw new Error("invalid_strict_json");
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error("invalid_strict_json");
  }
}

async function readBoundedUtf8File(path: string, maxBytes: number): Promise<string> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxBytes) throw invalid();

  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw invalid();

  // A BOM is not JSON whitespace. `ignoreBOM: true` keeps it visible to the
  // strict grammar below, rather than silently accepting a BOM-prefixed file.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function invalid(): Error {
  return new Error("invalid_strict_json_file");
}

/** Parses JSON while rejecting duplicate decoded object keys before JSON.parse collapses them. */
function hasDuplicateKeysOrInvalidJson(source: string): boolean {
  let offset = 0;
  let duplicate = false;
  const whitespace = (): void => {
    while (offset < source.length && /\s/.test(source[offset]!)) offset += 1;
  };
  const string = (): string => {
    if (source[offset++] !== '"') throw invalid();
    let decoded = "";
    while (offset < source.length) {
      const character = source[offset++]!;
      if (character === '"') return decoded;
      if (character < " ") throw invalid();
      if (character !== "\\") {
        decoded += character;
        continue;
      }
      const escape = source[offset++];
      if (escape === '"' || escape === "\\" || escape === "/") decoded += escape;
      else if (escape === "b") decoded += "\b";
      else if (escape === "f") decoded += "\f";
      else if (escape === "n") decoded += "\n";
      else if (escape === "r") decoded += "\r";
      else if (escape === "t") decoded += "\t";
      else if (escape === "u") {
        let codeUnit = 0;
        for (let index = 0; index < 4; index += 1) {
          const digit = hexValue(source.charCodeAt(offset + index));
          if (digit < 0) throw invalid();
          codeUnit = (codeUnit << 4) | digit;
        }
        decoded += String.fromCharCode(codeUnit);
        offset += 4;
      } else throw invalid();
    }
    throw invalid();
  };
  const value = (depth = 0): void => {
    if (depth > MAX_DEPTH) throw invalid();
    whitespace();
    if (source[offset] === "{") {
      offset += 1;
      whitespace();
      const names = new Set<string>();
      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      for (;;) {
        whitespace();
        const name = string();
        if (names.has(name)) duplicate = true;
        else names.add(name);
        whitespace();
        if (source[offset++] !== ":") throw invalid();
        value(depth + 1);
        whitespace();
        if (source[offset] === "}") {
          offset += 1;
          return;
        }
        if (source[offset++] !== ",") throw invalid();
      }
    }
    if (source[offset] === "[") {
      offset += 1;
      whitespace();
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      for (;;) {
        value(depth + 1);
        whitespace();
        if (source[offset] === "]") {
          offset += 1;
          return;
        }
        if (source[offset++] !== ",") throw invalid();
      }
    }
    if (source[offset] === '"') {
      string();
      return;
    }
    if (source.startsWith("true", offset) && scalarBoundary(offset + 4)) {
      offset += 4;
      return;
    }
    if (source.startsWith("false", offset) && scalarBoundary(offset + 5)) {
      offset += 5;
      return;
    }
    if (source.startsWith("null", offset) && scalarBoundary(offset + 4)) {
      offset += 4;
      return;
    }
    if (number()) return;
    throw invalid();
  };
  const scalarBoundary = (position: number): boolean => {
    const code = source.charCodeAt(position);
    return !(
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 36 ||
      code === 95
    );
  };
  const number = (): boolean => {
    const start = offset;
    if (source[offset] === "-") offset += 1;
    if (source[offset] === "0") offset += 1;
    else {
      const first = source.charCodeAt(offset);
      if (first < 49 || first > 57) {
        offset = start;
        return false;
      }
      do offset += 1;
      while (source.charCodeAt(offset) >= 48 && source.charCodeAt(offset) <= 57);
    }
    if (source[offset] === ".") {
      offset += 1;
      const first = source.charCodeAt(offset);
      if (first < 48 || first > 57) throw invalid();
      do offset += 1;
      while (source.charCodeAt(offset) >= 48 && source.charCodeAt(offset) <= 57);
    }
    if (source[offset] === "e" || source[offset] === "E") {
      offset += 1;
      if (source[offset] === "+" || source[offset] === "-") offset += 1;
      const first = source.charCodeAt(offset);
      if (first < 48 || first > 57) throw invalid();
      do offset += 1;
      while (source.charCodeAt(offset) >= 48 && source.charCodeAt(offset) <= 57);
    }
    if (!scalarBoundary(offset)) throw invalid();
    return true;
  };
  try {
    whitespace();
    value();
    whitespace();
    return duplicate || offset !== source.length;
  } catch {
    return true;
  }
}

function hexValue(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 65 + 10;
  if (code >= 97 && code <= 102) return code - 97 + 10;
  return -1;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
