const MAX_DEPTH = 32;

/**
 * Parses one already length-bounded bridge frame without allowing JSON.parse to
 * collapse duplicate decoded object keys. The named-pipe transport owns byte
 * framing and size limits; this parser owns only JSON grammar and object-key
 * uniqueness.
 */
export function parseStrictBridgeJson(source: string): unknown {
  let offset = 0;
  const whitespace = (): void => {
    while (offset < source.length && /\s/.test(source[offset]!)) offset += 1;
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
        if (names.has(name)) throw invalid();
        names.add(name);
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

  try {
    whitespace();
    value();
    whitespace();
    if (offset !== source.length) throw invalid();
    return JSON.parse(source) as unknown;
  } catch {
    throw invalid();
  }
}

function hexValue(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 65 + 10;
  if (code >= 97 && code <= 102) return code - 97 + 10;
  return -1;
}

function invalid(): Error {
  return new Error("invalid_strict_bridge_json");
}
