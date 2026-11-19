import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { COMPANION_ARCHIVE_TOOL_DESCRIPTIONS } from "./companion-archive-tool-descriptions.js";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { type CompanionIdentity, createCompanionRuntime } from "./runtime.js";
import {
  assertToolSurface,
  type CompanionSurface,
  DENIED_TOOL_CLASSES,
  PERMITTED_TOOL_CLASSES,
  planToolSurface,
  TOOL_CAPABILITY_CLASSES,
  type ToolCapabilityClass,
  toolClassOf,
} from "./tool-surface.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

/**
 * The tool surface is decided by CLASS, not by a list of names.
 *
 * <p>
 * What these tests protect, measured before the change on the shipped product: the Game surface mounted exactly
 * one tool, `companion_status`, while the Magic Context extension it loads had registered `ctx_search`,
 * `ctx_expand`, `ctx_note`, `ctx_memory` and `ctx_reduce` with the loader. The reachability of a read-only
 * session tool depended on a hand-kept name list in a file far from where the tool was defined, and adding a
 * name nothing mounted threw `Companion tool isolation failed: expected companion_status, delegate_game_task,
 * got companion_status.` - the list and the session could only ever be compared, never explained.
 * </p>
 *
 * <p>
 * The population of every assertion below is derived: the classes come from the module's own union, the tools
 * from the loader's provenance and from the compositions that assemble them, and the mounted set from a real
 * session's `agent.state.tools`. No test writes a tool name that the product did not first hand it.
 * </p>
 */

bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());

const identity: CompanionIdentity = Object.freeze({
  continuityId: "continuity_tool_surface",
  playerId: "player_tool_surface",
  saveId: "save_tool_surface",
  worldId: "world_tool_surface",
  companionId: "companion_tool_surface",
});

/** A fixture tool: the shape only, no behaviour, because what is asserted here is reach, not execution. */
function fixtureTool(name: string): ToolDefinition {
  return defineTool({
    name,
    label: name,
    description: `${name} fixture`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text" as const, text: "fixture" }], details: {} }),
  });
}

/**
 * One inline extension, loaded the way the Host loads the turn-header extension: a factory, not a path, so the
 * test needs no build output. Its tools are the fixture's, and the loader reports the same provenance a real
 * extension would.
 */
async function loadFixtureExtension(
  root: string,
  name: string,
  toolNames: readonly string[],
): Promise<{ loader: DefaultResourceLoader; settingsManager: SettingsManager }> {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "tool surface fixture",
    appendSystemPrompt: [],
    extensionFactories: [
      {
        name,
        hidden: true,
        factory: (pi) => {
          for (const toolName of toolNames) pi.registerTool(fixtureTool(toolName));
        },
      },
    ],
  });
  await loader.reload();
  return { loader, settingsManager };
}

/** What the loader registered, in the one shape the plan reads: the extension entry and its tool names. */
function registeredExtensionTools(loader: DefaultResourceLoader) {
  return loader.getExtensions().extensions.map((extension) => ({
    entry: extension.path,
    tools: [...extension.tools.keys()],
  }));
}

/** One temporary runtime root, cleaned up whatever the case does. */
async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-tool-surface-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

test("every capability class is either permitted on a surface or denied, and no class is both", () => {
  // The population is the module's own union, so a class added to the vocabulary must be classified rather than
  // silently join neither set (a class nothing denies would then be mountable by omission). Game is the surface that
  // exposes every non-denied capability, so it is the one that must account for all of them.
  const denied = new Set<ToolCapabilityClass>(DENIED_TOOL_CLASSES);
  for (const surface of ["game", "chat"] as const satisfies readonly CompanionSurface[]) {
    const permitted = PERMITTED_TOOL_CLASSES[surface];
    const both = permitted.filter((toolClass) => denied.has(toolClass));
    assert.deepEqual(both, [], `the ${surface} surface permits a denied class: ${both.join(", ")}`);
  }
  const game = PERMITTED_TOOL_CLASSES.game;
  const unclassified = TOOL_CAPABILITY_CLASSES.filter(
    (toolClass) => !(game.includes(toolClass) || denied.has(toolClass)),
  );
  assert.deepEqual(
    unclassified,
    [],
    `these classes are neither permitted on the Game surface nor denied, so a tool of that class would mount by omission: ${unclassified.join(", ")}`,
  );
  assert.deepEqual([...PERMITTED_TOOL_CLASSES.chat], ["host_control"], "Chat is a pure dialogue surface");
  // Game is the play surface: the world, its authored context, the program surface, its own archive, and status.
  assert.deepEqual([...game].sort(), ["game_action", "host_control", "program", "session_inspection", "world_context"]);
});

test("a read-only extension tool mounts on the Game surface by class, with no name anywhere", async () => {
  await withRoot(async (root) => {
    const { loader, settingsManager } = await loadFixtureExtension(root, "fixture-archive", ["notes_lookup"]);
    const statusTool = fixtureTool("companion_status");
    const plan = planToolSurface({
      surface: "game",
      groups: [{ toolClass: "host_control", tools: [statusTool] }],
      extensions: [{ entry: "<inline:fixture-archive>", toolClass: "session_inspection" }],
      registered: registeredExtensionTools(loader),
    });
    assert.deepEqual([...plan.mounted], ["companion_status", "notes_lookup"]);
    assert.equal(toolClassOf(plan, "notes_lookup"), "session_inspection");

    // The product's next step, unchanged: the plan IS the provider allowlist, and Pi mounts what it names.
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: join(root, "agent"),
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.create(root, join(root, "sessions")),
      noTools: "all",
      tools: [...plan.mounted],
      customTools: [statusTool],
    });
    try {
      const mounted = session.agent.state.tools.map((tool) => tool.name).sort();
      assert.deepEqual(
        mounted,
        [...plan.mounted],
        "a read-only extension tool must mount without an edit to the runtime that mounts it",
      );
      assertToolSurface(plan, mounted);
    } finally {
      session.dispose();
    }
  });
});

test("an extension the Host never declared is refused by its own entry, not mounted as untrusted unknowns", async () => {
  await withRoot(async (root) => {
    const { loader } = await loadFixtureExtension(root, "fixture-undeclared", ["notes_lookup", "shell_exec"]);
    assert.throws(
      () =>
        planToolSurface({
          surface: "game",
          groups: [{ toolClass: "host_control", tools: [fixtureTool("companion_status")] }],
          extensions: [],
          registered: registeredExtensionTools(loader),
        }),
      /companion_extension_tool_class_undeclared:<inline:fixture-undeclared>:notes_lookup,shell_exec/u,
      "an extension's tools may only reach a surface through a class the Host declared for that extension",
    );
  });
});

test("a mounted tool no source declared is refused by name and class", () => {
  const plan = planToolSurface({
    surface: "game",
    groups: [{ toolClass: "host_control", tools: [fixtureTool("companion_status")] }],
    extensions: [],
    registered: [],
  });
  assert.equal(toolClassOf(plan, "shell_exec"), "unknown");
  assert.throws(
    () => assertToolSurface(plan, ["companion_status", "shell_exec"]),
    /shell_exec \(class unknown\)/u,
    "a tool nothing classified is refused by name and class, never mounted because nobody recognised it",
  );
});

test("a shell-class extension is refused on both surfaces, and the failure says why", async () => {
  await withRoot(async (root) => {
    const { loader } = await loadFixtureExtension(root, "fixture-shell", ["shell_exec"]);
    for (const surface of ["game", "chat"] as const satisfies readonly CompanionSurface[]) {
      const plan = planToolSurface({
        surface,
        groups: [],
        extensions: [{ entry: "<inline:fixture-shell>", toolClass: "shell" }],
        registered: registeredExtensionTools(loader),
      });
      assert.deepEqual([...plan.mounted], [], `the ${surface} surface must not offer a shell to the model`);
      assert.throws(
        () => assertToolSurface(plan, ["shell_exec"]),
        /denied class mounted: shell_exec \(class shell\)/u,
        `the ${surface} surface's refusal must name the tool and the class that disqualified it`,
      );
    }
  });
});

test("a Host tool is classified by the group its composition declares, so a new one needs no list", () => {
  const plan = planToolSurface({
    surface: "game",
    groups: [
      { toolClass: "game_action", tools: [fixtureTool("world_act"), fixtureTool("world_observe")] },
      { toolClass: "program", tools: [fixtureTool("plan_work")] },
      { toolClass: "world_context", tools: [fixtureTool("worldbook_query")] },
      { toolClass: "host_control", tools: [fixtureTool("companion_status")] },
    ],
    extensions: [],
    registered: [],
  });
  assert.deepEqual(
    [...plan.mounted],
    ["companion_status", "plan_work", "world_act", "world_observe", "worldbook_query"],
  );
  assert.deepEqual(
    [...plan.mounted].map((name) => toolClassOf(plan, name)),
    ["host_control", "program", "game_action", "game_action", "world_context"],
  );
});

test("two sources cannot hand the surface one name, and the collision is refused rather than collapsed", () => {
  assert.throws(
    () =>
      planToolSurface({
        surface: "game",
        groups: [
          { toolClass: "game_action", tools: [fixtureTool("world_act")] },
          { toolClass: "host_control", tools: [fixtureTool("world_act")] },
        ],
        extensions: [],
        registered: [],
      }),
    /runtime_tool_name_collision:world_act/u,
  );
});

test("the real Game surface mounts its session archive, and no denied class among its tools", async () => {
  await withRoot(async (root) => {
    const runtime = await createCompanionRuntime(
      identity,
      root,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      "game_tool_surface_01",
      undefined,
      "game",
    );
    try {
      const mounted = runtime.session.agent.state.tools.map((tool) => tool.name).sort();
      const classes = Object.fromEntries(mounted.map((name) => [name, toolClassOf(runtime.toolSurface, name)]));
      const present = [...new Set(Object.values(classes))].sort();
      console.log(`tool-surface: mounted ${mounted.length}, classes present ${JSON.stringify(present)}`);

      // The defect this replaces: the extension registers ctx_search/ctx_expand for EVERY runtime, and the
      // allowlist dropped them, so a compacted companion could not read its own history.
      for (const name of ["ctx_search", "ctx_expand"])
        assert.ok(mounted.includes(name), `the Game surface must mount ${name}; mounted: ${mounted.join(", ")}`);

      // The property, not a member list: what mounted carries a permitted class, and no denied class mounted.
      const deniedMounted = mounted.filter((name) => DENIED_TOOL_CLASSES.includes(classes[name] as never));
      assert.deepEqual(
        deniedMounted,
        [],
        `denied classes are mounted on the Game surface: ${deniedMounted.join(", ")}`,
      );
      const notPermitted = mounted.filter(
        (name) => !PERMITTED_TOOL_CLASSES.game.includes(classes[name] as ToolCapabilityClass),
      );
      assert.deepEqual(
        notPermitted,
        [],
        `the Game surface mounted tools it does not permit: ${notPermitted.join(", ")}`,
      );

      // Nothing planned went silently missing: the decision the runtime recorded and the session Pi returned agree.
      assert.deepEqual(mounted, [...runtime.toolSurface.mounted]);
    } finally {
      runtime.session.dispose();
    }
  });
});

test("the Chat surface stays a dialogue surface: the same extension's tools do not mount", async () => {
  await withRoot(async (root) => {
    const runtime = await createCompanionRuntime(
      identity,
      root,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      "chat_tool_surface_01",
      undefined,
      "chat",
    );
    try {
      assert.deepEqual(runtime.session.agent.state.tools, []);
      assert.deepEqual([...runtime.toolSurface.mounted], []);
    } finally {
      runtime.session.dispose();
    }
  });
});

/**
 * The fingerprint of a class-keyed wording: two tools of one class carrying the SAME description.
 *
 * A description belongs to the tool, so two tools that share one are evidence that something above them wrote it - which
 * is exactly what the deleted override did, and why the property can be read without this file quoting a sentence.
 * Exported so the falsifier drives the SAME reading over a mounted set the product does not build.
 */
export function sharedDescriptionsOf(
  byClass: ReadonlyMap<string, readonly { name: string; description: string }[]>,
): readonly string[] {
  const shared: string[] = [];
  for (const [toolClass, tools] of byClass)
    for (const [index, tool] of tools.entries())
      for (const other of tools.slice(index + 1))
        if (tool.description === other.description)
          shared.push(`${toolClass}: ${tool.name} and ${other.name} carry one description`);
  return shared;
}

/**
 * NO SURFACE GIVES A WHOLE CLASS ONE WORDING, AND THIS IS THE READING THAT KEEPS IT SO.
 *
 * <p>
 * The Game surface used to replace every session-inspection tool's description with one hand-written paragraph, keyed by
 * capability class - because the Magic Context extension writes for a coding agent, and the Game surface is where a
 * farmhand who has just forgotten her own morning reads it.
 * </p>
 *
 * <p>
 * The paragraph was refused rather than derived. What it claimed the tools already declare: `ctx_search`'s own
 * description states the phrasing hint, and `ctx_expand`'s parameters state the tag-versus-ordinal distinction. Keyed by
 * class, it also rewrote tools its author never saw: a tool the extension registered tomorrow arrived carrying a
 * sentence written before it existed, and nothing in the tree could notice.
 * </p>
 *
 * <p>
 * WHAT REPLACED IT IS THE OPPOSITE POLICY AND IS TESTED BESIDE IT: `companion-archive-tool-descriptions.ts` names TWO
 * tools, gives each its own sentence, and its subject is this surface's memory. So this case asserts both halves - a
 * class still shares no wording, and a projection that names a tool really IS the wording that tool mounts - and a name
 * the table does not carry keeps the extension's own words.
 * </p>
 *
 * <p>
 * The population is a real session's mounted tools, grouped by the plan's own classes, and the case is BLOCKED rather
 * than green when no class mounts two tools.
 * </p>
 */
test("each mounted tool carries its own words, not its class's", async () => {
  await withRoot(async (root) => {
    const runtime = await createCompanionRuntime(
      identity,
      root,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      "game_tool_descriptions_unrewritten",
      undefined,
      "game",
    );
    try {
      const mounted = runtime.session.agent.state.tools;
      const byClass = new Map<string, { name: string; description: string }[]>();
      for (const tool of mounted) {
        const toolClass = toolClassOf(runtime.toolSurface, tool.name);
        const held = byClass.get(toolClass) ?? [];
        held.push({ name: tool.name, description: tool.description });
        byClass.set(toolClass, held);
      }
      const multiToolClasses = [...byClass.entries()].filter(([, tools]) => tools.length >= 2);
      // Zero population is BLOCKED: with no class mounting two tools, "a class shares one wording" would be an
      // assertion over nothing.
      assert.ok(
        multiToolClasses.length > 0,
        `no class mounts two tools, so 'a class shares one wording' was never measured: ${[...byClass.entries()]
          .map(([toolClass, tools]) => `${toolClass} ${String(tools.length)}`)
          .join(", ")}`,
      );
      const shared = sharedDescriptionsOf(byClass);
      assert.deepEqual(
        shared,
        [],
        "a class that shares one description was given it from above: a tool's words are its own registration's",
      );
      // The archive family is the class this whole case is about, and it has to be mounted for the reading to mean
      // anything at all.
      const inspection = byClass.get("session_inspection") ?? [];
      assert.ok(
        inspection.length >= 2,
        `the Game surface mounts the session inspection family: ${inspection.map((tool) => tool.name).join(", ")}`,
      );
      // THE OTHER HALF: WHERE THE PROJECTION NAMES A TOOL, THE MOUNTED DEFINITION IS THE PROJECTION'S - and where it does
      // not, the tool kept the words its extension registered. That is what separates a named per-tool projection from
      // the class-keyed override the case above refuses.
      const projected = inspection.filter((tool) => Object.hasOwn(COMPANION_ARCHIVE_TOOL_DESCRIPTIONS, tool.name));
      assert.deepEqual(
        projected.map((tool) => tool.name).sort(),
        Object.keys(COMPANION_ARCHIVE_TOOL_DESCRIPTIONS).sort(),
        "the projection and the mounted set disagree about which archive tools carry this surface's words",
      );
      for (const tool of projected) {
        const entry = COMPANION_ARCHIVE_TOOL_DESCRIPTIONS[tool.name]!;
        assert.equal(tool.description, entry.description, `${tool.name} does not carry the projection's sentence`);
        assert.ok(
          entry.why.trim().split(/\s+/u).length >= 8,
          `${tool.name} is projected without a stated reason: a third name has to say what it is doing on this surface`,
        );
      }
      process.stdout.write(
        `mounted tools examined ${String(mounted.length)} · classes with two or more ${String(multiToolClasses.length)} · session_inspection ${String(inspection.length)} · projected ${String(projected.length)} · shared descriptions ${String(shared.length)}\n`,
      );
    } finally {
      runtime.session.dispose();
    }
  });
});

test("the reading reds when a class is given one wording", () => {
  // THE FALSIFIER. The same reading, over a mounted set the product does not build: the deleted override gave every tool
  // of the class one paragraph, which is exactly the shape below.
  assert.deepEqual(
    sharedDescriptionsOf(
      new Map([
        [
          "session_inspection",
          [
            { name: "ctx_search", description: "Your own earlier turns, read back from the archive." },
            { name: "ctx_expand", description: "Your own earlier turns, read back from the archive." },
          ],
        ],
      ]),
    ),
    ["session_inspection: ctx_search and ctx_expand carry one description"],
    "two tools handed one wording must red, or the case above is decoration",
  );
  // And the same reading over two tools that say different things must stay green: a reading that reds everything is as
  // useless as one that reds nothing.
  assert.deepEqual(
    sharedDescriptionsOf(
      new Map([
        [
          "session_inspection",
          [
            { name: "ctx_search", description: "Search the archive." },
            { name: "ctx_expand", description: "Recover original content." },
          ],
        ],
      ]),
    ),
    [],
  );
  // A class with one tool has nothing to compare, which is why the case above is blocked rather than passed when no class
  // mounts two.
  assert.deepEqual(
    sharedDescriptionsOf(new Map([["host_control", [{ name: "companion_status", description: "status" }]]])),
    [],
  );
});
