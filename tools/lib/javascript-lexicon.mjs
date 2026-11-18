/**
 * The punctuation of JavaScript, read as text: where a string ends, where a template's interpolation resumes, and which
 * token sits at an offset.
 *
 * The import-boundary walk cannot trust a file's text alone - a comment mentioning `import("x")` is not an import, and a
 * string holding one is not either - so it reads tokens instead. Nothing here parses TypeScript: an erased
 * `import("x").T` needs the compiler's own AST (`erasedImportTypeOffsets` stays with the gate that owns that question),
 * and this module answers only what the characters say.
 */
import { relative } from "node:path";

export function lineAt(source, index) {
  return source.slice(0, index).split("\n").length;
}
export function display(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

/** Tokenizes just enough TypeScript/JavaScript to avoid treating comments and
 * ordinary strings as import syntax, while retaining string literal locations. */
export function quotedEnd(source, index, end) {
  const quote = source[index++];
  while (index < end && source[index] !== quote) {
    if (source[index] === "\\") index += 1;
    index += 1;
  }
  return index < end ? index + 1 : end;
}
export function interpolationEnd(source, index, end) {
  let depth = 1;
  while (index < end) {
    const char = source[index];
    if (char === "'" || char === '"') {
      index = quotedEnd(source, index, end);
      continue;
    }
    if (char === "`") {
      index = templateEnd(source, index, end);
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return index;
    index += 1;
  }
  return end;
}
export function templateEnd(source, index, end) {
  index += 1;
  while (index < end && source[index] !== "`") {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "$" && source[index + 1] === "{") {
      index = interpolationEnd(source, index + 2, end) + 1;
      continue;
    }
    index += 1;
  }
  return index < end ? index + 1 : end;
}

/** Tokenizes just enough TypeScript/JavaScript to avoid treating comments and
 * ordinary strings as import syntax, while retaining string literal locations. */
export function tokens(source, start = 0, end = source.length, result = []) {
  let index = start;
  const add = (type, value, offset) => result.push({ type, value, offset, line: lineAt(source, offset) });
  while (index < end) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index < 0 || index >= end) break;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close < 0 || close >= end ? end : close + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const tokenStart = index;
      const quote = char;
      index += 1;
      let value = "";
      while (index < end && source[index] !== quote) {
        if (source[index] === "\\") {
          index += 1;
          if (index < end) value += source[index++];
          continue;
        }
        value += source[index++];
      }
      if (source[index] === quote) index += 1;
      add("string", value, tokenStart);
      continue;
    }
    if (char === "`") {
      const tokenStart = index++;
      while (index < end && source[index] !== "`") {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === "$" && source[index + 1] === "{") {
          const expressionStart = index + 2;
          const expressionEnd = interpolationEnd(source, expressionStart, end);
          tokens(source, expressionStart, expressionEnd, result);
          index = expressionEnd + 1;
          continue;
        }
        index += 1;
      }
      if (source[index] === "`") index += 1;
      add("template", "", tokenStart);
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const tokenStart = index++;
      while (/[A-Za-z0-9_$]/.test(source[index] ?? "")) index += 1;
      add("word", source.slice(tokenStart, index), tokenStart);
      continue;
    }
    add("punctuation", char, index++);
  }
  return result;
}

export function matchingToken(all, index, open, close) {
  let depth = 0;
  for (let cursor = index; cursor < all.length; cursor += 1) {
    if (all[cursor].value === open) depth += 1;
    if (all[cursor].value === close && --depth === 0) return cursor;
  }
  return -1;
}
export function isMethodDeclaration(all, index) {
  let cursor = index + 1;
  if (all[cursor]?.value === "<") {
    cursor = matchingToken(all, cursor, "<", ">");
    if (cursor < 0) return false;
    cursor += 1;
  }
  if (all[cursor]?.value !== "(") return false;
  cursor = matchingToken(all, cursor, "(", ")");
  if (cursor < 0) return false;
  const next = all[cursor + 1]?.value;
  // A return-type annotation can stand between a method's parameters and body.
  // A dynamic import expression cannot be followed by one, so this remains
  // fail-closed for actual dynamic imports (including import(`...`)).
  return next === "{" || next === ":";
}

export function importedBindings(all, start, end) {
  const bindings = [];
  let inBraces = false;
  for (let cursor = start; cursor < end; cursor += 1) {
    const token = all[cursor];
    if (token.value === "{") {
      inBraces = true;
      continue;
    }
    if (token.value === "}") {
      inBraces = false;
      continue;
    }
    if (token.value === "*") {
      bindings.push("*");
      continue;
    }
    if ((token.type !== "word" && token.type !== "string") || token.value === "type" || token.value === "as") continue;
    if (inBraces && ["{", ","].includes(all[cursor - 1]?.value) && all[cursor - 1]?.value !== "type")
      // ES module bindings may be string-named (for example
      // `import { "acceptMountedPlayerMessage" as raw }`). Those are
      // executable bindings just like identifier-named imports.
      bindings.push(token.value);
    else if (!inBraces && cursor === start && token.type === "word") bindings.push("default");
  }
  return bindings;
}
export function isDeclaredExternalPackage(specifier, externalPackages) {
  return [...externalPackages].some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`));
}
