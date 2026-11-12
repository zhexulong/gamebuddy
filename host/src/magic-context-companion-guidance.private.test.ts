/**
 * THE COMPANION'S DESK PROTOCOL, IN THE PROMPT SHE ACTUALLY GETS.
 *
 * <p>
 * The finding this file answers, measured on a real Game run: the runtime mounted `ctx_search` and
 * `ctx_expand`, a test forbade removing them, and `system_prompt_injection.enabled: false` kept the text that
 * explains them out of her prompt. Over 34 minutes and 17 folds she called `ctx_reduce` six times, `ctx_search`
 * never, and then said "I tilled nothing, planted nothing" while the transcript held four `plant_seed` calls. A
 * tool she does not know the protocol for is a tool she does not use.
 * </p>
 *
 * <p>
 * The block is composed by the extension's `before_agent_start` hook (vendor
 * `packages/pi-plugin/src/index.ts:2512`), NEVER at session construction — which is why the assertion this file
 * replaces was vacuous: `runtime.session.systemPrompt` after `createCompanionRuntime` cannot carry the block
 * whether injection is on or off. Everything below therefore reads either a real turn's
 * `session.systemPrompt`, or the config and prose files the Host itself wrote.
 * </p>
 *
 * <p>
 * Two of the cases below spend one real provider turn each, because the assembled prompt exists only after a
 * turn. They are gated on the credential rather than skipped silently: an absent credential is a named skip, and
 * the file-level cases above them are the gate that runs everywhere.
 * </p>
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildGameCompanionSystemPrompt } from "./game-surface-prompt-floor.js";
import { buildChatCompanionSystemPrompt, CHAT_SURFACE_SKIP_SIGNATURE } from "./identity-profile.js";
import {
  buildCompanionDeskGuidance,
  COMPANION_DESK_GUIDANCE_FILE_NAME,
  COMPANION_DESK_GUIDANCE_MARKER,
} from "./magic-context-companion-guidance.js";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import type { PresentationRuntime } from "./presentation.js";
import { type CompanionIdentity, createCompanionRuntime, resolveRuntimePaths } from "./runtime.js";
import { PlayerPreferenceStore, playerPreferencePath } from "./settings/player-preference-store.js";
import { DEFAULT_COMPANION_PRESET } from "./tavern/default-companion-preset.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());

const identity: CompanionIdentity = Object.freeze({
  continuityId: "continuity_desk_guidance",
  playerId: "player_desk_guidance",
  saveId: "save_desk_guidance",
  worldId: "world_desk_guidance",
  companionId: "companion_desk_guidance",
});

/** The locale the shipped configuration runs under; the prose the Host writes is localised to it. */
const LOCALE = "zh-CN";

/**
 * The words that belong to Magic Context's coding-agent frame and to its `§N§` self-tag order.
 *
 * They are the reason the block was switched off, so they are the half this change must not bring back. Each one
 * is a sentence or phrase from the vendor's own section (`magic-context-prompt.ts`), not a paraphrase.
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

/** The mechanics the block must carry, named by the calls that are mounted for her. */
const DESK_MECHANICS_WORDS = Object.freeze([
  "ctx_search",
  "ctx_expand",
  "ctx_reduce",
  "<session-history>",
  "[dropped §N§]",
]);

function presentationFor(surface: "chat" | "game"): PresentationRuntime {
  return Object.freeze({
    profile: Object.freeze({ locale: LOCALE, text: true, speech: null }),
    surface,
    sessionId: `${surface}_desk_guidance_01`,
  });
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-desk-guidance-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The two config files the Host writes, read back as the extension reads them. */
async function writtenConfigs(root: string): Promise<{
  project: Record<string, unknown>;
  user: Record<string, unknown>;
  guidance: string;
}> {
  const runtimeCwd = resolveRuntimePaths(identity, root).runtimeCwd;
  const project = JSON.parse(await readFile(join(runtimeCwd, ".cortexkit", "magic-context.jsonc"), "utf8"));
  const user = JSON.parse(
    await readFile(join(runtimeCwd, "config", "cortexkit", "magic-context.jsonc"), "utf8"),
  ) as Record<string, unknown>;
  const guidance = await readFile(join(runtimeCwd, "config", "cortexkit", COMPANION_DESK_GUIDANCE_FILE_NAME), "utf8");
  return { project: project as Record<string, unknown>, user, guidance };
}

test("the config the Host writes names the desk guidance, and the file behind that name is the prose it says", async () => {
  await withRoot(async (root) => {
    const runtime = await createCompanionRuntime(
      identity,
      root,
      undefined,
      undefined,
      undefined,
      presentationFor("game"),
      false,
      undefined,
      "game_desk_guidance_01",
      undefined,
      "game",
    );
    try {
      const { project, user, guidance } = await writtenConfigs(root);

      // The gate the extension reads before it composes anything (vendor index.ts:2653).
      assert.deepEqual(project.system_prompt_injection, {
        enabled: true,
        skip_signatures: [CHAT_SURFACE_SKIP_SIGNATURE],
      });

      // The seam itself: user scope only (a project config's copy is stripped by the vendor's
      // project-security rule), and a relative name the extension resolves against the user config file.
      assert.deepEqual(user.prompt_surface, { guidance_override_path: COMPANION_DESK_GUIDANCE_FILE_NAME });

      // The file the Host wrote is the prose the module owns, localised to the surface's own locale.
      assert.equal(guidance, buildCompanionDeskGuidance(LOCALE));

      // Magic Context refuses an override that does not carry exactly one marker line, and falls back to its own
      // coding-agent prose when it refuses - so the marker is a correctness condition, not a decoration.
      const markers = guidance.match(/^## Magic Context[\t ]*\r?$/gm) ?? [];
      assert.equal(markers.length, 1, `the override must carry exactly one marker line; found ${markers.length}`);
      assert.equal(markers[0], COMPANION_DESK_GUIDANCE_MARKER);
    } finally {
      runtime.session.dispose();
    }
  });
});

test("the skip signature is the Chat floor's own sentence, so it reaches Chat's prompt and no other", async () => {
  const chatPrompt = buildChatCompanionSystemPrompt(DEFAULT_COMPANION_PRESET.profile, LOCALE);
  const gamePrompt = buildGameCompanionSystemPrompt(DEFAULT_COMPANION_PRESET.profile, LOCALE);
  assert.ok(
    chatPrompt.includes(CHAT_SURFACE_SKIP_SIGNATURE),
    "the Chat prompt no longer carries the sentence the shared config uses to skip it, so the config would stop skipping the surface",
  );
  assert.ok(
    !gamePrompt.includes(CHAT_SURFACE_SKIP_SIGNATURE),
    "the Game prompt carries the Chat skip signature, so the shared config would switch the desk protocol off on the surface that mounts its tools",
  );
  // And the prompt the Chat runtime actually installs is the one carrying it: read from a real session, because
  // `runtime-core.internal.ts` could have been handed a different builder.
  await withRoot(async (root) => {
    const runtime = await createCompanionRuntime(
      identity,
      root,
      undefined,
      undefined,
      undefined,
      presentationFor("chat"),
      false,
      undefined,
      "chat_desk_guidance_01",
      undefined,
      "chat",
    );
    try {
      assert.ok(
        runtime.session.systemPrompt.includes(CHAT_SURFACE_SKIP_SIGNATURE),
        "the Chat session's own system prompt does not carry the skip signature, so the shared config would inject the desk protocol into a surface with no ctx_* tools",
      );
    } finally {
      runtime.session.dispose();
    }
  });
});

test("a player who pastes the Chat sentence into their own Game instructions is refused, not obeyed", async () => {
  await withRoot(async (root) => {
    // The Game prompt carries the player's own free text, so the one input that could smuggle the Chat signature
    // onto the Game surface is the player's addition. It must fail loudly at construction: the alternative is a
    // silently deleted archive protocol that nothing else would report.
    await mkdir(join(root), { recursive: true });
    const preferences = new PlayerPreferenceStore(playerPreferencePath(root));
    await preferences.update(0, { action: "setGamePromptAddition", addition: CHAT_SURFACE_SKIP_SIGNATURE });
    await assert.rejects(
      () =>
        createCompanionRuntime(
          identity,
          root,
          undefined,
          undefined,
          undefined,
          presentationFor("game"),
          false,
          undefined,
          "game_desk_guidance_01",
          undefined,
          "game",
        ),
      /game_prompt_carries_magic_context_skip_signature/u,
    );
  });
});

test("the prose names the tool set the Game surface mounts, and that set is the surface's own", async () => {
  await withRoot(async (root) => {
    const runtime = await createCompanionRuntime(
      identity,
      root,
      undefined,
      undefined,
      undefined,
      presentationFor("game"),
      false,
      undefined,
      "game_desk_guidance_01",
      undefined,
      "game",
    );
    try {
      // The population is the mounted set, not a list written here: a tool added to or removed from the surface
      // arrives in this comparison, and the prose is what would become a lie.
      const mountedArchiveTools = runtime.session.agent.state.tools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("ctx_"))
        .sort();
      assert.deepEqual(
        mountedArchiveTools,
        ["ctx_expand", "ctx_memory", "ctx_note", "ctx_reduce", "ctx_search"],
        "the Game surface's ctx_* tool set changed, so the desk guidance prose describes tools she does or does not have",
      );
      const prose = buildCompanionDeskGuidance(LOCALE);
      for (const name of mountedArchiveTools)
        assert.ok(prose.includes(name), `the desk guidance never names ${name}, which the Game surface mounts`);
    } finally {
      runtime.session.dispose();
    }
  });
});

/**
 * The Magic Context section of the prompt a real turn was assembled with.
 *
 * <p>
 * Pi records a session's prompt as structured SECTIONS on the transcript's system message, and an extension
 * that returns a forced `systemPrompt` from `before_agent_start` is projected into the request head WITHOUT
 * being recorded (`agent-session.js`: "Send a forced prompt as the provider's leading system prompt without
 * recording it"). So the section is where an extension's own contribution stays readable after the turn, and
 * `session.systemPrompt` — which is the Host's floor alone — is exactly the reading that made the assertion this
 * file replaces vacuous.
 * </p>
 */
function assembledMagicContextSection(session: {
  agent: { state: { messages: readonly { role?: string; sections?: Record<string, unknown> }[] } };
}): string | undefined {
  for (const message of session.agent.state.messages) {
    if (message.role !== "system") continue;
    const section = message.sections?.magic_context;
    if (typeof section === "string" && section.length > 0) return section;
  }
  return undefined;
}

const apiKey = process.env.CPA_OAI_API_KEY;

/**
 * One real provider turn, and the prompt the provider was actually sent.
 *
 * The credential is written where the runtime reads it, exactly as the fold fixture does; the ambient
 * XDG_CONFIG_HOME is removed first so this measures the runtime's own user config rather than this machine's.
 */
async function promptOnceAndReadThePrompt(
  root: string,
  surface: "chat" | "game",
  key: string,
): Promise<{ systemPrompt: string; magicContext: string | undefined; tools: readonly string[] }> {
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
    `${surface}_desk_guidance_turn_01`,
    undefined,
    surface,
  );
  try {
    await runtime.session.prompt("早。");
    return {
      systemPrompt: runtime.session.systemPrompt,
      magicContext: assembledMagicContextSection(runtime.session),
      tools: runtime.session.agent.state.tools.map((tool) => tool.name),
    };
  } finally {
    runtime.session.dispose();
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
}

test(
  "after one real Game turn the assembled prompt carries the desk mechanics and none of the developer frame",
  { skip: apiKey === undefined ? "requires CPA_OAI_API_KEY: this case reads the prompt a real turn was sent" : false },
  async () => {
    if (apiKey === undefined) throw new Error("requires CPA_OAI_API_KEY");
    await withRoot(async (root) => {
      const { systemPrompt, magicContext, tools } = await promptOnceAndReadThePrompt(root, "game", apiKey);
      assert.ok(
        magicContext !== undefined,
        "the Game prompt carries no Magic Context section at all after a turn, so she was never told the archive is searchable",
      );
      assert.ok(magicContext.includes(COMPANION_DESK_GUIDANCE_MARKER));
      for (const word of DESK_MECHANICS_WORDS)
        assert.ok(
          magicContext.includes(word),
          `the Game prompt never mentions ${word}, which she has to be able to call`,
        );
      const frame = DEVELOPER_FRAME_WORDS.filter((word) => magicContext.includes(word));
      assert.deepEqual(frame, [], `the Game prompt carries Magic Context's coding-agent frame: ${frame.join(" | ")}`);
      assert.ok(tools.includes("ctx_reduce"), "the prose describes stamping, so the tool it names must be mounted");
      process.stderr.write(
        `[desk-guidance] game turn: magicContextSection=${magicContext.length} chars, hostFloor=${systemPrompt.length} chars, ctx_tools=${tools
          .filter((name) => name.startsWith("ctx_"))
          .sort()
          .join(",")}\n`,
      );
    });
  },
);

test(
  "after one real Chat turn the assembled prompt carries no desk protocol, because that surface mounts none of it",
  { skip: apiKey === undefined ? "requires CPA_OAI_API_KEY: this case reads the prompt a real turn was sent" : false },
  async () => {
    if (apiKey === undefined) throw new Error("requires CPA_OAI_API_KEY");
    await withRoot(async (root) => {
      const { magicContext, tools } = await promptOnceAndReadThePrompt(root, "chat", apiKey);
      // The skip is what must do this: without it the same config injects the block here, which is the red this
      // case exists to make visible.
      assert.deepEqual(tools, [], "the Chat surface mounts no tools, so no desk protocol can be true of it");
      assert.equal(
        magicContext,
        undefined,
        "the Chat prompt carries the desk protocol, which names ctx_* tools this surface does not mount",
      );
    });
  },
);
