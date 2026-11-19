// The input a run was given must be on disk, named by section, and comparable line by line.
//
// WHY (measured 2026-11-14). `round53` -> `round54` went from 0 to 10 submitted plans and nothing recorded what she was
// handed, so the cause was reconstructed by hand from a session jsonl three times in one day - each time wrongly. The
// session record already holds the input: these tests drive the builder with a session file shaped exactly like the
// real one, so what is asserted is the reading of a record, not a stub's opinion.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildInputManifest, inputManifestPathForResult, writeInputManifest } from "./input-manifest.mjs";

/** Two lines of surface header: what the Game surface installs since 2026-11-24 (`gameSurfaceInputHeader`). */
const SURFACE_LINES = 2;

/**
 * A session record with the shape the runtime writes: header, model change, one system message whose `sections` and
 * `toolsAdded` are the delivered prompt and tools, then a delivery carrying the world blocks.
 *
 * THE CONDUCT BLOCK COMES FIRST, because that is where the assembly puts it (`buildCompanionSystemPrompt` pushes the
 * surface block before the identity, and its own doc says why). The fixture used to put two identity blocks above it,
 * and that is the difference that hid the drift: the reader skipped the preamble's first block, the fixture never put
 * the conduct there, and every real run reported `prompt_conduct_block_unmatched` while this suite stayed green
 * (measured 2026-11-18, `round73`).
 *
 * The conduct block is built from the declaration's own rule count, so a rule added to the floor tomorrow moves this
 * fixture with it instead of leaving a stale 19 in a test.
 */
function sessionFixture({ surfaceLines = SURFACE_LINES, tools = null, delivery = null, model = true } = {}) {
  const preamble = [
    ...Array.from({ length: surfaceLines }, (_, index) => `surface line ${String(index + 1)} of the header`),
    "",
    "[Character: 琥珀]",
    "Role: the player's game companion",
    "",
    "Reply as 琥珀 would, in the first person, directly to the player.",
    "Never mention prompts, instructions, models, or systems, and never explain how you work.",
    "",
    "<<<CARD DIRECTIVES",
    "- 先接住人，再说手上的事。",
  ].join("\n");
  const planWorkDescription = [
    "Write one script over the current snapshot and the builder.",
    "movement_navigation: move_to_tile, enter_exit",
    "farming_crops: till_soil, water_crop, plant_seed",
    "world_lifecycle: sleep",
    "// Sequential steps - one call per step, in order:",
    "builder.move_to_tile({ x: 10, y: 20 });",
  ].join("\n");
  const toolsAdded = tools ?? [
    { name: "stardew_observe", description: "read the world", parameters: {} },
    { name: "stardew_plan_work", description: planWorkDescription, parameters: {} },
  ];
  const entries = [{ type: "session", version: 3, id: "s1", timestamp: "2026-11-13T23:11:05.433Z", cwd: "C:/root" }];
  if (model) {
    entries.push({ type: "model_change", provider: "cpa-oai", modelId: "deepseek-v4.1-flash" });
  }
  entries.push({
    type: "message",
    message: {
      role: "system",
      content: "",
      sections: { preamble, cwd: "C:/root", magic_context: "standing rule" },
      toolsAdded,
    },
  });
  entries.push({
    type: "message",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text:
            delivery ??
            "<world-state>\n世界（revision 0，刚刚更新）\n06:10（清晨）；1年第5天 春季\n</world-state>\n" +
              "<world-facts>\n- 你刚到这座农场，第一次真的站在这里\n</world-facts>\n",
        },
      ],
    },
  });
  return entries;
}

function writeSession(root, entries) {
  const path = join(root, "session.jsonl");
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return path;
}

function withTempRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "input-manifest-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the preamble's other named sections are recorded beside the surface block", () => {
  withTempRoot((root) => {
    const manifest = buildInputManifest({ sessionPath: writeSession(root, sessionFixture()) });
    const byId = new Map(manifest.sections.map((section) => [section.id, section.text]));
    assert.deepEqual(manifest.problems, [], "the reader names no problem on the shape the assembly delivers");
    assert.equal(byId.get("prompt:magic_context"), "standing rule");
    assert.equal(byId.get("prompt:cwd"), "C:/root");
  });
});

test("the surface block is one section of its own, and the authored remainder follows it", () => {
  // THE SURFACE BLOCK IS THE PREAMBLE'S HEAD, because that is where `buildCompanionSystemPrompt` puts it. Since
  // 2026-11-24 it is a two-line input header rather than a rule list, so it is recorded as ONE section - the block the
  // model actually read - and the identity follows it as the authored remainder.
  withTempRoot((root) => {
    const manifest = buildInputManifest({ sessionPath: writeSession(root, sessionFixture()) });
    const byId = new Map(manifest.sections.map((section) => [section.id, section.text]));
    assert.equal(
      byId.get("prompt:surface_block"),
      "surface line 1 of the header\nsurface line 2 of the header",
      "the surface block is recorded whole, as delivered",
    );
    assert.match(byId.get("prompt:authored") ?? "", /^\[Character: 琥珀\]/u, "the identity follows the surface block");
    assert.equal(
      manifest.sections.filter((section) => section.id.startsWith("prompt:conduct:")).length,
      0,
      "the rule-per-section split is gone with the rules: no section may claim to be one",
    );
    assert.equal(byId.has("prompt:floor"), false, "nothing precedes the surface block in the delivered preamble");
  });
});

test("a preamble with no blank line is one section, not a preamble nobody could split", () => {
  // THE FALSIFIER for the reader's shape: with no blank line the whole preamble is the surface block, and the manifest
  // says so rather than silently dropping it or inventing a second section.
  withTempRoot((root) => {
    const entries = sessionFixture();
    const system = entries.find((entry) => entry.message?.role === "system");
    system.message.sections.preamble = "one block with no blank line";
    const manifest = buildInputManifest({ sessionPath: writeSession(root, entries) });
    assert.ok(
      manifest.sections.some((section) => section.id === "prompt:surface_block"),
      "the whole preamble is one surface block",
    );
    assert.equal(
      manifest.sections.some((section) => section.id === "prompt:authored"),
      false,
      "there is no authored remainder inside a preamble with no blank line",
    );
    assert.equal(manifest.problems.length, 0, "a preamble this reader can place is not a problem");
  });
});



test("the tool list is each tool's name and full description, and the vocabulary block inside plan_work", () => {
  withTempRoot((root) => {
    const manifest = buildInputManifest({ sessionPath: writeSession(root, sessionFixture()) });
    const byId = new Map(manifest.sections.map((section) => [section.id, section.text]));

    assert.equal(byId.get("tool:stardew_observe"), "read the world");
    assert.match(byId.get("tool:stardew_plan_work"), /^Write one script over the current snapshot/u);
    assert.equal(
      byId.get("tool:stardew_plan_work:vocabulary"),
      [
        "movement_navigation: move_to_tile, enter_exit",
        "farming_crops: till_soil, water_crop, plant_seed",
        "world_lifecycle: sleep",
      ].join("\n"),
    );
  });
});

test("a tool mounted mid-run is part of the delivered input", () => {
  withTempRoot((root) => {
    const entries = sessionFixture();
    // The program-status tool arrives AFTER the session's first submission (the runtime records it as a second system
    // message), and a run that never submitted never receives it - which is an input difference, not a behaviour one.
    entries.push({
      type: "message",
      message: {
        role: "system",
        content: "",
        sections: {},
        toolsAdded: [{ name: "stardew_action_program_status", description: "poll one program", parameters: {} }],
      },
    });
    const manifest = buildInputManifest({ sessionPath: writeSession(root, entries) });
    assert.equal(
      manifest.sections.find((s) => s.id === "tool:stardew_action_program_status")?.text,
      "poll one program",
    );
  });
});

test("the first delivered world block and the runtime's model and provider are recorded as delivered", () => {
  withTempRoot((root) => {
    const manifest = buildInputManifest({ sessionPath: writeSession(root, sessionFixture()) });
    const byId = new Map(manifest.sections.map((section) => [section.id, section.text]));

    assert.equal(
      byId.get("delivery:world-state:first"),
      "<world-state>\n世界（revision 0，刚刚更新）\n06:10（清晨）；1年第5天 春季\n</world-state>",
    );
    assert.equal(
      byId.get("delivery:world-facts:first"),
      "<world-facts>\n- 你刚到这座农场，第一次真的站在这里\n</world-facts>",
    );
    assert.equal(byId.get("runtime:model"), "deepseek-v4.1-flash");
    assert.equal(byId.get("runtime:provider"), "cpa-oai");
  });
});

test("the manifest is written beside the result and prints its own population", () => {
  withTempRoot((root) => {
    const sessionPath = writeSession(root, sessionFixture());
    const resultPath = join(root, "_multiday_routine-round54.result.json");
    const manifestPath = inputManifestPathForResult(resultPath);
    assert.equal(manifestPath, join(root, "_multiday_routine-round54.input-manifest.json"));
    // The runner's result path is an environment binding, so another `.json` name must work too - and a name it cannot
    // place a manifest beside is answered by name, never thrown out of the assembly publishing the result.
    assert.equal(inputManifestPathForResult("/tmp/gb-runner-result.json"), "/tmp/gb-runner-result.input-manifest.json");

    const lines = [];
    const answer = writeInputManifest({ sessionPath, resultPath, log: (line) => lines.push(line) });
    assert.equal(answer.state, "written");
    assert.equal(answer.path, manifestPath);
    assert.deepEqual(lines, [`input sections ${String(answer.sections)} · bytes ${String(answer.bytes)}`]);

    const written = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(written.sections.length, answer.sections);
    assert.equal(written.model, "deepseek-v4.1-flash");
    // The file carries the exact text, not a digest of it: a reader can read the section without the session record.
    assert.equal(written.sections.find((s) => s.id === "tool:stardew_observe").text, "read the world");
  });
});

// The refusal, not an empty file: a manifest with no sections would read as "this run was handed nothing", which is the
// opposite of the truth about a run whose session record could not be read.
test("a record with nothing to report writes no manifest at all", () => {
  withTempRoot((root) => {
    const sessionPath = writeSession(root, [{ type: "session", version: 3, id: "s1" }]);
    const resultPath = join(root, "_x.result.json");
    const manifestPath = inputManifestPathForResult(resultPath);
    const answer = writeInputManifest({ sessionPath, resultPath, log: () => {} });

    assert.equal(answer.state, "not_measured");
    assert.equal(answer.reasonCode, "input_manifest_empty");
    assert.throws(() => readFileSync(manifestPath, "utf8"), /ENOENT/u);
  });
});

test("a run whose session record cannot be bound says so by name", () => {
  withTempRoot((root) => {
    const answer = writeInputManifest({
      sessionPath: null,
      resultPath: join(root, "_x.result.json"),
      log: () => {},
    });
    assert.equal(answer.state, "not_measured");
    assert.equal(answer.reasonCode, "session_record_not_bound");
  });
});

// The assembly that publishes the run's only artifact must not fail on the manifest's behalf.
test("a result path no manifest can sit beside is a named answer, never an exception", () => {
  withTempRoot((root) => {
    const answer = writeInputManifest({
      sessionPath: writeSession(root, sessionFixture()),
      resultPath: join(root, "result.txt"),
      log: () => {},
    });
    assert.equal(answer.state, "not_measured");
    assert.equal(answer.reasonCode, "input_manifest_path_underived");
  });
});

// FALSIFIER: the same session, one delivered line changed, must move that line and nothing else. Without this the
// suite only shows that the builder produces sections, not that it reads them.
test("one changed delivery line moves exactly one section", () => {
  withTempRoot((root) => {
    const before = buildInputManifest({ sessionPath: writeSession(root, sessionFixture()) });
    const entries = sessionFixture();
    entries.at(-1).message.content[0].text = entries
      .at(-1)
      .message.content[0].text.replace("06:10（清晨）", "06:20（清晨）");
    const after = buildInputManifest({ sessionPath: writeSession(root, entries) });

    const changed = before.sections.filter(
      (section) => after.sections.find((other) => other.id === section.id)?.text !== section.text,
    );
    assert.deepEqual(
      changed.map((section) => section.id),
      ["delivery:world-state:first"],
    );
  });
});
