import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateBridgeMessage } from "./protocol.js";
import * as targetFacts from "./protocol-target-facts.js";

/**
 * ONE GRAMMAR FOR A QUALIFIED ITEM ID, AND IT IS THE ENGINE'S.
 *
 * <p>
 * Every Host validator that admits a qualified item id used to spell `^\([A-Z]+\)[0-9]+$` - a bracketed type prefix
 * and a DIGITS-ONLY body. That is not the engine's format. The engine builds the id by concatenating exactly two parts,
 * `QualifiedItemId => TypeDefinitionId + ItemId` (Item.cs:187-197), and the second part is an item KEY, which the engine
 * documents as "alphanumeric, underscore, and dot characters" (Item.cs:165) - never as a number. `ItemRegistry`'s own
 * format check is only "starts with '(' and contains ')'" (ItemRegistry.cs:183-190). Stardew 1.6 ships real letter ids:
 * `(O)SeedSpot` reaches the same dig branch as `(O)590`, and `(O)Carrot`, `(O)CarrotSeeds`, `(BC)Dehydrator`,
 * `(T)WateringCan` and `(TR)FrogEgg` are all items the game really names.
 * </p>
 *
 * <p>
 * The consequence was not a refusal, it was a DROPPED RUN. A machine row whose `loadInputQualifiedItemId` was
 * `(O)CarrotSeeds` failed `isMachineTargetFact`, the whole snapshot came back `invalid_snapshot:machineTargets`, and
 * `local-stardew-bridge` closes the transport on any inbound frame the validator refuses (local-stardew-bridge.ts:853).
 * Measured on this tree before the fix: that row returned `invalid_snapshot` and the same row with `(O)433` returned
 * null. One letter id mid-run is a named pipe that disconnects.
 * </p>
 *
 * <h2>Why a gate and not a fix</h2>
 * <p>
 * The fix is one character class. The DEFECT is that a grammar the engine never promised can be written into any Host
 * validator with nothing failing until a real save publishes the id it refuses - and there were SIX such spellings in
 * three files and one wire schema. This gate DERIVES its population from the tree: every exported predicate in
 * `protocol-target-facts` whose name says qualified item id, every `pattern` in `bridge-v1.schema.json` attached to a
 * property that says the same, and every `pattern` the model-facing tool schemas in `game-tools.ts` pin on such a
 * property. Zero population is BLOCKED, never green.
 * </p>
 *
 * <h2>Where the samples come from, and what is hand-picked</h2>
 * <p>
 * Two legs, and the second is labelled because it is a decision rather than a derivation:
 * </p>
 * <ul>
 * <li>DERIVED: the qualified ids the Host's own sources and its recorded live receipts under `host/src/test-fixtures`
 * already spell. These are the engine's real ids as this product has met them.</li>
 * <li>HAND-PICKED, from a documented alphabet: for every prefix the derived ids use, one body per character class
 * `Item.cs:165` documents - letters (`Carrot`), digits (`433`), underscore (`Carrot_Seeds`) and dot (`Carrot.Seeds`).
 * The prefixes are derived; only the alphabet comes from that one line of engine documentation, and it is named here
 * rather than left implied.</li>
 * </ul>
 * <p>
 * The engine's own tree (`ref/external/StardewValleyDecompiled`, the source of both citations above) is gitignored and
 * untracked, so it cannot be read from a test that must pass in a fresh clone. That is why the alphabet is quoted
 * with file:line instead of parsed.
 * </p>
 */

/** The repository root, walked up to because this file is compiled into `dist-test/` and reads SOURCE. */
function repoRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, "integrations", "stardew", "action-development"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repository root not found from ${start}`);
    directory = parent;
  }
}

const ROOT = repoRoot(dirname(fileURLToPath(import.meta.url)));
const HOST_SOURCE = join(ROOT, "host", "src");
const QUALIFIED_ID = /\([A-Z]{1,3}\)[A-Za-z0-9_.]+/gu;

/** Every `.ts` (not a test, not test support) and `.json` file under the Host source tree, as text. */
function hostSourceTexts(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      hostSourceTexts(path, found);
      continue;
    }
    if (entry.name.endsWith(".test.ts") || entry.name.includes("test-support")) continue;
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".json")) found.push(readFileSync(path, "utf8"));
  }
  return found;
}

/**
 * The accepted fixtures: every qualified id the product already spells, plus one body per character class the engine
 * documents (`Item.cs:165`) under every prefix those ids use - the letters being the class that was refused.
 */
function acceptedSamples(): readonly string[] {
  const ids = new Set<string>();
  for (const text of hostSourceTexts(HOST_SOURCE)) {
    for (const match of text.matchAll(QUALIFIED_ID)) ids.add(match[0]);
  }
  const prefixes = new Set([...ids].map((id) => id.slice(0, id.indexOf(")") + 1)));
  const bodies = ["Carrot", "433", "Carrot_Seeds", "Carrot.Seeds"];
  for (const prefix of prefixes) for (const body of bodies) ids.add(`${prefix}${body}`);
  return [...ids].sort();
}

/** Values a qualified item id is not: empty, unprefixed, empty body, wrong bracket, an unclosed prefix, a space. */
const MALFORMED = Object.freeze(["", "coffee beans", "(O)", "[O]Carrot", "Carrot", "(O)Carrot(", "(O)Carrot Seed"]);

type Validator = Readonly<{ name: string; accepts: (sample: string) => boolean }>;

function patternValidator(name: string, pattern: string): Validator {
  const expression = new RegExp(pattern, "u");
  return { name, accepts: (sample: string) => expression.test(sample) };
}

/** Population leg 1: every exported predicate whose name says qualified item id. Derived from the module, not a list. */
function predicateValidators(): readonly Validator[] {
  return Object.keys(targetFacts)
    .filter((name) => /qualifieditemid/iu.test(name))
    .map((name) => {
      const predicate = (targetFacts as Record<string, unknown>)[name];
      if (typeof predicate !== "function") throw new Error(`qualified_item_id_predicate_not_callable:${name}`);
      return { name: `${name}()`, accepts: (sample: string) => predicate(sample) === true };
    });
}

/**
 * Population leg 2: every `pattern` the wire schema attaches to a property whose name says qualified item id. The walk
 * is over the parsed document, so a family or argument added tomorrow is covered without touching this file.
 */
function schemaValidators(): readonly Validator[] {
  const document: unknown = JSON.parse(readFileSync(join(ROOT, "protocol", "bridge-v1.schema.json"), "utf8"));
  const found: Validator[] = [];
  const walk = (node: unknown, path: readonly string[]): void => {
    if (Array.isArray(node)) {
      node.forEach((element, index) => walk(element, [...path, String(index)]));
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (/qualifieditemid/iu.test(key) && value !== null && typeof value === "object") {
        const pattern = (value as { pattern?: unknown }).pattern;
        if (typeof pattern === "string")
          found.push(patternValidator(`bridge-v1.schema.json:${[...path, key].join(".")}`, pattern));
      }
      walk(value, [...path, key]);
    }
  };
  walk(document, []);
  return found;
}

/**
 * Population leg 3: every `pattern` a model-facing tool schema pins on a qualified item id argument. Read from the
 * source because mounting the tools needs a connected bridge; the declaration is one line each, so the read is exact
 * rather than heuristic, and a tool argument added tomorrow is covered without touching this file.
 */
function toolSchemaValidators(): readonly Validator[] {
  const source = readFileSync(join(ROOT, "host", "src", "game-tools.ts"), "utf8");
  const found: Validator[] = [];
  for (const declaration of source.matchAll(/(\w*qualifieditemid\w*)\s*:\s*Type\.String\(\{([^}]*)\}\)/giu)) {
    const [, property, body] = declaration;
    const pattern = body === undefined ? undefined : /\bpattern:\s*("(?:[^"\\]|\\.)*")/u.exec(body)?.[1];
    if (property === undefined || pattern === undefined) continue;
    found.push(patternValidator(`game-tools.ts:${property}`, JSON.parse(pattern) as string));
  }
  return found;
}

test("every Host spelling of a qualified item id accepts the engine's own ids and refuses a malformed one", () => {
  const legs = [
    ["protocol-target-facts predicates", predicateValidators()],
    ["bridge-v1.schema.json patterns", schemaValidators()],
    ["game-tools.ts patterns", toolSchemaValidators()],
  ] as const;
  const samples = acceptedSamples();
  for (const [leg, entries] of legs) {
    assert.notEqual(entries.length, 0, `qualified_item_id_population_empty:blocked:${leg}`);
  }
  assert.notEqual(samples.length, 0, "qualified_item_id_fixture_population_empty:blocked:no id was derived");
  for (const [leg, entries] of legs) {
    for (const validator of entries) {
      for (const sample of samples) {
        assert.ok(validator.accepts(sample), `qualified_item_id_rejected:${validator.name}(${leg}):${sample}`);
      }
      for (const sample of MALFORMED) {
        assert.ok(!validator.accepts(sample), `qualified_item_id_accepted:${validator.name}(${leg}):${sample}`);
      }
    }
  }
});

/**
 * The class the grammar was costing, asserted at the layer that paid it: a snapshot the Mod really sends - a machine
 * row and a seed row naming a letter item id - must be ACCEPTED, because the bridge CLOSES the named pipe on any
 * inbound frame its validator refuses. The envelope is the committed golden replay, so the rest of the payload is a
 * real one.
 */
test("a snapshot that names a letter item id is accepted, not a reason to close the bridge", () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, "fixtures", "bridge-v1", "golden-sequence.json"), "utf8")) as {
    nowMs: number;
    scope: never;
    messages: readonly Record<string, unknown>[];
  };
  const snapshot = fixture.messages.find((message) => message.type === "snapshot");
  assert.ok(snapshot !== undefined, "fixtures/bridge-v1/golden-sequence.json has no snapshot frame");
  const withFamilies = (families: Record<string, unknown>) => ({
    ...snapshot,
    payload: { ...(snapshot.payload as Record<string, unknown>), ...families },
  });

  assert.equal(
    validateBridgeMessage(
      withFamilies({
        machineTargets: [
          {
            targetId: "machine_deadbeef",
            x: 10,
            y: 12,
            qualifiedItemId: "(BC)Dehydrator",
            displayName: "Dehydrator",
            readyForHarvest: false,
            minutesUntilReady: 0,
            loadInputSlot: 5,
            loadInputQualifiedItemId: "(O)CarrotSeeds",
            loadInputStack: 5,
          },
        ],
      }),
      fixture.scope,
      fixture.nowMs,
    ),
    null,
  );
  assert.equal(
    validateBridgeMessage(
      withFamilies({
        seedSupplyTargets: [
          {
            qualifiedItemId: "(O)CarrotSeeds",
            displayName: "Carrot Seeds",
            heldCount: 4,
            shopLocationUnknown: "no_shop",
          },
        ],
      }),
      fixture.scope,
      fixture.nowMs,
    ),
    null,
  );
});
