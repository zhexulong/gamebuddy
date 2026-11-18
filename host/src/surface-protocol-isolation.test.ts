import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildGameCompanionSystemPrompt } from "./game-surface-prompt-floor.js";
import { MOUNTED_GAME_SURFACE_TOOL_NAMES } from "./game-surface-prompt-floor.test-support.js";
import { buildChatCompanionSystemPrompt } from "./companion-prompt-assembly.js";
import { CHAT_SURFACE_DIVERGENCE, COMPANION_ACTION_SYNTAX } from "./chat-surface-block.js";
import { DEFAULT_COMPANION_PRESET } from "./tavern/default-companion-preset.js";
import { PERMITTED_TOOL_CLASSES, planToolSurface } from "./tool-surface.js";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { createCompanionRuntime, resolveRuntimePaths } from "./runtime.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());

/**
 * The harness plugin this product vendors, whose sections and tools must stay on the runtime that owns them.
 *
 * <p>
 * Resolved from this file's own location so the walk cannot pick up a user Pi installation's copy, exactly as
 * `resolveMagicContextExtensionEntry` does. The GATE below reads the vendor's SOURCE rather than a list kept here: a
 * section the extension starts injecting tomorrow, and a `ctx_*` name it starts registering tomorrow, arrive in the
 * population with no edit to this file.
 * </p>
 */
const VENDOR_PI_PLUGIN_SOURCE = (() => {
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return join(repositoryRoot, "vendor", "magic-context", "packages", "pi-plugin", "src");
})();

/** Every non-test source file of the vendored extension, in a stable order. */
function vendorSources(root: string = VENDOR_PI_PLUGIN_SOURCE): readonly Readonly<{ path: string; text: string }>[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) files.push(path);
    }
  };
  walk(root);
  return files
    .sort()
    .map((path) =>
      Object.freeze({ path: path.slice(root.length + 1).replace(/\\/gu, "/"), text: readFileSync(path, "utf8") }),
    );
}

/**
 * The system-prompt sections the harness writes, each with the file that writes it.
 *
 * <p>
 * `hostSections`, `sections` and `promptSections` are the three names the extension's own `before_agent_start` hands its
 * block to; `length` is excluded because it is a property read, not a section, and a gate whose population carries a
 * non-member reports a finding nobody can fix.
 * </p>
 */
function harnessSectionsOf(
  sources: readonly Readonly<{ path: string; text: string }>[],
): readonly Readonly<{ name: string; writer: string }>[] {
  const found: { name: string; writer: string }[] = [];
  for (const source of sources)
    for (const match of source.text.matchAll(/(?:hostSections|sections|promptSections)\.([a-z][a-z0-9_]*)\s*=/gu)) {
      const name = match[1] ?? "";
      if (name.length === 0 || name === "length") continue;
      if (!found.some((entry) => entry.name === name && entry.writer === source.path))
        found.push({ name, writer: source.path });
    }
  return Object.freeze(found.map((entry) => Object.freeze(entry)));
}

/**
 * The tool names the harness registers, read out of its own literals rather than listed here.
 *
 * <p>
 * Restricted to the registration module's own directory: the extension's other files mention `ctx_*` names in prose and
 * in operation arguments (`ctx_memory_list` is a parameter value, not a tool), and a population that carried those would
 * report findings nobody can fix. `tools/` is where `pi.registerTool` is called, so that is where a registered tool name
 * is a fact.
 * </p>
 */
function harnessToolNamesOf(sources: readonly Readonly<{ path: string; text: string }>[]): readonly string[] {
  const names = new Set<string>();
  for (const source of sources) {
    if (!source.path.startsWith("tools/")) continue;
    for (const match of source.text.matchAll(/["'`](ctx_[a-z_]+)["'`]/gu)) names.add(match[1] ?? "");
  }
  return Object.freeze([...names].filter((name) => name.length > 0).sort());
}

/**
 * The markup the harness opens around its own text, read off its source: every value it writes as a wrapper token.
 *
 * `<system-reminder>` is the one this product has measured arriving inside a Game tool result (`round75` rec#142): the
 * harness's context-hygiene nudge, which the companion answered with a `ctx_reduce` turn of the game's own (rec#143).
 */
function harnessMarkersOf(sources: readonly Readonly<{ path: string; text: string }>[]): readonly string[] {
  const markers = new Set<string>();
  for (const source of sources)
    for (const match of source.text.matchAll(/["'`](<(?:system-reminder|[a-z-]+)>)["'`]/gu)) {
      const marker = match[1] ?? "";
      if (marker.length > 0) markers.add(marker);
    }
  return Object.freeze([...markers].sort());
}

/**
 * A surface's own protocol must stay on that surface.
 *
 * The measured defect: the shipped card carried "打字里不用星号或括号写风景…交给游戏里那个身体
 * (stardew_express_emote / stardew_face_direction)" as a CHARACTER bullet, so the compiled Chat
 * prompt received the Game surface's channel rule verbatim - and a prohibition that speaks last is
 * the rule. A reporter measured `em.message-action` at 0 on Web Chat: the companion had stopped
 * writing the one syntax the Chat renderer draws.
 *
 * What is asserted here is the NEGATIVE, and its population is derived rather than listed:
 *
 *   - the mounted Game tool names are the recorded mounted set (`MOUNTED_GAME_SURFACE_TOOL_NAMES`), because the
 *     live Game surface mounts the plan builder and drops every per-action tool the adapter publishes - resolving
 *     against `STARDEW_ACTION_TOOL_NAMES` here agreed with a conduct that named `stardew_express_emote`, a tool
 *     the request never carried (measured 2026-11-11, `round46b`);
 *   - the "channel rule" lines come from the COMPILED Game prompt, so a reworded rule is still
 *     covered and a deleted one fails the first test instead of passing this one quietly;
 *   - the stage-direction mark comes from `COMPANION_ACTION_SYNTAX`, the one constant that names
 *     the syntax, so a change of syntax follows.
 *
 * The profile is the SHIPPED card (`DEFAULT_COMPANION_PRESET`), not the bare default profile: this
 * defect was card-borne, and a gate compiled from an empty persona could not have seen it.
 */

const LOCALE = "zh-CN";

/** The compiled prompts, from the product's own builders, over the companion that actually ships. */
const CHAT_PROMPT = buildChatCompanionSystemPrompt(DEFAULT_COMPANION_PRESET.profile, LOCALE);
const GAME_PROMPT = buildGameCompanionSystemPrompt(DEFAULT_COMPANION_PRESET.profile, LOCALE);

/** Every tool name the live Game surface mounts: the recorded set, not the per-action projection it drops. */
const MOUNTED_GAME_TOOL_NAMES: readonly string[] = MOUNTED_GAME_SURFACE_TOOL_NAMES;

/**
 * The mark `COMPANION_ACTION_SYNTAX` delimits a stage direction with, read out of the constant.
 *
 * The syntax is `*a brief gesture*`, so the mark is whatever character wraps its example. Reading
 * it rather than writing `*` here is what keeps this gate on the day the syntax changes.
 */
const STAGE_DIRECTION_MARK: string = COMPANION_ACTION_SYNTAX.slice(0, 1);

/** The mounted Game tool names one text mentions. */
function toolNamesIn(text: string): readonly string[] {
  return MOUNTED_GAME_TOOL_NAMES.filter((name) => text.includes(name));
}

/**
 * A compiled prompt's sentences.
 *
 * Sentence granularity is the unit a rule travels in, and it is also the only granularity these two
 * blocks share: the Game conduct is joined with newlines and the Chat block with spaces, so a
 * line-for-line comparison could never match and would report clean forever. A rule copied from one
 * surface to the other arrives as a sentence either way.
 */
function sentences(text: string): readonly string[] {
  const out: string[] = [];
  for (const line of text.split("\n"))
    for (const piece of line.match(/[^。！？.!?]+[。！？.!?]*/gu) ?? []) {
      const trimmed = piece.trim();
      if (trimmed.length > 0) out.push(trimmed);
    }
  return out;
}

/**
 * Dialogue example lines (under `[Dialogue Examples]`) are scene demonstrations rather than
 * surface-channel protocol rules.
 */
function isDialogueExample(sentence: string): boolean {
  return /^[^\s:]+:\s*\*/u.test(sentence) || sentence.startsWith("<START>");
}

/**
 * The compiled Game prompt's channel-protocol sentences: the ones naming a mounted Game tool, and
 * the ones speaking about the stage-direction mark.
 */
const GAME_CHANNEL_SENTENCES: readonly string[] = Object.freeze(
  sentences(GAME_PROMPT)
    .filter((sentence) => !isDialogueExample(sentence))
    .filter((sentence) => toolNamesIn(sentence).length > 0 || sentence.includes(STAGE_DIRECTION_MARK)),
);

test("the Game prompt states its channel protocol, so there is a rule to isolate", () => {
  // The population this gate isolates is non-empty, and it is derived rather than listed. If the
  // Game prompt stops naming its body-language channel the game-side rule disappears, and every
  // assertion below would then guard nothing while staying green - which is exactly how an
  // isolation gate stops working.
  const named = toolNamesIn(GAME_PROMPT);
  assert.ok(
    named.length > 0,
    `the Game prompt must name at least one of the ${MOUNTED_GAME_TOOL_NAMES.length} mounted Game tools, or there is no surface rule to isolate`,
  );
  assert.ok(
    GAME_CHANNEL_SENTENCES.some((sentence) => toolNamesIn(sentence).length > 0),
    `the mounted names ${named.join(", ")} must appear inside a rule sentence, not as a stray token`,
  );
  assert.ok(
    GAME_CHANNEL_SENTENCES.some((sentence) => sentence.includes(STAGE_DIRECTION_MARK)),
    `the Game prompt must also state what happens to a ${STAGE_DIRECTION_MARK}-delimited beat, or that half of the protocol is unheld`,
  );
});

test("no mounted Game tool name reaches the Chat prompt", () => {
  const leaked = toolNamesIn(CHAT_PROMPT);
  assert.deepEqual(
    leaked,
    [],
    `the Chat prompt names Game-only tool${leaked.length === 1 ? "" : "s"} ${leaked.join(", ")}: a Chat mount cannot call ${
      leaked.length === 1 ? "it" : "them"
    }, so the instruction sends the companion's body language nowhere and competes with the syntax the Chat renderer draws`,
  );
});

test("no Game channel-rule sentence reaches the Chat prompt", () => {
  // The phrasing half, and the half that does not depend on a tool name being present: the Game
  // conduct also states what happens to a bracketed or asterisked beat, and a card that scoped THAT
  // sentence to the wrong surface is the same defect with a different subject.
  const chatSentences = new Set(sentences(CHAT_PROMPT));
  const leaked = GAME_CHANNEL_SENTENCES.filter((sentence) => chatSentences.has(sentence));
  assert.deepEqual(
    leaked,
    [],
    `the Chat prompt carries ${leaked.length} Game-surface channel rule sentence(s) verbatim: ${JSON.stringify(leaked)}`,
  );
});

test("the Chat prompt still names the one action syntax its renderer draws", () => {
  // The other direction, and the reason the defect was visible at all: Chat draws `<em>` for the
  // single-asterisk form and nothing else, so a Chat prompt that loses this sentence loses the
  // action beat. Measured consequence of the leak: `em.message-action` at 0.
  assert.ok(
    CHAT_PROMPT.includes(COMPANION_ACTION_SYNTAX),
    "the Chat prompt must still name the asterisk syntax the Chat renderer draws",
  );
  assert.match(CHAT_PROMPT, /draws that asterisk form as the action beat/u);
});

/*
 * THE HARNESS HALF: the coding-harness plugin this product vendors is a WRITER of model input, and it was writing on the
 * surface that must not carry it.
 *
 * <p>
 * Measured on `round75`'s session record (208 records): a 406-character `magic_context` section on the GAME system
 * message at rec#3, and a `<system-reminder>` housekeeping nudge as a second text block inside a `toolResult` at
 * rec#142, which the companion answered with a `ctx_reduce` turn (rec#143) - a turn of the game spent on the harness's
 * context housekeeping. `tools/check-fact-authority` and the floor gates were green throughout, because nothing read the
 * ASSEMBLED prompt for another runtime's protocol. That is the rule this section executes, from `AGENTS.md`:
 * "surface-specific instructions and tool bindings must remain strictly isolated to their target runtime, verified by
 * negative assertions on other surfaces."
 * </p>
 *
 * <p>
 * THE POPULATION IS THE HARNESS'S OWN SOURCE, scanned rather than listed: every `sections.<name> =` the extension writes,
 * every `ctx_*` name it registers, and every wrapper token it opens. A section or tool the extension grows tomorrow
 * arrives in this comparison with no edit here, and the walk is anchored at the vendored copy by this file's own
 * location, so a user Pi installation's extension cannot silently become the population.
 * </p>
 */

/** One way a surface's prompt carries another runtime's protocol. */
type Foreign = Readonly<{
  surface: "game" | "chat";
  what: "section" | "marker" | "tool";
  name: string;
  writer: string;
}>;

/** The two prompts the product assembles, keyed by the surface that installs them. */
const SURFACE_PROMPTS: Readonly<Record<"game" | "chat", string>> = Object.freeze({
  game: GAME_PROMPT,
  chat: CHAT_PROMPT,
});

/**
 * Every foreign section, marker or tool name in one surface's prompt.
 *
 * `owned` is the set of names the surface may legitimately carry: a harness section is owned by nobody, a wrapper token
 * likewise, and a harness tool only by a surface that mounts the harness's tool class and, on Game, actually mounts the
 * name (the recorded mounted set, which `game-prompt-harness-isolation.private.test.ts` re-reads off a real session).
 */
function foreignIn(
  surface: "game" | "chat",
  prompt: string,
  harness: Readonly<{
    sections: readonly Readonly<{ name: string; writer: string }>[];
    markers: readonly Readonly<{ name: string; writer: string }>[];
    tools: readonly Readonly<{ name: string; writer: string }>[];
    ownedTools: readonly string[];
  }>,
): readonly Foreign[] {
  const found: Foreign[] = [];
  for (const section of harness.sections)
    if (prompt.includes(`<${section.name}>`))
      found.push(Object.freeze({ surface, what: "section", name: `<${section.name}>`, writer: section.writer }));
  for (const marker of harness.markers)
    if (prompt.includes(marker.name))
      found.push(Object.freeze({ surface, what: "marker", name: marker.name, writer: marker.writer }));
  for (const tool of harness.tools)
    if (!harness.ownedTools.includes(tool.name) && new RegExp(`\\b${tool.name}\\b`, "u").test(prompt))
      found.push(Object.freeze({ surface, what: "tool", name: tool.name, writer: tool.writer }));
  return Object.freeze(found);
}

/** The population, derived once: the harness's own sections, markers and tool names, each with the file that writes it. */
function harnessPopulation(): Readonly<{
  sources: number;
  sections: readonly Readonly<{ name: string; writer: string }>[];
  markers: readonly Readonly<{ name: string; writer: string }>[];
  tools: readonly Readonly<{ name: string; writer: string }>[];
}> {
  const sources = vendorSources();
  const sections = harnessSectionsOf(sources);
  const markers = harnessMarkersOf(sources).map((name) => Object.freeze({ name, writer: "vendor pi-plugin source" }));
  const toolsByName = new Map<string, string>();
  for (const source of sources) {
    if (!source.path.startsWith("tools/")) continue;
    for (const match of source.text.matchAll(/["'`](ctx_[a-z_]+)["'`]/gu)) {
      const name = match[1] ?? "";
      if (name.length > 0 && !toolsByName.has(name)) toolsByName.set(name, source.path);
    }
  }
  return Object.freeze({
    sources: sources.length,
    sections,
    markers,
    tools: Object.freeze([...toolsByName.entries()].map(([name, writer]) => Object.freeze({ name, writer }))),
  });
}

test("no surface's prompt carries the coding harness's section or its wrapper tokens, and the failure names both", () => {
  const population = harnessPopulation();
  assert.ok(population.sources > 0, "the vendored extension's source was not found, so this gate examined nothing");
  assert.ok(
    population.sections.length > 0,
    "the scan found no system-prompt section in the harness's source: the population is empty, which is a BLOCKED reading, not a clean one",
  );
  assert.ok(
    population.markers.length > 0,
    "the scan found no wrapper token in the harness's source: nothing would be compared",
  );

  // The published surface's tool ownership, taken from the product's own planner rather than from a list here: the same
  // `planToolSurface` call `runtime-core.internal.ts` makes, with the extension declared at the class that composition
  // declares for it and the registered names the harness's own source supplies. Game mounts them, Chat mounts none.
  const harnessExtension = "vendored-pi-plugin" as const;
  const planned = (surface: "game" | "chat") =>
    planToolSurface({
      surface,
      groups: [],
      extensions: [{ entry: harnessExtension, toolClass: "session_inspection" }],
      registered: [{ entry: harnessExtension, tools: population.tools.map((entry) => entry.name) }],
    });
  const owned: Readonly<Record<"game" | "chat", readonly string[]>> = Object.freeze({
    game: planned("game").mounted,
    chat: planned("chat").mounted,
  });
  assert.ok(
    owned.game.length > 0,
    "the Game surface plans no harness tool at all, so the Game half of this comparison would be vacuous",
  );
  assert.deepEqual(
    owned.chat,
    [],
    "the Chat surface plans a harness tool, so 'Chat mounts none of it' is no longer true",
  );
  assert.equal(
    PERMITTED_TOOL_CLASSES.game.includes("session_inspection"),
    owned.game.length > 0,
    "the permitted classes and the planner disagree about whether Game mounts the harness's tools",
  );

  const foreign: Foreign[] = [];
  for (const surface of ["game", "chat"] as const)
    foreign.push(...foreignIn(surface, SURFACE_PROMPTS[surface], { ...population, ownedTools: owned[surface] }));

  const sections = foreign.filter((entry) => entry.what === "section").length;
  const markers = foreign.filter((entry) => entry.what === "marker").length;
  const tools = foreign.filter((entry) => entry.what === "tool").length;
  process.stderr.write(
    `[surface-isolation] writers examined ${String(
      population.sections.length + population.markers.length + population.tools.length + 2,
    )} · surfaces ${String(2)} · foreign sections ${String(sections + markers)} · foreign tools ${String(tools)}` +
      ` · harness sections ${population.sections.map((entry) => entry.name).join(",")}` +
      ` · owned tools game=${owned.game.length} chat=${owned.chat.length}\n`,
  );

  assert.deepEqual(
    foreign,
    [],
    `a surface carries another runtime's protocol: ${foreign
      .map(
        (entry) =>
          `a_surface_carries_only_its_own_protocol:${entry.surface}:${entry.what}:${entry.name}:writer=${entry.writer}`,
      )
      .join(" | ")}`,
  );
});

test("the population is the harness's source, not a list: a section or a tool it grows arrives without an edit here", () => {
  // Falsifiers for the two scans, on synthetic sources shaped like the real ones. A gate that cannot be made red on
  // purpose is decoration, so both extractors are shown catching something the tree does not contain today.
  const grown = harnessSectionsOf([
    Object.freeze({ path: "index.ts", text: "hostSections.stardew_desk_protocol = block;\nsections.length = 0;" }),
  ]);
  assert.deepEqual(
    grown,
    [{ name: "stardew_desk_protocol", writer: "index.ts" }],
    "a section the extension starts writing must enter the population, and a property read must not",
  );
  const tools = harnessToolNamesOf([
    Object.freeze({ path: "tools/index.ts", text: 'name: "ctx_ghost", name: "ctx_search"' }),
  ]);
  assert.deepEqual(
    tools,
    ["ctx_ghost", "ctx_search"],
    "a tool the extension starts registering must enter the population",
  );
  assert.deepEqual(
    harnessToolNamesOf([
      Object.freeze({ path: "tools/index.ts", text: '"ctx_search"' }),
      Object.freeze({ path: "auto-search-pi.ts", text: '"ctx_expand"' }),
    ]),
    ["ctx_search"],
    "a ctx_* name mentioned outside the registration module is not a registered tool",
  );

  // And the reader that reports the finding is red on a prompt carrying one it does not own.
  const foreign = foreignIn(
    "chat",
    "then `ctx_ghost` empties it <system-reminder>x</system-reminder> <magic_context>x",
    {
      sections: Object.freeze([{ name: "magic_context", writer: "index.ts" }]),
      markers: Object.freeze([{ name: "<system-reminder>", writer: "ctx-reduce-nudge-pi.ts" }]),
      tools: Object.freeze([{ name: "ctx_ghost", writer: "tools.ts" }]),
      ownedTools: Object.freeze([]),
    },
  );
  assert.deepEqual(
    foreign.map((entry) => `${entry.what}:${entry.name}`).sort(),
    ["marker:<system-reminder>", "section:<magic_context>", "tool:ctx_ghost"],
    "the reader must name every kind of foreign protocol, not only the one the first surface had",
  );
  assert.equal(
    CHAT_SURFACE_DIVERGENCE.includes("<system-reminder>"),
    false,
    "the Chat surface's own block must not be where a harness wrapper token lives",
  );
});

/**
 * THE CONFIG THAT MAKES THE SECTION UNREPRESENTABLE, asserted on a config a real runtime wrote.
 *
 * <p>
 * The test above reads the text the two BUILDERS produce, and the harness's section was never in that text - it was
 * composed onto the assembled prompt by the extension's `before_agent_start` hook, which is why the floor gates stayed
 * green through the defect. What the assembled prompt carries is decided HERE, in the config the Host writes before any
 * session exists: `system_prompt_injection.enabled: false` is the extension's own gate, read before it composes
 * anything (vendor `pi-plugin/src/index.ts:2664`), so the block is never built, never written into
 * `systemPromptOptions.sections`, and no `skip_signatures` substring can leave one surface receiving it.
 * </p>
 *
 * <p>
 * This case was RED before the change it holds: the config said `{ enabled: true, skip_signatures: [<a Chat prompt
 * substring>] }`, which skipped Chat and let Game through, and the assembled Game prompt carried a 406-character
 * `magic_context` section on every turn (`round75` rec#3). `game-prompt-harness-isolation.private.test.ts` carries the
 * other half - the prompt a real turn was sent - because that reading needs a provider.
 * </p>
 */
test("no surface's Magic Context config injects a system-prompt section, on either surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-surface-isolation-config-"));
  const identity = Object.freeze({
    continuityId: "continuity_surface_isolation_config",
    playerId: "player_surface_isolation_config",
    saveId: "save_surface_isolation_config",
    worldId: "world_surface_isolation_config",
    companionId: "companion_surface_isolation_config",
  });
  try {
    const written: Record<string, unknown>[] = [];
    for (const surface of ["game", "chat"] as const) {
      const runtime = await createCompanionRuntime(
        identity,
        root,
        undefined,
        undefined,
        undefined,
        Object.freeze({
          profile: Object.freeze({ locale: "zh-CN", text: true, speech: null }),
          surface,
          sessionId: `${surface}_surface_isolation_config`,
        }),
        false,
        undefined,
        `${surface}_surface_isolation_config`,
        undefined,
        surface,
      );
      runtime.session.dispose();
      const runtimeCwd = resolveRuntimePaths(identity, root).runtimeCwd;
      written.push(
        JSON.parse(await readFile(join(runtimeCwd, ".cortexkit", "magic-context.jsonc"), "utf8")) as Record<
          string,
          unknown
        >,
      );
      assert.equal(
        existsSync(join(runtimeCwd, "config", "cortexkit", "gamebuddy-companion-desk.md")),
        false,
        "the guidance-override file the harness section used to read is still written",
      );
    }
    // The population is one config file per surface, and both are the same file: `resolveRuntimePaths` keys both surfaces
    // of a continuity on `continuityId`. That is exactly why a per-surface substring was the wrong mechanism.
    assert.equal(written.length, 2);
    for (const config of written)
      assert.deepEqual(
        config.system_prompt_injection,
        { enabled: false },
        "a config that enables the harness's system-prompt injection puts its coding-agent section on a companion surface",
      );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
