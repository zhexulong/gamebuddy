import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { TOOL_CATEGORY_VALUES } from "./protocol-target-facts.js";

/**
 * `a_tool_category_is_one_vocabulary`: the words a tool can be called by are declared once, by the Mod, and every
 * consumer in this tree reads that same set.
 *
 * <p>
 * THE DEFECT THIS EXISTS FOR. `equip_tool`'s `tool` selector was published with twelve categories
 * (`axe, pickaxe, hoe, watering_can, fishing_rod, weapon, scythe, shears, milk_pail, pan, lantern, raft`) while the
 * Host's validator knew ten - the same list without `lantern` and `raft`. Four separate copies had drifted the same
 * way, and nothing failed, because each copy is only read on a code path a test of a DIFFERENT copy never reaches:
 * </p>
 * <ul>
 *   <li>`host/src/protocol-target-facts.ts` (`TOOL_CATEGORY_VALUES`) - the value `isToolSelector` refuses
 *       `equip_tool` with, and the value `isToolSlotFact` refuses a whole snapshot with. A pack holding a Lantern or a
 *       Raft publishes `category: "lantern"` / `"raft"` (the Mod's one mapping,
 *       `farmhandexecutioncontroller.resourcetoolactions.cs` `ToolCategory`), so the Host answered
 *       `invalid_snapshot:toolSlots` and closed the bridge.</li>
 *   <li>`protocol/bridge-v1.schema.json` `$defs.toolSlot.properties.category` - the same fact on the language-neutral
 *       contract.</li>
 *   <li>`integrations/stardew/action-development/src/equip-tool-{scenario,control}-result.mjs` - the two live proof
 *       validators, which refuse the same words out of an `equip_tool` receipt's evidence.</li>
 * </ul>
 *
 * <p>
 * THE AUTHORITY is the Mod's declaration, reached without reading a line of C#: `FarmhandActionCatalog.ToolEnum`
 * (`src/Core/Policy/FarmhandActionDefinitions.cs:712`) is handed to `equip_tool`'s argument
 * (`:916`, `new FarmhandActionArgument("tool", "string", ToolEnum)`) and projected onto the published surface by
 * `FarmhandActionArgumentPublication.ToSurface` (`src/Core/Policy/farmhandactionsurfacepublication.cs:219`), which is
 * what `action-surface.v1.json` carries. That artifact is the tree's own publication of the Mod's declarations - it is
 * regeneration-gated (`gates/data/check-generated-artifact-reproducibility.mjs`) - so this reads it as data rather than
 * re-deriving the list.
 * </p>
 *
 * <p>
 * WHY A GATE AND NOT ONLY A FIX. The fix is two words in four files. The DEFECT is that the vocabulary can be spelled
 * again anywhere in this tree and nothing notices, which is how four copies drifted in one direction at once. The
 * population below is every declaration of the fact, found by scanning, so a FIFTH copy fails here the day it is
 * written, and a value added on either side fails by name.
 * </p>
 */

/** The repository root: found by walking up to the directory that holds `integrations`. */
function repoRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (
      statSync(join(directory, "integrations", "stardew", "action-development"), {
        throwIfNoEntry: false,
      })?.isDirectory()
    )
      return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repository root not found from ${start}`);
    directory = parent;
  }
}

/** This file is compiled into `dist-test/`, so the tree is located rather than taken from `import.meta.url`. */
const ROOT = repoRoot(dirname(fileURLToPath(import.meta.url)));

const SURFACE_ARTIFACT = "integrations/stardew/action-development/contracts/generated/action-surface.v1.json";
const WIRE_SCHEMA = "protocol/bridge-v1.schema.json";

/** The words the Mod publishes for the selector this gate is about. */
function publishedToolCategories(): readonly string[] {
  const artifact = JSON.parse(readFileSync(join(ROOT, SURFACE_ARTIFACT), "utf8")) as {
    actions?: readonly { actionId?: string; argumentSchema?: Record<string, { enum?: readonly string[] }> }[];
  };
  const equipTool = (artifact.actions ?? []).find((action) => action.actionId === "equip_tool");
  assert.ok(
    equipTool !== undefined,
    `${SURFACE_ARTIFACT} publishes no \`equip_tool\`: the authority for this gate is gone`,
  );
  const values = equipTool.argumentSchema?.tool?.enum;
  assert.ok(
    Array.isArray(values),
    `\`equip_tool.tool\` publishes no \`enum\` in ${SURFACE_ARTIFACT}: the closed vocabulary this gate holds is gone`,
  );
  return values;
}

/**
 * The wire schema's own `toolSlot.category` enum, minus the one word that is not a tool: `unknown` is what the Mod
 * reports for a tool its mapping has no word for, so it is legitimately in the schema and not in the Mod's categories.
 */
function schemaToolCategories(): readonly string[] {
  const schema = JSON.parse(readFileSync(join(ROOT, WIRE_SCHEMA), "utf8")) as {
    $defs?: Record<string, { properties?: Record<string, { enum?: unknown }> }>;
  };
  const values = schema.$defs?.toolSlot?.properties?.category?.enum;
  assert.ok(
    Array.isArray(values) && values.every((value) => typeof value === "string"),
    `${WIRE_SCHEMA} declares no \`$defs.toolSlot.properties.category.enum\`: the contract for a tool slot's word is gone`,
  );
  return (values as readonly string[]).filter((value) => value !== "unknown");
}

/**
 * `TOOL_CATEGORY_VALUES` / `TOOL_SELECTOR_VALUES` assignments whose right-hand side is a literal set.
 *
 * <p>
 * // source-invariant: a declaration of this vocabulary is a `const` whose initializer is `new Set([...])` with string
 * literals. An ALIAS (`protocol.ts`' `TOOL_SELECTOR_VALUES = TOOL_CATEGORY_VALUES`) has no literal and is correctly not
 * a second spelling; a copy that spells values out is exactly what this scan must find.
 * // source-expiry: retire the source read when a consumer can derive the set from the published declaration instead -
 * the two `action-development` validators are the ones that could, once they have a repository root in hand.
 * </p>
 */
const VOCABULARY_DECLARATION =
  /(?:^|\n)[ \t]*(?:export[ \t]+)?const[ \t]+(TOOL_CATEGORY_VALUES|TOOL_SELECTOR_VALUES)\b[^=]*=[ \t]*new[ \t]+Set(?:<string>)?\([ \t]*\[([\s\S]*?)\][ \t]*\)/gu;

type VocabularyDeclaration = Readonly<{ file: string; name: string; values: readonly string[] }>;

/** The roots a second spelling of this vocabulary can live under: the Host's sources and the Mod's tree. */
const SCANNED_ROOTS = Object.freeze(["host/src", "integrations/stardew"]);
const SCANNED_EXTENSIONS = Object.freeze([".ts", ".mts", ".cts", ".mjs", ".js"]);
/** Build output and dependency trees: a compiled or installed copy is not a declaration. */
const SCANNED_SKIP = Object.freeze(new Set(["node_modules", "bin", "obj", "dist", "dist-test", "dist-production"]));

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SCANNED_SKIP.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) found.push(path);
  }
  return found;
}

function vocabularyDeclarations(): readonly VocabularyDeclaration[] {
  const declarations: VocabularyDeclaration[] = [];
  for (const root of SCANNED_ROOTS) {
    for (const path of sourceFiles(join(ROOT, root))) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(VOCABULARY_DECLARATION)) {
        const literals = match[2]!.match(/"[^"\n]*"/gu) ?? [];
        declarations.push({
          file: relative(ROOT, path).split(sep).join("/"),
          name: match[1]!,
          values: literals.map((literal) => literal.slice(1, -1)),
        });
      }
    }
  }
  return declarations.sort((left, right) => left.file.localeCompare(right.file));
}

/** One consumer's set against the authority, both directions, each finding naming the member and the file. */
function vocabularyDisagreements(
  authority: readonly string[],
  consumer: Readonly<{ file: string; name: string; values: readonly string[] }>,
): readonly string[] {
  const published = new Set(authority);
  const declared = new Set(consumer.values);
  const label = `${consumer.file} \`${consumer.name}\``;
  const missing = authority.filter((value) => !declared.has(value));
  const invented = consumer.values.filter((value) => !published.has(value));
  const findings: string[] = [];
  if (missing.length > 0)
    findings.push(`${label} omits ${missing.join(", ")} - the Mod publishes [${authority.join(", ")}]`);
  if (invented.length > 0) findings.push(`${label} publishes ${invented.join(", ")}, which the Mod does not publish`);
  return findings;
}

/** `examined N` is printed on the passing path too: a gate that silently examined nothing looks exactly like agreement. */
function report(authority: readonly string[], consumers: readonly VocabularyDeclaration[]): string {
  const rows = consumers.map(
    (consumer) => `  ${consumer.name} in ${consumer.file}: [${[...consumer.values].join(", ")}]`,
  );
  return [
    `tool categories examined ${authority.length} · consumers ${consumers.length}`,
    `  the Mod publishes (${SURFACE_ARTIFACT} equip_tool.argumentSchema.tool.enum): [${[...authority].join(", ")}]`,
    ...rows,
  ].join("\n");
}

test("every declaration of the tool vocabulary is the Mod's published set", () => {
  const authority = publishedToolCategories();
  const consumers = vocabularyDeclarations();

  assert.ok(
    authority.length > 8,
    `the \`equip_tool\` selector vocabulary must have been read (found [${authority.join(", ")}])`,
  );
  assert.ok(
    consumers.length >= 3,
    `every declaration of the vocabulary must have been found, and no declaration is not agreement: ${report(authority, consumers)}`,
  );
  assert.ok(
    consumers.some((consumer) => consumer.file.endsWith("host/src/protocol-target-facts.ts")),
    `the Host's own declaration must be in the population, which is what makes agreement mean something:\n${report(authority, consumers)}`,
  );

  const findings = consumers.flatMap((consumer) => vocabularyDisagreements(authority, consumer));
  assert.deepEqual(
    findings,
    [],
    `one tool category, one vocabulary:\n${findings.join("\n")}\n${report(authority, consumers)}`,
  );
});

test("the value the Host validates `equip_tool` and a tool slot with is that same set", () => {
  const authority = publishedToolCategories();
  assert.deepEqual(
    [...TOOL_CATEGORY_VALUES].sort(),
    [...authority].sort(),
    "`TOOL_CATEGORY_VALUES` is what `isToolSelector` refuses with `invalid_tool_selector` and what `isToolSlotFact` refuses" +
      " a snapshot with: a word it omits is a selector the Mod admits and the Host refuses, and a tool slot the Host" +
      ` closes the bridge over.\n${report(authority, vocabularyDeclarations())}`,
  );
});

/** The wire's contract for a tool slot's word: the authority, plus `unknown` for a tool the mapping has no word for. */
test("the wire schema admits every published category, and `unknown` beside them", () => {
  const authority = publishedToolCategories();
  const schema = schemaToolCategories();
  const missing = authority.filter((value) => !schema.includes(value));
  const invented = schema.filter((value) => !authority.includes(value));
  assert.deepEqual(
    { missing, invented },
    { missing: [], invented: [] },
    `${WIRE_SCHEMA} \`$defs.toolSlot.properties.category.enum\` is the language-neutral contract for the word the Mod` +
      ` publishes in \`toolSlots[].category\`; it may add \`unknown\` and nothing else.` +
      `\n  missing from the schema: [${missing.join(", ")}]` +
      `\n  in the schema only: [${invented.join(", ")}]` +
      `\n  the Mod publishes: [${authority.join(", ")}]` +
      `\n  the schema declares: [${schema.join(", ")}]`,
  );
});

/**
 * The falsifier: the comparison itself, driven with the drift this gate exists for, in BOTH directions.
 *
 * The population above is real, so a broken scan shows up as a missing consumer rather than as a comparison that
 * always answers "equal"; these two cases prove the answer moves when a member does.
 */
test("the comparison names the drifting member added on either side", () => {
  const real = vocabularyDeclarations();
  assert.ok(real.length >= 3, `the population must be real for the falsifier to mean anything:\n${report([], real)}`);

  const worseOnTheModSide = vocabularyDisagreements(["axe", "pickaxe", "sprinkler"], {
    file: "consumer.ts",
    name: "TOOL_CATEGORY_VALUES",
    values: ["axe", "pickaxe"],
  });
  assert.deepEqual(worseOnTheModSide.length, 1);
  assert.match(worseOnTheModSide[0]!, /consumer\.ts `TOOL_CATEGORY_VALUES` omits sprinkler/u);

  const worseOnTheHostSide = vocabularyDisagreements(["axe", "pickaxe"], {
    file: "consumer.ts",
    name: "TOOL_SELECTOR_VALUES",
    values: ["axe", "pickaxe", "hat"],
  });
  assert.deepEqual(worseOnTheHostSide.length, 1);
  assert.match(worseOnTheHostSide[0]!, /consumer\.ts `TOOL_SELECTOR_VALUES` publishes hat/u);
});
