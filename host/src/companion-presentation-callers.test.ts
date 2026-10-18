import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The callers of `attachNativeCompanionContent` are a closed set, and so are the
 * named presentation choices each one must carry. This is the check that keeps
 * both closed.
 *
 * `attachNativeCompanionContent` is the seam that decides what text the model
 * produced reaches a surface as. Two independent choices live there:
 *
 *  - `stageDirection`: `"strip"` for a surface that cannot draw a `*...*` beat
 *    (the in-game bubble and the voice); `"keep"` for the Chat transcript, whose
 *    renderer draws the beat and whose durable row is what the player reads back.
 *  - `scaffolding`: `"drop"` for the Chat row, which must not carry the model's
 *    own scratchpad (`<thinking>`, `（思考：...）`, `【内心：...】`,
 *    `**emphasis**`, `---` rules); `"unchanged"` for a surface whose projection
 *    already removes scaffolding, which is what the frozen dehydrator does.
 *
 * The failure this catches: a new caller, or a literal substituted for the named
 * choice, silently deleting the companion's only expression channel on a surface
 * that draws it - or silently letting the model's scaffolding through into the
 * player's transcript. The check is stated against the rule (which surfaces may
 * present, and which choices each must name) rather than against one function,
 * so the next person who wires the seam somewhere else fails here instead of in
 * a transcript.
 */
type SourceFile = Readonly<{ path: string; text: string }>;

/** The named presentation choices each production caller must carry, by caller path. */
const CALLERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "companion-loop.ts": Object.freeze(["NATIVE_BUBBLE_STAGE_DIRECTION", "NATIVE_BUBBLE_SCAFFOLDING"]),
  "tavern/p4-provider-start-execution.ts": Object.freeze([
    "CHAT_TRANSCRIPT_STAGE_DIRECTION",
    "CHAT_TRANSCRIPT_SCAFFOLDING",
  ]),
});

/** The one value each named choice may carry. */
const CHOICE_VALUES: Readonly<Record<string, string>> = Object.freeze({
  NATIVE_BUBBLE_STAGE_DIRECTION: "strip",
  CHAT_TRANSCRIPT_STAGE_DIRECTION: "keep",
  NATIVE_BUBBLE_SCAFFOLDING: "unchanged",
  CHAT_TRANSCRIPT_SCAFFOLDING: "drop",
});

/** The option each named choice is passed as. */
const CHOICE_AXES: Readonly<Record<string, string>> = Object.freeze({
  NATIVE_BUBBLE_STAGE_DIRECTION: "stageDirection",
  CHAT_TRANSCRIPT_STAGE_DIRECTION: "stageDirection",
  NATIVE_BUBBLE_SCAFFOLDING: "scaffolding",
  CHAT_TRANSCRIPT_SCAFFOLDING: "scaffolding",
});

const OPTION_AXES = Object.freeze(["stageDirection", "scaffolding"]);
const ATTACH = "attachNativeCompanionContent(";

/**
 * Audits production sources and returns one message per violation. An empty
 * result means the closed set still holds.
 */
export function auditPresentationCallSites(files: readonly SourceFile[]): readonly string[] {
  const violations: string[] = [];
  const callers = new Map<string, number>();

  for (const file of files) {
    const calls = callSites(file.text);
    if (calls > 0) callers.set(file.path, calls);

    for (const axis of OPTION_AXES) {
      const literal = new RegExp(`${axis}:\\s*["'][a-z_]+["']`, "u").exec(file.text);
      if (literal !== null)
        violations.push(
          `${file.path} passes the literal ${JSON.stringify(literal[0])}: each presentation choice must be one of the named constants, so a caller cannot quietly change it`,
        );
    }

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

  for (const [path, constants] of Object.entries(CALLERS)) {
    const calls = callers.get(path);
    if (calls === undefined) {
      violations.push(`${path} no longer presents native companion content`);
      continue;
    }
    for (const constant of constants) {
      const named = countMatches(files, path, `${CHOICE_AXES[constant]}: ${constant}`);
      if (named !== calls)
        violations.push(
          `${path} makes ${calls} call(s) but names ${constant} ${named} time(s): each call must carry the ${CHOICE_VALUES[constant]} ${CHOICE_AXES[constant]} explicitly`,
        );
    }
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

test("only the bubble and the Chat transcript present native companion content, and each names both of its choices", async () => {
  const violations = auditPresentationCallSites(await productionSources(hostSourceRoot));
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("a third caller, a literal choice, a missing scaffolding name, or a flipped Chat constant fails this check", () => {
  const declarations = [
    'export const NATIVE_BUBBLE_STAGE_DIRECTION = "strip" as const;',
    'export const CHAT_TRANSCRIPT_STAGE_DIRECTION = "keep" as const;',
    'export const NATIVE_BUBBLE_SCAFFOLDING = "unchanged" as const;',
    'export const CHAT_TRANSCRIPT_SCAFFOLDING = "drop" as const;',
  ].join("\n");
  const bubbleOptions =
    "{\n  stageDirection: NATIVE_BUBBLE_STAGE_DIRECTION,\n  scaffolding: NATIVE_BUBBLE_SCAFFOLDING,\n}";
  const chatOptions =
    "{\n  stageDirection: CHAT_TRANSCRIPT_STAGE_DIRECTION,\n  scaffolding: CHAT_TRANSCRIPT_SCAFFOLDING,\n}";
  const allowed: readonly SourceFile[] = [
    { path: "native-companion-content.ts", text: declarations },
    { path: "companion-loop.ts", text: `attachNativeCompanionContent(session, sinks, ${bubbleOptions});` },
    {
      path: "tavern/p4-provider-start-execution.ts",
      text: `attachNativeCompanionContent(session, sinks, ${chatOptions});`,
    },
  ];
  assert.deepEqual(auditPresentationCallSites(allowed), []);

  const thirdCaller = auditPresentationCallSites([
    ...allowed,
    { path: "somewhere-else.ts", text: `attachNativeCompanionContent(session, sinks, ${chatOptions});` },
  ]);
  assert.equal(thirdCaller.length, 1);
  assert.match(thirdCaller[0]!, /somewhere-else\.ts calls attachNativeCompanionContent/u);

  const literalChoice = auditPresentationCallSites(
    allowed.map((file) =>
      file.path === "tavern/p4-provider-start-execution.ts"
        ? { ...file, text: 'attachNativeCompanionContent(session, sinks, { stageDirection: "keep" });' }
        : file,
    ),
  );
  assert.ok(literalChoice.some((violation) => /passes the literal "stageDirection: \\"keep\\""/u.test(violation)));
  assert.ok(literalChoice.some((violation) => /names CHAT_TRANSCRIPT_STAGE_DIRECTION 0 time\(s\)/u.test(violation)));
  assert.ok(literalChoice.some((violation) => /names CHAT_TRANSCRIPT_SCAFFOLDING 0 time\(s\)/u.test(violation)));

  const missingScaffolding = auditPresentationCallSites(
    allowed.map((file) =>
      file.path === "tavern/p4-provider-start-execution.ts"
        ? {
            ...file,
            text: "attachNativeCompanionContent(session, sinks, {\n  stageDirection: CHAT_TRANSCRIPT_STAGE_DIRECTION,\n});",
          }
        : file,
    ),
  );
  assert.ok(
    missingScaffolding.some((violation) => /names CHAT_TRANSCRIPT_SCAFFOLDING 0 time\(s\)/u.test(violation)),
    "a Chat caller that names no scaffolding choice must fail the check",
  );

  const flipped = auditPresentationCallSites([
    { path: "native-companion-content.ts", text: 'export const CHAT_TRANSCRIPT_STAGE_DIRECTION = "strip" as const;' },
    ...allowed.slice(1),
  ]);
  assert.ok(flipped.some((violation) => /declares CHAT_TRANSCRIPT_STAGE_DIRECTION = "strip"/u.test(violation)));

  const flippedScaffolding = auditPresentationCallSites([
    { path: "native-companion-content.ts", text: 'export const CHAT_TRANSCRIPT_SCAFFOLDING = "unchanged" as const;' },
    ...allowed.slice(1),
  ]);
  assert.ok(
    flippedScaffolding.some((violation) => /declares CHAT_TRANSCRIPT_SCAFFOLDING = "unchanged"/u.test(violation)),
    "a Chat row that stops dropping scaffolding must fail the check",
  );
});
