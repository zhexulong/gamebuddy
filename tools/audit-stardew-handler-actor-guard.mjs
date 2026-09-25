/**
 * Per-handler scope-bound actor guard audit.
 *
 * Counts, for every `RequestLocal*` handler in the Mod execution controller
 * (public or private — `RequestLocalDoorTransition` is a private helper reached
 * from the two enter/exit entry points), whether that handler's OWN body calls
 * `TryGetBoundActor`. A whole-file count is not enough: a partial file with 11
 * handlers and 3 references leaves 8 handlers unguarded, and a file-level check
 * reports the file as "guarded".
 *
 * A naive regex is not enough either: `Request\w*\(` must not be allowed to skip
 * a handler, so handlers are located by scanning for the exact declaration
 * prefix and then brace-matching to the end of the method.
 *
 * Usage: node tools/audit-stardew-handler-actor-guard.mjs [--rev <sha>]
 */
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
let rev = "HEAD";
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--rev") rev = argv[++index];
  else throw new Error(`unknown_argument:${argv[index]}`);
}

const files = execFileSync("git", ["ls-tree", "-r", "--name-only", rev, "--", "integrations/stardew/"], {
  encoding: "utf8",
})
  .split("\n")
  .map((line) => line.trim())
  .filter((file) => file.length > 0 && /farmhandexecutioncontroller.*[.]cs$/.test(file));

const DECLARATION = "LocalExecutionReceipt RequestLocal";
const GUARD = "TryGetBoundActor";

/** Extract each handler body by brace matching from its declaration. */
function handlersIn(text) {
  const found = [];
  let cursor = 0;
  for (;;) {
    const start = text.indexOf(DECLARATION, cursor);
    if (start < 0) break;
    // The declaration may be reached via `public` or `private`; walk back to the
    // start of the member so the extracted body includes the whole signature.
    const lineStart = text.lastIndexOf("\n", start) + 1;
    const nameStart = start + DECLARATION.length;
    const paren = text.indexOf("(", nameStart);
    const name = `RequestLocal${text.slice(nameStart, paren).trim()}`;
    // Brace-match from the opening brace of the method body.
    const open = text.indexOf("{", paren);
    let depth = 0;
    let end = open;
    for (let index = open; index < text.length; index += 1) {
      if (text[index] === "{") depth += 1;
      else if (text[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    found.push({ name, body: text.slice(lineStart, end + 1) });
    cursor = end + 1;
  }
  return found;
}

const rows = [];
for (const file of files) {
  const text = execFileSync("git", ["show", `${rev}:${file}`], { encoding: "utf8" });
  for (const handler of handlersIn(text)) {
    rows.push({
      file: file.replace("integrations/stardew/farmhandexecutioncontroller.", ""),
      handler: handler.name,
      guarded: handler.body.includes(GUARD),
    });
  }
}

const unguarded = rows.filter((row) => !row.guarded);
console.log(`rev ${rev}: ${rows.length} handlers in ${files.length} files`);
console.log(`guarded:   ${rows.length - unguarded.length}`);
console.log(`UNGUARDED: ${unguarded.length}`);
for (const row of unguarded) console.log(`  ${row.file.padEnd(34)} ${row.handler}`);
