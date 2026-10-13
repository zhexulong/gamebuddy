import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The dehydrator's callers are a closed set, and this is the check that keeps it
 * closed.
 *
 * `attachNativeCompanionContent` is the seam that decides whether the text the
 * model produced reaches a surface as itself or as a projection of itself. Only
 * two surfaces may project: the in-game bubble and the voice, neither of which
 * can draw a `*...*` beat. The Chat transcript must receive the model's exact
 * text, because its renderer draws that beat and its durable row is what the
 * player reads back.
 *
 * The failure this catches: a new caller - or a literal substituted for the
 * named choice - silently deleting the companion's only expression channel on a
 * surface that draws it, which is the exact defect that shipped in the Chat
 * lane. The check is stated against the rule (which surfaces may project, and
 * what each choice means) rather than against one function, so the next person
 * who wires the dehydrator somewhere else fails here instead of in a transcript.
 */
type SourceFile = Readonly<{ path: string; text: string }>;

/** The presentation choice each production caller must name, by caller path. */
const CALLERS: Readonly<Record<string, string>> = Object.freeze({
  "companion-loop.ts": "NATIVE_BUBBLE_STAGE_DIRECTION",
  "tavern/p4-provider-start-execution.ts": "CHAT_TRANSCRIPT_STAGE_DIRECTION",
  "tavern/provider-invocation.ts": "CHAT_TRANSCRIPT_STAGE_DIRECTION",
});

/** The one value each named choice may carry. */
const CHOICE_VALUES: Readonly<Record<string, string>> = Object.freeze({
  NATIVE_BUBBLE_STAGE_DIRECTION: "strip",
  CHAT_TRANSCRIPT_STAGE_DIRECTION: "keep",
});

const ATTACH = "attachNativeCompanionContent(";

/**
 * Audits production sources and returns one message per violation. An empty
 * result means the closed set still holds.
 */
export function auditStageDirectionCallSites(files: readonly SourceFile[]): readonly string[] {
  const violations: string[] = [];
  const callers = new Map<string, number>();

  for (const file of files) {
    const calls = callSites(file.text);
    if (calls > 0) callers.set(file.path, calls);

    const literal = /stageDirection:\s*["'](strip|keep)["']/u.exec(file.text);
    if (literal !== null)
      violations.push(
        `${file.path} passes the literal ${JSON.stringify(literal[1])}: the presentation choice must be one of the named constants, so a caller cannot quietly change it`,
      );

    for (const [constant, value] of Object.entries(CHOICE_VALUES)) {
      const declared = new RegExp(`export const ${constant} = "([^"]*)" as const;`, "u").exec(file.text);
      if (declared !== null && declared[1] !== value)
        violations.push(`${file.path} declares ${constant} = "${declared[1]}": it must stay "${value}"`);
    }
  }

  for (const path of callers.keys())
    if (CALLERS[path] === undefined)
      violations.push(
        `${path} calls ${ATTACH.slice(0, -1)}: only ${Object.keys(CALLERS).join(", ")} may present native companion content`,
      );

  for (const [path, constant] of Object.entries(CALLERS)) {
    const calls = callers.get(path);
    if (calls === undefined) {
      violations.push(`${path} no longer presents native companion content`);
      continue;
    }
    const named = callers.get(path) === undefined ? 0 : countMatches(files, path, `stageDirection: ${constant}`);
    if (named !== calls)
      violations.push(
        `${path} makes ${calls} call(s) but names ${constant} ${named} time(s): each call must carry the ${CHOICE_VALUES[constant]} presentation explicitly`,
      );
  }

  return Object.freeze(violations);
}

/** Call sites in one source text: the declaration and the import list are not calls. */
function callSites(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    if (!line.includes(ATTACH)) continue;
    if (/^\s*(?:import|export)\b/u.test(line)) continue;
    if (/function\s+attachNativeCompanionContent/u.test(line)) continue;
    count++;
  }
  return count;
}

function countMatches(files: readonly SourceFile[], path: string, needle: string): number {
  const text = files.find((file) => file.path === path)?.text ?? "";
  return text.split(needle).length - 1;
}

/** Every production source under `host/src` (tests and test support excluded). */
async function productionSources(directory: string): Promise<readonly SourceFile[]> {
  const entries = (await readdir(directory, { recursive: true })) as string[];
  const files: SourceFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".test-support.ts")) continue;
    files.push(
      Object.freeze({ path: entry.split(sep).join("/"), text: await readFile(join(directory, entry), "utf8") }),
    );
  }
  return Object.freeze(files);
}

/** `host/src`, resolved the same whether this module runs from source or from the compiled test project. */
const hostSourceRoot = fileURLToPath(new URL("../src", import.meta.url));

test("only the bubble and the Chat transcript present native companion content, and each names its choice", async () => {
  const violations = auditStageDirectionCallSites(await productionSources(hostSourceRoot));
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("a third caller, a literal choice, or a flipped Chat constant fails this check", () => {
  const declarations = [
    'export const NATIVE_BUBBLE_STAGE_DIRECTION = "strip" as const;',
    'export const CHAT_TRANSCRIPT_STAGE_DIRECTION = "keep" as const;',
  ].join("\n");
  const allowed: readonly SourceFile[] = [
    { path: "native-companion-content.ts", text: declarations },
    { path: "companion-loop.ts", text: "attachNativeCompanionContent(session, sinks, {\n  stageDirection: NATIVE_BUBBLE_STAGE_DIRECTION,\n});" },
    { path: "tavern/p4-provider-start-execution.ts", text: "attachNativeCompanionContent(session, sinks, {\n  stageDirection: CHAT_TRANSCRIPT_STAGE_DIRECTION,\n});" },
    { path: "tavern/provider-invocation.ts", text: "attachNativeCompanionContent(session, sinks, {\n  stageDirection: CHAT_TRANSCRIPT_STAGE_DIRECTION,\n});" },
  ];
  assert.deepEqual(auditStageDirectionCallSites(allowed), []);

  const thirdCaller = auditStageDirectionCallSites([
    ...allowed,
    { path: "somewhere-else.ts", text: "attachNativeCompanionContent(session, sinks, {\n  stageDirection: CHAT_TRANSCRIPT_STAGE_DIRECTION,\n});" },
  ]);
  assert.equal(thirdCaller.length, 1);
  assert.match(thirdCaller[0]!, /somewhere-else\.ts calls attachNativeCompanionContent/u);

  const literalChoice = auditStageDirectionCallSites(
    allowed.map((file) =>
      file.path === "tavern/provider-invocation.ts"
        ? { ...file, text: 'attachNativeCompanionContent(session, sinks, { stageDirection: "keep" });' }
        : file,
    ),
  );
  assert.ok(literalChoice.some((violation) => /passes the literal "keep"/u.test(violation)));
  assert.ok(literalChoice.some((violation) => /names CHAT_TRANSCRIPT_STAGE_DIRECTION 0 time\(s\)/u.test(violation)));

  const flipped = auditStageDirectionCallSites([
    { path: "native-companion-content.ts", text: 'export const CHAT_TRANSCRIPT_STAGE_DIRECTION = "strip" as const;' },
    ...allowed.slice(1),
  ]);
  assert.ok(flipped.some((violation) => /declares CHAT_TRANSCRIPT_STAGE_DIRECTION = "strip"/u.test(violation)));
});
