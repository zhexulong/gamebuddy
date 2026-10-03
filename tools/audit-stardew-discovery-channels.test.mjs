import assert from "node:assert/strict";
import test from "node:test";
import { auditDiscoveryChannels } from "./audit-stardew-discovery-channels.mjs";

// A real target-bearing action, used so the audit's declared-field table
// resolves exactly as it does in production.
const ACTION = "harvest_crop";
const FIELD = "harvestTargets";
const MODEL = "IReadOnlyList<BridgeHarvestTarget>? HarvestTargets,";
const PROTOCOL = "harvestTargets?: readonly Readonly<{ targetId: string }>[];";
const TOOL_DESC_OK = `Copied from the ${FIELD} entries of the most recent observe.`;
const TOOL_DESC_WRONG = "Copied from the recipeTargets entries of the most recent observe.";

function surface() {
  return {
    actions: [
      {
        actionId: ACTION,
        lifecycle: "published",
        kind: "execution",
        argumentSchema: { x: "integer", y: "integer", expectedTargetId: "string" },
      },
    ],
  };
}
function tool(description) {
  // Constant-mount shape (36608fa): the tool is mounted unconditionally; its
  // `action` id must be followed by `toArgs`, and the description precedes the
  // parameter schema exactly as in production. The description prose below is
  // what the audit reads for the named-target-field check.
  return `makeGameActionTool({
   name: "stardew_${ACTION}",
   description:
    "${description}",
   parameters: {},
   action: "${ACTION}",
   toArgs: `;
}
function schemaWith(properties) {
  return { $defs: { snapshot: { properties } } };
}

test("the committed action surface has a complete discovery chain", () => {
  const report = auditDiscoveryChannels();
  assert.deepEqual(
    report.gaps.filter((gap) => gap.gap !== "tool_does_not_name_target_field"),
    [],
    "every target-bearing action must have an Agent tool and a real Mod/Host/schema field",
  );
  assert.ok(report.actionCount > 0);
  assert.ok(report.targetBearingCount > 0);
});

test("the audit reports one hole per broken layer rather than passing silently", () => {
  // 1. A missing envelope-schema entry must be caught: the schema has
  //    additionalProperties:false, so an undeclared field cannot be shipped.
  const noSchema = auditDiscoveryChannels({
    surface: surface(),
    models: MODEL,
    protocol: PROTOCOL,
    schema: schemaWith({}),
    gameTools: tool(TOOL_DESC_OK),
  });
  assert.deepEqual(
    noSchema.gaps.map((gap) => gap.gap),
    ["missing_envelope_schema_field"],
    "the schema leg must not be assumed from the Mod and Host legs",
  );

  // 2. A tool whose prose names a field that does not exist must be caught:
  //    this is exactly the craft_item/cook_recipe `recipeTargets` drift.
  const wrongName = auditDiscoveryChannels({
    surface: surface(),
    models: MODEL,
    protocol: PROTOCOL,
    schema: schemaWith({ [FIELD]: {} }),
    gameTools: tool(TOOL_DESC_WRONG),
  });
  assert.equal(wrongName.ok, false);
  assert.ok(
    wrongName.gaps.some((gap) => gap.gap.startsWith("tool_names_wrong_field:")),
    "a description that points at a non-existent field must be reported",
  );

  // 3. A missing Mod wire field must be caught even when Host and schema agree.
  const noMod = auditDiscoveryChannels({
    surface: surface(),
    models: "// no such list",
    protocol: PROTOCOL,
    schema: schemaWith({ [FIELD]: {} }),
    gameTools: tool(TOOL_DESC_OK),
  });
  assert.deepEqual(
    noMod.gaps.map((gap) => gap.gap),
    ["missing_mod_wire_field"],
  );

  // 4. A missing Agent tool must be caught.
  const noTool = auditDiscoveryChannels({
    surface: surface(),
    models: MODEL,
    protocol: PROTOCOL,
    schema: schemaWith({ [FIELD]: {} }),
    gameTools: "// no makeGameActionTool mount at all",
  });
  assert.ok(noTool.gaps.some((gap) => gap.gap === "no_agent_tool"));

  // 5. A fully wired action passes, so the audit is not vacuously failing.
  const wired = auditDiscoveryChannels({
    surface: surface(),
    models: MODEL,
    protocol: PROTOCOL,
    schema: schemaWith({ [FIELD]: {} }),
    gameTools: tool(TOOL_DESC_OK),
  });
  assert.equal(wired.ok, true, JSON.stringify(wired.gaps));
});
