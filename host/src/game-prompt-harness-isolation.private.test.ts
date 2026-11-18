/**
 * THE GAME PROMPT CARRIES NO CODING-HARNESS SECTION.
 *
 * <p>
 * The finding, measured on `round75`'s session record (208 records): a 406-character `magic_context` section on the
 * Game session's system message at rec#3, and a `<system-reminder>` housekeeping nudge arriving as a second text block
 * inside a `toolResult` at rec#142 - which the companion then answered with a `ctx_reduce` turn of her own (rec#143).
 * The companion spent a turn of the GAME doing the HARNESS's context housekeeping.
 * </p>
 *
 * <p>
 * It was not an accident of wording: the shared Magic Context config switched the block off with
 * `system_prompt_injection.skip_signatures: [CHAT_SURFACE_SKIP_SIGNATURE]`, and the signature is a substring of the CHAT
 * floor - so the surface that must not carry the block was the only one guaranteed to receive it, and the Host wrote a
 * guidance override so that the Game copy said something else instead. A second writer for the same section is not
 * isolation. The section is now switched off outright (`system_prompt_injection.enabled: false`), and the one claim the
 * companion needs from it - that the archive is HER OWN earlier turns, not a repository's history - is the Game floor's
 * own rule (`game-surface-prompt-floor.ts` `archive_is_her_own_history`).
 * </p>
 *
 * <p>
 * WHY THE ASSERTIONS READ AN ASSEMBLED PROMPT AND NOT A CONSTRUCTED SESSION. The block is composed by the extension's
 * `before_agent_start` hook, so `runtime.session.systemPrompt` after construction cannot carry it whether injection is
 * on or off - the assertion that used to live here was vacuous for exactly that reason. The section is readable after a
 * turn because Pi records an extension's contribution as structured SECTIONS on the transcript's system message.
 * </p>
 *
 * <p>
 * Two of the cases below spend one real provider turn each; they are gated on the credential rather than skipped
 * silently, and the file-level cases above them are the gate that runs everywhere.
 * </p>
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildChatCompanionSystemPrompt } from "./companion-prompt-assembly.js";
import { GAME_SURFACE_CONDUCT_RULES, buildGameCompanionSystemPrompt } from "./game-surface-prompt-floor.js";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import type { PresentationRuntime } from "./presentation.js";
import { type CompanionIdentity, createCompanionRuntime, resolveRuntimePaths } from "./runtime.js";
import { DEFAULT_COMPANION_PRESET } from "./tavern/default-companion-preset.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());

const identity: CompanionIdentity = Object.freeze({
  continuityId: "continuity_harness_isolation",
  playerId: "player_harness_isolation",
  saveId: "save_harness_isolation",
  worldId: "world_harness_isolation",
  companionId: "companion_harness_isolation",
});

const LOCALE = "zh-CN";

/**
 * The words that belong to Magic Context's coding-agent frame and to its `§N§` self-tag order.
 *
 * Each is a sentence or phrase from the vendor's own section (`magic-context-prompt.ts`), not a paraphrase, so this
 * list fails by quoting the thing that would have to come back.
 */
const DEVELOPER_FRAME_WORDS = Object.freeze([
  "long-term partner",
  "one-off hire",
  "durable working relationship",
  "every other agent working on this project",
  "noted in this project",
  "Start the text of each reply with exactly",
  "A reply that is only tool calls gets no tag",
]);

/** The archive mechanics, and the tag sense the floor rule owes her now that the harness section is gone. */
const DESK_MECHANICS_WORDS = Object.freeze(["ctx_search", "ctx_expand", "§N§", "[dropped §N§]"]);

function presentationFor(surface: "chat" | "game"): PresentationRuntime {
  return Object.freeze({
    profile: Object.freeze({ locale: LOCALE, text: true, speech: null }),
    surface,
    sessionId: `${surface}_harness_isolation_01`,
  });
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-harness-isolation-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function withRuntime(
  root: string,
  surface: "chat" | "game",
  run: (session: {
    dispose: () => void;
    systemPrompt: string;
    agent: { state: { tools: readonly { name: string }[] } };
  }) => Promise<void>,
): Promise<void> {
  const runtime = await createCompanionRuntime(
    identity,
    root,
    undefined,
    undefined,
    undefined,
    presentationFor(surface),
    false,
    undefined,
    `${surface}_harness_isolation_01`,
    undefined,
    surface,
  );
  try {
    await run(runtime.session);
  } finally {
    runtime.session.dispose();
  }
}

test("the config the Host writes switches Magic Context's system-prompt section off on both surfaces", async () => {
  await withRoot(async (root) => {
    await withRuntime(root, "game", async () => {
      const runtimeCwd = resolveRuntimePaths(identity, root).runtimeCwd;
      const project = JSON.parse(
        await readFile(join(runtimeCwd, ".cortexkit", "magic-context.jsonc"), "utf8"),
      ) as Record<string, unknown>;
      const user = JSON.parse(
        await readFile(join(runtimeCwd, "config", "cortexkit", "magic-context.jsonc"), "utf8"),
      ) as Record<string, unknown>;

      // The gate the extension reads BEFORE it composes anything (vendor `pi-plugin/src/index.ts:2664`), so `false` is
      // what makes the section unrepresentable rather than filtered: no block is built, no marker can be skipped, and
      // the player's own free text cannot switch anything back on.
      assert.deepEqual(project.system_prompt_injection, { enabled: false });

      // The two seams the section used to be steered with are gone. Leaving either would be a second way to describe
      // the same behaviour, which is how the substring mechanism survived its own defect.
      assert.equal(user.prompt_surface, undefined, "the guidance-override seam is deleted, not left unused");
      await assert.rejects(
        () => readFile(join(runtimeCwd, "config", "cortexkit", "gamebuddy-companion-desk.md"), "utf8"),
        /ENOENT/u,
        "the override file the harness section used to read is no longer written",
      );

      // The fold's own summaries are still written in the companion's language: that setting is the extension's, and it
      // has nothing to do with the prompt section the switch removes.
      assert.equal(user.language, "zh");
    });
  });
});

test("the archive claim is the Game floor's, and it names only tools the Game surface mounts", async () => {
  await withRoot(async (root) => {
    await withRuntime(root, "game", async (session) => {
      const mountedArchiveTools = session.agent.state.tools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("ctx_"))
        .sort();
      assert.deepEqual(
        mountedArchiveTools,
        ["ctx_expand", "ctx_memory", "ctx_note", "ctx_reduce", "ctx_search"],
        "the Game surface's ctx_* tool set changed, so the floor's archive rule describes tools she does or does not have",
      );
      const rule = GAME_SURFACE_CONDUCT_RULES.archive_is_her_own_history.text;
      const named = [...new Set(rule.match(/ctx_[a-z_]+/gu) ?? [])].sort();
      assert.deepEqual(
        named.filter((name) => !mountedArchiveTools.includes(name)),
        [],
        "the rule names an archive tool this surface does not mount, so she is told to call something she does not have",
      );
      for (const word of DESK_MECHANICS_WORDS)
        assert.ok(rule.includes(word), `the archive rule never states ${word}, so she cannot read the archive back`);

      // The falsifier of that reading: the same extractor over a prose that names a tool nothing mounts.
      const reader = (prose: string): readonly string[] =>
        [...new Set(prose.match(/ctx_[a-z_]+/gu) ?? [])].filter((name) => !mountedArchiveTools.includes(name)).sort();
      assert.deepEqual(reader("`ctx_search` reads it back; `ctx_ghost` empties it."), ["ctx_ghost"]);
    });
  });
});

test("the Chat prompt states none of it: the archive is not a Chat surface's capability", async () => {
  const chatPrompt = buildChatCompanionSystemPrompt(DEFAULT_COMPANION_PRESET.profile, LOCALE);
  assert.doesNotMatch(chatPrompt, /ctx_[a-z_]+/u, "the Chat prompt must name no archive tool, mounted or not");
  assert.doesNotMatch(chatPrompt, /§N§/u, "the Chat prompt must not describe a tag order it has no archive for");
  const gamePrompt = buildGameCompanionSystemPrompt(DEFAULT_COMPANION_PRESET.profile, LOCALE);
  assert.match(gamePrompt, /archive holds what is no longer in view/u);
});

/**
 * The Magic Context section of the prompt a real turn was assembled with, or `undefined` when the surface carries none.
 *
 * Pi records a session's prompt as structured SECTIONS on the transcript's system message, and an extension that returns
 * a forced `systemPrompt` from `before_agent_start` is projected into the request head WITHOUT being recorded - so the
 * section is where an extension's own contribution stays readable after the turn.
 */
function assembledSections(session: {
  agent: { state: { messages: readonly { role?: string; sections?: Record<string, unknown> }[] } };
}): Readonly<Record<string, string>> {
  const sections: Record<string, string> = {};
  for (const message of session.agent.state.messages) {
    if (message.role !== "system") continue;
    for (const [name, text] of Object.entries(message.sections ?? {}))
      if (typeof text === "string" && text.length > 0) sections[name] = text;
  }
  return Object.freeze(sections);
}

const apiKey = process.env.CPA_OAI_API_KEY;

/** One real provider turn, and the prompt the provider was actually sent. */
async function promptOnceAndReadThePrompt(
  root: string,
  surface: "chat" | "game",
  key: string,
): Promise<{ sections: Readonly<Record<string, string>>; tools: readonly string[] }> {
  const agentDir = resolveRuntimePaths(identity, root).agentDir;
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "cpa-oai": { type: "api_key", key } }), "utf8");
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  const runtime = await createCompanionRuntime(
    identity,
    root,
    undefined,
    { provider: "cpa-oai", modelId: "deepseek-v4.1-flash", thinkingLevel: "low" },
    undefined,
    presentationFor(surface),
    false,
    undefined,
    `${surface}_harness_isolation_turn_01`,
    undefined,
    surface,
  );
  try {
    await runtime.session.prompt("早。");
    return {
      sections: assembledSections(runtime.session),
      tools: runtime.session.agent.state.tools.map((tool) => tool.name),
    };
  } finally {
    runtime.session.dispose();
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
}

for (const surface of ["game", "chat"] as const) {
  test(
    `after one real ${surface} turn the assembled prompt carries no Magic Context section and no developer frame`,
    {
      skip: apiKey === undefined ? "requires CPA_OAI_API_KEY: this case reads the prompt a real turn was sent" : false,
    },
    async () => {
      if (apiKey === undefined) throw new Error("requires CPA_OAI_API_KEY");
      await withRoot(async (root) => {
        const { sections } = await promptOnceAndReadThePrompt(root, surface, apiKey);
        // The sections this surface's assembled prompt really has, printed so a reviewer can see the population the
        // assertions below are empty over rather than reading "not present" as "not measured".
        process.stderr.write(
          `[harness-isolation] ${surface} sections: ${
            Object.entries(sections)
              .map(([name, text]) => `${name}=${String(text.length)}ch`)
              .join(",") || "(none)"
          }\n`,
        );
        assert.equal(
          sections.magic_context,
          undefined,
          "the assembled prompt carries Magic Context's coding-harness section, which the config was set to switch off",
        );
        const everyText = Object.values(sections).join("\n");
        const frame = DEVELOPER_FRAME_WORDS.filter((word) => everyText.includes(word));
        assert.deepEqual(
          frame,
          [],
          `the assembled prompt carries Magic Context's coding-agent frame: ${frame.join(" | ")}`,
        );
        assert.ok(
          !everyText.includes("## Magic Context"),
          "the marker line of the harness's own section reached the assembled prompt",
        );
      });
    },
  );
}
