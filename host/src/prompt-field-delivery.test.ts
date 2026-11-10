import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { before, after } from "node:test";
import { fileURLToPath } from "node:url";

import { buildGameSurfaceAuthoredCatalog, materializeTavernAuthoredContextCatalog } from "./tavern/catalog-service.js";
import { createChatThreadStore, createProfileAwareChatThreadCreationCapability } from "./tavern/chat-thread-store.js";
import { TavernArtifactStore } from "./tavern/artifact-store.js";
import { DEFAULT_COMPANION_PRESET } from "./tavern/default-companion-preset.js";
import { macroTable } from "./tavern/macro-engine.js";
import { writeCompanionPostHistoryInstructions } from "./tavern/post-history-instructions.js";
import { GAME_SESSION_PRESET_FILE, readGameSessionPreset } from "./tavern/preset-game-session.js";
import { PRESET_TAIL_PUBLICATION_BYTE_BOUND } from "./tavern/preset-tail-block.js";
import { resolveTavernPaths } from "./tavern/tavern-paths.js";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { resolveRuntimePaths } from "./runtime-identity.js";
import { PlayerPreferenceStore, playerPreferencePath } from "./settings/player-preference-store.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";
import { createCompanionRuntime } from "./runtime.js";

/**
 * A field the product accepts, validates and stores must reach the prompt the model reads.
 *
 * The family has bitten twice, and both times the defect was invisible from the storage side:
 *
 *  - `post_history_instructions` was imported, validated, stored and exported while nothing in
 *    prompt assembly read it (`badc8c0b` stored it; `b5b51adc` published it, after a reviewer
 *    found the vendor's tail append could never fire);
 *  - `gamePromptAddition` had a settings group, a validated PUT and a durable record while the
 *    Game runtime's prompt never read it (`c99c772b` added the seam).
 *
 * Both were repaired by hand, at the one site each had got wrong. What neither repair left behind
 * is the rule: any field the product stores FOR THE PROMPT must be asserted to arrive in the
 * compiled prompt text. So each field below carries a sentinel string through the PRODUCT's own
 * assembly - the same materializer, publisher and appender a mounted surface runs, and the same
 * runtime construction a mounted session runs - and is asserted in the text the model receives.
 *
 * A reader round trip is deliberately not enough: a test that reads back what it wrote passes on
 * exactly the defect this file exists for.
 */

before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

const IDENTITY = Object.freeze({ playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" });

/** A string no product prose contains, so a match can only be the field's own text. */
const SENTINEL_POST_HISTORY = "SENTINEL_POST_HISTORY";
const SENTINEL_PROMPT_ADD = "SENTINEL_PROMPT_ADD";

/**
 * The shipped companion GENERATION preset - the file the Game surface assembles a request from.
 *
 * Resolved from this module rather than from a cwd: the same relative walk works from `host/src` and from
 * `host/dist-test`, so a source-level run and the compiled suite read the same bytes.
 */
const SHIPPED_COMPANION_PRESET_PATH = fileURLToPath(
  new URL("../../assets/tavern/presets/amber-deepseek-v4.1.json", import.meta.url),
);

function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * One real Chat thread over the companion's own root, materialized through the product's own
 * catalog call - the seam that reads her `post-history-instructions.json`.
 */
async function chatCatalog(root: string) {
  const paths = resolveTavernPaths({ root } as never, IDENTITY);
  const artifacts = new TavernArtifactStore(root);
  const threads = createChatThreadStore(root, "continuity-key");
  const creation = createProfileAwareChatThreadCreationCapability(threads, {
    async readExact() {
      return { profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) };
    },
  });
  const thread = await creation.createExplicit({
    chatThreadId: "thread",
    chatSurfaceSessionId: "surface",
    companionId: IDENTITY.companionId,
    continuityId: IDENTITY.continuityId,
    opening: "blank",
  });
  const scope = Object.freeze({
    continuityId: IDENTITY.continuityId,
    sessionId: "pi-session",
    surface: "tavern" as const,
    threadId: "thread",
    profile: Object.freeze({ profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) }),
  });
  return Object.freeze({
    paths,
    artifacts,
    catalog: () =>
      materializeTavernAuthoredContextCatalog(
        paths,
        artifacts,
        thread.thread,
        scope,
        macroTable({ char: "琥珀", locale: "zh-CN" }),
      ),
    close: () => threads.close?.(),
  });
}

/**
 * The provider request's last message, built by the vendor's own appender.
 *
 * This is the production text for `post_history_instructions`, not a stand-in: the appender is
 * the ONE function `context-handler.ts` calls at the single success exit that hands the finished
 * message array to Pi (its line 6084), against the materialization this file just published.
 */
async function trailingMessage(catalog: Readonly<{ postHistoryInstructions?: string }>): Promise<string> {
  const { appendPostHistoryInstructions } = await import("@cortexkit/pi-magic-context/tavern");
  const messages: Array<{ role: string; content: unknown }> = [
    { role: "user", content: [{ type: "text", text: "早上好。" }] },
  ];
  assert.equal(
    appendPostHistoryInstructions(messages as never, catalog.postHistoryInstructions),
    true,
    "a catalogue carrying a closing direction must append the tail message",
  );
  const last = messages.at(-1);
  assert.equal(
    last?.role,
    "user",
    "the tail rides as a user message: a trailing system block would be hoisted to the head",
  );
  const parts = last?.content as readonly { type: string; text: string }[];
  return parts.map((part) => part.text).join("");
}

test("the card's stored closing direction reaches the compiled Chat prompt", async () => {
  const root = await canonicalTestRoot("gamebuddy-prompt-delivery-post-history-");
  const fixture = await chatCatalog(root);
  try {
    await writeCompanionPostHistoryInstructions(
      fixture.artifacts,
      fixture.paths.companionRoot,
      `${SENTINEL_POST_HISTORY} — close on one small physical thing.`,
    );
    const catalog = await fixture.catalog();
    const trailing = await trailingMessage(catalog);
    assert.ok(
      trailing.includes(SENTINEL_POST_HISTORY),
      `the stored closing direction must reach the request's last message; it carried ${JSON.stringify(trailing.slice(0, 160))}`,
    );
    // It is the tail, not the head: the block is appended after everything, and it is framed as
    // her author's direction rather than dropped in bare.
    assert.match(trailing, /<character-closing-direction>/u);
    assert.match(trailing, /Your author's direction for how you answer\./u);
    assert.ok(
      !catalog.stableSources.some((source) => source.content.includes(SENTINEL_POST_HISTORY)),
      "the closing direction is not an authored stable source; it renders after the transcript",
    );
  } finally {
    fixture.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * R-2, DECIDED - AND IT IS A PAIR OF ASSERTIONS, NOT ONE.
 *
 * `design/research/game-airp-review-2026-10-21.md:168` (R-2) asked whether the Game surface should keep its closing
 * direction opaque or render a LOW-PRIORITY tail block. It is rendered, on the second branch of that question, and
 * the material it renders is the PRESET's: the enabled `jailbreak` entry of the generation preset this runtime cwd
 * was provisioned with. The safety argument is provenance - that text comes from a file under
 * `assets/tavern/presets/**` this product ships and reviews, it is framing for how she talks, and it is not a field of
 * an imported card whose author nobody here reviewed.
 *
 * So the card's own `post_history_instructions` is still unpublished on this surface, and both halves are asserted
 * here at once. Either assertion alone would be satisfied by the wrong wiring; the pair is the decision.
 */
test("the Game catalogue publishes the preset's tail block, and never the card's own closing direction", async () => {
  const root = await canonicalTestRoot("gamebuddy-prompt-delivery-game-tail-");
  try {
    const paths = resolveTavernPaths({ root } as never, IDENTITY);
    const artifacts = new TavernArtifactStore(root);
    const { runtimeCwd } = resolveRuntimePaths(IDENTITY as never, root);
    await mkdir(runtimeCwd, { recursive: true });
    // The preset is mounted exactly as provisioning mounts it (`tools/live-run/core/persona.mjs`), then read through
    // the product's own reader - so this test drives the file convention rather than a hand-built reading.
    await writeFile(
      join(runtimeCwd, GAME_SESSION_PRESET_FILE),
      readFileSync(SHIPPED_COMPANION_PRESET_PATH, "utf8"),
      "utf8",
    );
    const preset = await readGameSessionPreset(runtimeCwd, { profile: DEFAULT_COMPANION_PRESET.profile });
    assert.notEqual(preset, null, "the fixture must mount the shipped preset, or the assertion below measures nothing");

    // The CARD's own record is written and must stay out of the published tail.
    await writeCompanionPostHistoryInstructions(
      artifacts,
      paths.companionRoot,
      `${SENTINEL_POST_HISTORY} — close on one small physical thing.`,
    );

    const scope = Object.freeze({
      continuityId: IDENTITY.continuityId,
      sessionId: "pi-session",
      surface: "game" as const,
      threadId: "game-session",
      profile: Object.freeze({ profileId: "profile", revision: 1, canonicalHash: contentHash("profile") }),
    });
    const catalog = buildGameSurfaceAuthoredCatalog(
      scope,
      undefined,
      { char: "琥珀" },
      undefined,
      undefined,
      preset?.postHistory,
    );
    const trailing = await trailingMessage(catalog);
    assert.ok(
      trailing.includes("最新回复约束"),
      `the preset's post-history entry must reach the request's last message; it carried ${JSON.stringify(trailing.slice(0, 160))}`,
    );
    assert.match(trailing, /<character-closing-direction>/u);
    assert.equal(
      trailing.includes(SENTINEL_POST_HISTORY),
      false,
      "the CARD's closing direction must stay unpublished on the Game surface: the tail block is preset-authored, and that provenance is the whole reason it is allowed",
    );
    // And the card's field is not merely absent from the tail: it is not a stable source either.
    assert.equal(
      catalog.stableSources.some((source) => source.content.includes(SENTINEL_POST_HISTORY)),
      false,
      "the card's closing direction is not authored stable context on this surface either",
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * The Game catalogue does NOT carry the card's closing direction, and the pairing above is what keeps that true.
 *
 * This assertion is the negative half on its own, with no preset mounted: a surface that carries no preset has no
 * tail block at all, so "the field is absent" is measured here without the preset path in play.
 */
test("with no preset mounted, the Game catalogue carries no closing direction at all", () => {
  const scope = Object.freeze({
    continuityId: IDENTITY.continuityId,
    sessionId: "pi-session",
    surface: "game" as const,
    threadId: "game-session",
    profile: Object.freeze({ profileId: "profile", revision: 1, canonicalHash: contentHash("profile") }),
  });
  const catalog = buildGameSurfaceAuthoredCatalog(scope, undefined, { char: "琥珀" });
  assert.equal(Object.hasOwn(catalog, "postHistoryInstructions"), false);
});

/**
 * One runtime mount on its own fresh root, with `addition` already stored through the product's
 * own preference record, returning the system prompt that mount compiled.
 *
 * Each surface gets its own root because a mount owns its root: two runtimes over one root contend
 * for the same profile lock, and a fixture that did so would be measuring the lock rather than the
 * prompt.
 *
 * The root is deliberately not removed. A mounted runtime holds the root's profile lock and its
 * SQLite handles, and `runtime.test.ts` follows the same rule for the same measured reason: a
 * directory removed under a live mount is the fixture's bug, not the product's.
 */
async function mountedSystemPrompt(
  surface: "chat" | "game",
  addition: string,
  { mountPreset = false }: Readonly<{ mountPreset?: boolean }> = {},
): Promise<string> {
  const root = await canonicalTestRoot(`gamebuddy-prompt-delivery-${surface}-`);
  await new PlayerPreferenceStore(playerPreferencePath(root)).update(0, {
    action: "setGamePromptAddition",
    addition,
  });
  const stored = await new PlayerPreferenceStore(playerPreferencePath(root)).read();
  assert.equal(
    stored.gamePromptAddition,
    addition,
    "the fixture is stored before the assembly runs, so a missing marker is the assembly's defect and not the fixture's",
  );
  if (mountPreset) {
    // Mounted where provisioning puts it (`tools/live-run/core/persona.mjs`), before the runtime exists.
    const { runtimeCwd } = resolveRuntimePaths(IDENTITY as never, root);
    await mkdir(runtimeCwd, { recursive: true });
    await writeFile(
      join(runtimeCwd, GAME_SESSION_PRESET_FILE),
      readFileSync(SHIPPED_COMPANION_PRESET_PATH, "utf8"),
      "utf8",
    );
  }
  const runtime = await createCompanionRuntime(
    IDENTITY,
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    `${surface}_surface_delivery`,
    undefined,
    surface,
  );
  try {
    return runtime.session.systemPrompt;
  } finally {
    runtime.session.dispose();
  }
}

test("the player's stored Game prompt addition reaches the compiled Game prompt, and not the Chat one", async () => {
  const addition = `${SENTINEL_PROMPT_ADD} 收完土豆再去矿洞。`;
  const game = await mountedSystemPrompt("game", addition);
  assert.ok(
    game.includes(SENTINEL_PROMPT_ADD),
    "the Game runtime's own system prompt must carry the player's stored addition",
  );
  // It arrives as an addition after the Host floor, never as a replacement for it.
  assert.match(game, /<<<PLAYER DIRECTIVES/u);
  // The floor's observation-boundary clause, as the floor actually states it: `identity-profile.ts` says "Only state
  // what you actually observed in the game.", and an anchor that stopped at "observed." matched nothing at all - a red
  // assertion nobody read, which is worse than no assertion (measured 2026-11-10: this exact regex was already in the
  // tree at HEAD against a floor that had already moved).
  assert.match(game, /Only state what you actually observed in the game\./u);

  const chat = await mountedSystemPrompt("chat", addition);
  assert.equal(
    chat.includes(SENTINEL_PROMPT_ADD),
    false,
    "the addition is the Game surface's own; a Chat mount that read it would show a setting its own group does not",
  );
});

/**
 * The preset's `main` entry reaches the prompt the Game runtime INSTALLS, and never the Chat one.
 *
 * This is the wiring assertion, not the reader's: `gameSessionPreset` could answer perfectly and the runtime could
 * still never append the segment. Reading `runtime.session.systemPrompt` is reading what the mounted session holds,
 * which is the same fact `game-surface-prompt-floor.test.ts` measures against for a preset-less root.
 *
 * The preset's `main` names a SYSTEM segment (`system_prompt: true` in `before`), so the system prompt is where it
 * belongs - and it arrives framed UNDER the floor, never in place of it.
 */
test("the shipped preset's `main` entry reaches the compiled Game prompt, framed under the floor, and not the Chat one", async () => {
  const addition = "收完土豆再去矿洞。";
  const game = await mountedSystemPrompt("game", addition, { mountPreset: true });
  assert.match(game, /<<<PRESET MAIN>>>/u, "a mounted preset's main entry must reach the installed Game prompt");
  assert.match(game, /【预设总纲（Preset Main）】/u);
  assert.ok(
    game.includes("你正在扮演星露谷物语中与"),
    `the preset's own first line must ride inside the frame; the prompt carried ${JSON.stringify(game.slice(-400))}`,
  );
  // Under the floor, not over it: the frame's ordering clause is part of the same appended block.
  assert.match(game, /cannot add to, take away from, or loosen what is stated above/u);
  assert.ok(
    game.indexOf("<<<PRESET MAIN>>>") < game.indexOf("<<<END PRESET MAIN>>>"),
    "the delimiter must open before it closes",
  );

  const chat = await mountedSystemPrompt("chat", addition, { mountPreset: true });
  assert.equal(
    chat.includes("<<<PRESET MAIN>>>"),
    false,
    "a Chat mount must not read the Game surface's preset: the ruling is about the Game surface, and honouring it on Chat would change how stored conversations are assembled",
  );
});

/**
 * The preset tail bound is the CONSUMER's, and this is the assertion that keeps it so.
 *
 * `preset-tail-block.ts` refuses a preset's post-history entry above `PRESET_TAIL_PUBLICATION_BYTE_BOUND`, which is a
 * copy of the vendored publication's number. A copy is only safe if it cannot drift silently: if upstream ever moves
 * that bound, this fails and names both numbers, instead of the Host publishing an entry the vendor then refuses -
 * which would take a live Game session down at the one layer nobody can fix from here.
 */
test("the preset tail bound is the vendored publication's own number, not a second opinion", async () => {
  const { MAX_POST_HISTORY_INSTRUCTIONS_BYTES } = (await import("@cortexkit/pi-magic-context/tavern")) as {
    MAX_POST_HISTORY_INSTRUCTIONS_BYTES: number;
  };
  assert.equal(
    PRESET_TAIL_PUBLICATION_BYTE_BOUND,
    MAX_POST_HISTORY_INSTRUCTIONS_BYTES,
    `the Host refuses a preset tail at ${String(PRESET_TAIL_PUBLICATION_BYTE_BOUND)} bytes while the vendor refuses it at ${String(MAX_POST_HISTORY_INSTRUCTIONS_BYTES)}: an entry between the two would pass here and fail there`,
  );
});

/**
 * A preset that repeats a line of the floor is REPORTED, and both copies are still sent.
 *
 * The operator's ruling is "apply the preset", not "apply it where convenient", so this is the one behaviour that
 * cannot be inferred from the reader: the runtime has to say the overlap out loud, name the floor's own line, and keep
 * both texts. A fixture preset is used because the SHIPPED one does not overlap the floor - and a test that only ever
 * runs the shipped file would never exercise the branch that matters when somebody mounts a different preset.
 *
 * The same mount also exercises the run's own publication line, which states what the runtime applied - the answer to
 * "did the run load the preset?" that used to require reading code.
 */
test("a preset whose `main` repeats a floor sentence prints `preset_overlap`, keeps both, and publishes the run's line", async () => {
  const root = await canonicalTestRoot("gamebuddy-prompt-delivery-overlap-");
  const { runtimeCwd } = resolveRuntimePaths(IDENTITY as never, root);
  await mkdir(runtimeCwd, { recursive: true });
  const floorLine = "Only state what you actually observed in the game.";
  const document = JSON.parse(readFileSync(SHIPPED_COMPANION_PRESET_PATH, "utf8")) as {
    prompts: { identifier: string; content?: string }[];
  };
  await writeFile(
    join(runtimeCwd, GAME_SESSION_PRESET_FILE),
    JSON.stringify({
      ...document,
      prompts: document.prompts.map((entry) =>
        entry.identifier === "main" ? { ...entry, content: `${entry.content ?? ""}\n${floorLine}` } : entry,
      ),
    }),
    "utf8",
  );

  const captured: string[] = [];
  const stderr = process.stderr as unknown as { write: (...args: unknown[]) => boolean };
  const original = stderr.write.bind(process.stderr);
  stderr.write = (chunk: unknown, ...rest: unknown[]) => {
    captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  };
  let prompt: string;
  try {
    const runtime = await createCompanionRuntime(
      IDENTITY,
      root,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      "game_surface_overlap",
      undefined,
      "game",
    );
    try {
      prompt = runtime.session.systemPrompt;
    } finally {
      runtime.session.dispose();
    }
  } finally {
    stderr.write = original;
  }

  const log = captured.join("");
  const overlapLines = log.split("\n").filter((line) => line.startsWith("preset_overlap:"));
  assert.equal(
    overlapLines.length,
    1,
    `expected exactly one overlap report, the log carried ${JSON.stringify(overlapLines)}`,
  );
  assert.match(
    overlapLines[0] ?? "",
    /^preset_overlap:system:main:preset=\d+ch:floor=\d+ch:anchor=Only state what you actually observed in the game\.$/u,
  );

  // Both kept: the floor's own line, and the preset's copy inside the frame.
  assert.ok(prompt.includes(floorLine), "the floor's sentence must not be removed to make room for the preset's copy");
  const framed = prompt.slice(prompt.indexOf("<<<PRESET MAIN>>>"), prompt.indexOf("<<<END PRESET MAIN>>>"));
  assert.ok(framed.includes(floorLine), "the preset's copy must not be dropped because the floor already says it");
});
