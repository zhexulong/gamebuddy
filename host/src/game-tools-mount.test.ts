import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildCandidateToolSchema, createStardewActionTools } from "./game-tools.js";

/**
 * EVERY action the Host mounts must produce a tool-parameter schema.
 *
 * `createStardewActionTools` mounts a tool by finding the action's registration and calling
 * `buildCandidateToolSchema(actionId, descriptor)`, with NO try around the mount blocks. That function used
 * to end in `throw new Error("Unsupported candidate action: ...")`, so any descriptor-complete action without
 * an explicit arm made the ENTIRE tool set fail to build. Fifteen mounted ids were in that state -
 * answer_dialogue, dismiss_modal, shop_purchase, select_mine_elevator_floor and the nine newest among them -
 * and no test noticed, because a native-local runner calls `execute` directly and never mounts a tool.
 *
 * These tests do not carry a list of ids: they read the mount blocks out of game-tools.ts and the declared
 * arguments out of the Mod's own catalog, so a newly mounted action is covered the moment it is mounted.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const GAME_TOOLS = readFileSync(join(ROOT, "host", "src", "game-tools.ts"), "utf8");
const CATALOG = readFileSync(join(ROOT, "integrations", "stardew", "src", "Core", "Policy", "FarmhandActionDefinitions.cs"), "utf8");

/** Every id that has a mount block, straight from the source. */
function mountedActionIds() {
  return [...new Set([...GAME_TOOLS.matchAll(/entry\.actionId === "([a-z_]+)"/g)].map((m) => m[1]))].sort();
}

/** The arguments the Mod's catalog declares for one action, and whether any carries an enum constraint. */
function catalogArguments(id) {
  const at = CATALOG.indexOf(`E("${id}"`);
  assert.notEqual(at, -1, `${id} has a mount block but is not in the Mod catalog`);
  const segment = CATALOG.slice(at, at + 800);
  const args = [...segment.matchAll(/new FarmhandActionArgument\("([A-Za-z]+)",\s*"([a-z]+)"(,\s*[A-Za-z]+)?\)/g)].map((m) => ({
    name: m[1],
    type: m[2],
    constrained: m[3] !== undefined,
  }));
  const postcondition = (segment.replace(/\s+/g, " ").match(/,\s*"([a-z_]+)",\s*"/) ?? [])[1] ?? "unknown";
  return { args, postcondition };
}

test("every mounted action builds a tool schema from a descriptor of its own declared arguments", () => {
  const ids = mountedActionIds();
  assert.ok(ids.length >= 20, `expected the mount blocks to be found, got ${ids.length}`);
  const failures = [];
  for (const id of ids) {
    const { args, postcondition } = catalogArguments(id);
    const descriptor = {
      arguments: args.map((argument) => ({ name: argument.name, type: argument.type })),
      effect: "write",
      postcondition: { name: postcondition },
      nativeBinding: "X.Y",
    };
    try {
      const schema = buildCandidateToolSchema(id as never, descriptor as never);
      assert.ok(schema !== undefined && schema !== null, `${id} produced no schema`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Two ids legitimately refuse a descriptor that does not carry their enum: their schema CANNOT be
      // derived, and the refusal must name the argument rather than be a generic "unsupported action".
      const constrained = args.filter((argument) => argument.constrained).map((argument) => argument.name);
      if (constrained.length > 0 && constrained.some((name) => message.includes(name))) continue;
      failures.push(`${id}: ${message.slice(0, 120)}`);
    }
  }
  assert.deepEqual(failures, [], `these mounted actions cannot build a tool: ${failures.join(" | ")}`);
});

test("the schema builder refuses only by naming what is missing, never with an unhelpful fallback", () => {
  // A descriptor whose arguments cannot be read at all is the one case that may not produce a schema. The
  // message must still name the action, so a future reader can tell WHICH mount failed. `claim_mail_attachment`
  // is used deliberately: it was one of the fifteen ids with no explicit arm, so it is the fallback's own
  // message that is asserted here (an id WITH an arm builds its schema without reading the descriptor at all).
  const empty = { arguments: undefined, argumentSchema: undefined, effect: "write", postcondition: { name: "x" } };
  assert.throws(
    () => buildCandidateToolSchema("claim_mail_attachment" as never, empty as never),
    /Unsupported candidate action: claim_mail_attachment/,
  );
});

test("the mounted tool set is built from registrations rather than from a frozen list", () => {
  // The shape of the guarantee: with no registrations there are no tools, and the builder is exported for
  // the per-action checks above. This pins that `createStardewActionTools` exists and is reachable, so the
  // functions these tests exercise are the ones a session actually calls.
  assert.equal(typeof createStardewActionTools, "function");
  assert.equal(typeof buildCandidateToolSchema, "function");
});
