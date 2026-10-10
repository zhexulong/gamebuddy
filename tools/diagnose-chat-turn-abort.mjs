// Print WHY a hosted chat turn produced no reply.
//
// `native-companion-content.js` classifies a failed provider turn from `finalMessage.stopReason` and keeps
// only the code (`native_rejected_error`), so the transported error text never reaches the log. That is how
// "every chat turn in the live loop produced nothing" stayed unexplained across several sessions: the code
// said `error`, and the reason - `AbortError: This operation was aborted`, i.e. something aborted the
// request in-process rather than the provider rejecting it - was dropped one frame earlier.
//
// This patches a built generation (not the source) so the next run names the cause, then requires a rebuild
// of the generation to undo. It never touches the source tree, never prints credentials, and bounds what it
// prints.
//
//   node tools/diagnose-chat-turn-abort.mjs --generation-root D:\\_gen-x --restore
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARKER = "[diag-provider]";
const TARGET = "native-companion-content.js";
const ANCHOR = 'if (stopReason === "error") {';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};

function bundlePath(generationRoot) {
  const generations = join(generationRoot, "generations");
  const generation = readdirSync(generations).find((name) =>
    statSync(join(generations, name)).isDirectory(),
  );
  return join(generations, generation, TARGET);
}

function strip(text) {
  return text
    .replace(/\s*process\.stderr\.write\("\[diag-provider\][^;]*;\s*/gu, " ")
    .split("\n")
    .filter((line) => !line.includes(MARKER))
    .join("\n");
}

export function diagnoseChatTurnAbort(generationRoot) {
  const path = bundlePath(generationRoot);
  const original = readFileSync(path, "utf8");
  const stripped = strip(original);
  const at = stripped.indexOf(ANCHOR);
  if (at < 0) throw new Error("classification site not found in the generation");
  const diagnostic =
    `process.stderr.write("${MARKER} " + JSON.stringify({ ` +
    `errorMessage: finalMessage?.errorMessage ?? null, ` +
    `rawStopReason: finalMessage?.rawStopReason ?? null, ` +
    `stopReason: finalMessage?.stopReason ?? null, ` +
    `provider: finalMessage?.provider ?? null, model: finalMessage?.model ?? null, ` +
    `api: finalMessage?.api ?? null }).slice(0, 500) + "\\n"); `;
  writeFileSync(path, `${stripped.slice(0, at)}${diagnostic}${stripped.slice(at)}`);
  return { path, patched: true };
}

export function restoreChatTurnDiagnostic(generationRoot) {
  const path = bundlePath(generationRoot);
  const text = readFileSync(path, "utf8");
  if (!text.includes(MARKER)) return { path, patched: false };
  writeFileSync(path, strip(text));
  return { path, patched: true };
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/gu, "/"))) {
  const generationRoot = flag("--generation-root");
  if (generationRoot === undefined) throw new Error("usage: --generation-root <dir> [--restore]");
  const result = args.includes("--restore")
    ? restoreChatTurnDiagnostic(generationRoot)
    : diagnoseChatTurnAbort(generationRoot);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
