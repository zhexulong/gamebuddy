import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The two ways a mounted action can be MOUNTED BUT UNUSABLE - neither of which a native-local runner can see, because
 * those runners call `client.execute` directly and the Host's request validation never runs during a live gate.
 *
 *   1. `toArgs(params)` is the ONLY source of the wire arguments
 *      (`executeGameAction(..., definition.toArgs(params), ...)`), so a mount written `toArgs: () => ({})` sends
 *      `args: {}` and `validateExecutionRequest` refuses every call. Six published actions shipped that way -
 *      use_obelisk, withdraw_silo_hay, clear_fish_pond, toggle_animal_door, build_farm_building, accept_daily_quest -
 *      visible to the agent and dead on every invocation.
 *   2. `isModDescriptorComplete` is a per-action chain ending in `return false`, so an action without an arm is never
 *      mounted at all and never appears in `visibleActionsFromModCatalog`: the agent cannot see it. Promoting such an
 *      action changes its lifecycle and its gate while the tool does not exist.
 *
 * Both assertions read the two sources of truth - the mount blocks in `game-tools.ts` and the Mod's own catalog - so a
 * newly mounted action is covered the moment it is mounted rather than when someone remembers to extend a list.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const GAME_TOOLS = readFileSync(join(ROOT, "host", "src", "game-tools.ts"), "utf8");
const CATALOG = readFileSync(
  join(ROOT, "integrations", "stardew", "src", "Core", "Policy", "FarmhandActionDefinitions.cs"),
  "utf8",
);
const REGISTRY = readFileSync(join(ROOT, "host", "src", "action-registry.ts"), "utf8");

/** The mount blocks, with the action id and the toArgs expression that feeds the request. */
function mountBlocks() {
  const blocks: Array<{ action: string; params: string; body: string }> = [];
  const re = /entry\.actionId === "([a-z_]+)",[\s\S]{0,1200}?toArgs: \(([^)]*)\) => \(([\s\S]{0,300}?)\),\n/g;
  for (const match of GAME_TOOLS.matchAll(re)) {
    blocks.push({ action: match[1], params: match[2].trim(), body: match[3].trim() });
  }
  return blocks;
}

/** The arguments the Mod declares, in EITHER descriptor syntax (the long form or the `A(...)` shorthand). */
function declaredArgumentNames(id: string): string[] | null {
  const at = CATALOG.indexOf('E("' + id + '"');
  if (at === -1) return null;
  const segment = CATALOG.slice(at, at + 3000);
  const lifecycle = segment.indexOf("FarmhandActionLifecycle");
  const head = lifecycle > 0 ? segment.slice(0, lifecycle) : segment;
  const names = [
    ...[...head.matchAll(/new FarmhandActionArgument\("([A-Za-z]+)"/g)].map((m) => m[1]),
    ...[...head.matchAll(/\(\s*"([A-Za-z]+)",\s*"(?:integer|string|boolean|number)"\s*\)/g)].map((m) => m[1]),
  ];
  return [...new Set(names)];
}

test("every mount forwards the arguments its action declares", () => {
  const blocks = mountBlocks();
  assert.ok(blocks.length >= 20, `expected the mount blocks to be found, found ${blocks.length}`);

  const offenders: string[] = [];
  for (const block of blocks) {
    const declared = declaredArgumentNames(block.action);
    assert.notEqual(declared, null, `${block.action} has a mount block but is not in the Mod catalog`);
    if (declared!.length === 0) continue;
    // Forwarding means naming each declared argument from the tool's own input. The parameter is not always called
    // `params` (two mounts call it `args`), so the assertion follows whatever the mount declares, not a fixed name.
    const source = block.params.length > 0 ? block.params : "params";
    const forwardsAll = declared!.every((name) =>
      new RegExp("\\b" + name + ":\\s*[A-Za-z]*\\(?\\s*" + source + "\\." + name + "\\b").test(block.body),
    );
    if (!forwardsAll) offenders.push(`${block.action} declares [${declared!.join(", ")}] but sends "${block.body}"`);
  }
  assert.deepEqual(offenders, [], "a mount that drops its arguments is a tool the agent can call and never use");
});

test("every mounted action has a descriptor-completeness arm, or it cannot be seen at all", () => {
  const missing = mountBlocks()
    .map((block) => block.action)
    .filter((action) => !REGISTRY.includes('if (actionId === "' + action + '")'));
  assert.deepEqual(
    missing,
    [],
    "isModDescriptorComplete ends in `return false`, so an action without an arm is never mounted or advertised",
  );
});
