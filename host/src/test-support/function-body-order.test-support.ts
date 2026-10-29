/**
 * Statement-order assertions scoped to ONE function body.
 *
 * Within a single function, source order is execution order for straight-line
 * code, so comparing two statements' positions is a claim about the program.
 * Over a whole file it is not: an `indexOf` matches a mention in a comment, a
 * call from somewhere else, or the declaration of an extracted helper, and then
 * the two offsets no longer describe one execution. Worse, a marker that
 * disappeared yields `-1`, and `-1 < position` is true - the assertion passes
 * for exactly the refactor it was written to catch.
 *
 * These helpers locate the named function first and refuse to answer when a
 * marker is not inside it, naming the marker that moved.
 */

/** `source` with comment and string/template contents blanked. Positions are preserved. */
function codeOnly(source: string): string {
  const out = source.split("");
  let index = 0;
  while (index < source.length) {
    const pair = source.slice(index, index + 2);
    if (pair === "//") {
      while (index < source.length && source[index] !== "\n") out[index++] = " ";
      continue;
    }
    if (pair === "/*") {
      while (index < source.length && source.slice(index, index + 2) !== "*/") {
        if (source[index] !== "\n") out[index] = " ";
        index++;
      }
      index += 2;
      continue;
    }
    const quote = source[index];
    if (quote === '"' || quote === "'" || quote === "`") {
      index++;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") {
          out[index] = " ";
          index++;
        }
        if (index < source.length && source[index] !== "\n") out[index] = " ";
        index++;
      }
      index++;
      continue;
    }
    index++;
  }
  return out.join("");
}

/**
 * The body of the one top-level `function <name>` in `source`, opening brace
 * through closing brace inclusive.
 *
 * The body opens at the last `{` on the first line at or after the declaration
 * that ends with one, which is where every function in this codebase puts it
 * (a return type annotation may hold braces of its own earlier on that line),
 * and closes at the first `}` in column 0 - where every top-level function here
 * closes. Both conventions are asserted rather than assumed: a slice whose
 * braces do not balance means the span over-ran into the next declaration, and
 * a body that over-runs silently admits markers from that neighbour, which is
 * the false pass these assertions exist to prevent.
 */
export function functionBody(source: string, name: string): string {
  const declarations = [...source.matchAll(new RegExp(`\\bfunction\\s+${name}\\b`, "g"))];
  if (declarations.length === 0) throw new Error(`source_function_missing:${name}`);
  if (declarations.length > 1) throw new Error(`source_function_ambiguous:${name}:${declarations.length}`);

  const lines = source.slice(declarations[0]!.index!).split("\n");
  let open = -1;
  let offset = declarations[0]!.index!;
  for (const line of lines) {
    if (line.trimEnd().endsWith("{")) {
      open = offset + line.trimEnd().length - 1;
      break;
    }
    offset += line.length + 1;
  }
  if (open === -1) throw new Error(`source_function_body_missing:${name}`);

  const close = source.indexOf("\n}", open);
  if (close === -1) throw new Error(`source_function_body_unterminated:${name}`);
  const body = source.slice(open, close + 2);

  let depth = 0;
  for (const character of codeOnly(body)) {
    if (character === "{") depth++;
    else if (character === "}") depth--;
    if (depth < 0) throw new Error(`source_function_body_overran:${name}`);
  }
  if (depth !== 0) throw new Error(`source_function_body_overran:${name}`);
  return body;
}

/**
 * Assert that every marker occurs in `body` and that their first occurrences
 * ascend. The failure names the markers, so a moved or extracted statement
 * reads as itself rather than as an offset comparison.
 */
export function assertStatementOrder(body: string, markers: readonly string[], scenario: string): void {
  const positions = markers.map((marker) => {
    const position = body.indexOf(marker);
    if (position < 0) throw new Error(`${scenario}: "${marker}" is not in the function body these assertions scope to`);
    return Object.freeze({ marker, position });
  });
  for (let index = 1; index < positions.length; index++) {
    const previous = positions[index - 1]!;
    const current = positions[index]!;
    if (!(previous.position < current.position))
      throw new Error(`${scenario}: expected "${previous.marker}" before "${current.marker}" in one function body`);
  }
}
