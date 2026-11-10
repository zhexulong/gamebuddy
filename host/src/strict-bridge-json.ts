const MAX_DEPTH = 32;

/**
 * Duplicate-key detection for the wire-parity tooling that parses REAL Mod-produced frames (`stardew-*-wire-parity.test.ts`,
 * `integrations/stardew/action-development/src/wire-parity.mjs`). It is NOT on the bridge receive path.
 *
 * <p>
 * `LocalStardewBridge.receive` uses `JSON.parse`. The Mod writes every outbound frame through
 * `BridgeProtocol.TrySerialize`, which is `System.Text.Json.JsonSerializer.Serialize` over typed records: property names are
 * compiler-unique under the camelCase policy (a collision throws at metadata creation), a `Dictionary<string, …>` cannot
 * hold the same key twice, and the only `[JsonExtensionData]` members in the wire models are on inbound Host→Mod request
 * types. So the producer cannot emit a duplicate, and a duplicate that somehow arrived could not smuggle anything past
 * `validateBridgeMessage` either — `JSON.parse` would keep its last value and the exact-key schemas would then judge that.
 * </p>
 * <p>
 * What remains load-bearing is the DEV reading: these tools parse what the C# exporter actually emitted, so a serializer
 * change that starts writing the same key twice — the one shape that would make `JSON.parse` silently last-win — turns
 * this assertion red here instead of passing quietly in production. Measured 2026-11-10 on a valid 66 KiB snapshot frame
 * (64 chests x 12 items), N=200, three runs on a loaded box: 0.85-3.0 ms median here against 0.15-0.25 ms for
 * `JSON.parse`. On the receive path that cost was paid per inbound frame - one 34-minute live run recorded 3,714 inbound
 * facts plus 80 observed snapshots - which is why the receive path no longer pays it.
 * </p>
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
