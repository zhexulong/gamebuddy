import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import test, { before, after } from "node:test";

import { buildGameSurfaceAuthoredCatalog, materializeTavernAuthoredContextCatalog } from "./tavern/catalog-service.js";
import { createChatThreadStore, createProfileAwareChatThreadCreationCapability } from "./tavern/chat-thread-store.js";
import { TavernArtifactStore } from "./tavern/artifact-store.js";
import { macroTable } from "./tavern/macro-engine.js";
import { writeCompanionPostHistoryInstructions } from "./tavern/post-history-instructions.js";
import { resolveTavernPaths } from "./tavern/tavern-paths.js";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
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
async function chatTrailingMessage(catalog: Readonly<{ postHistoryInstructions?: string }>): Promise<string> {
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
    const trailing = await chatTrailingMessage(catalog);
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
 * The Game catalogue does NOT carry the closing direction, and that is a recorded product
 * decision rather than a wiring gap: `design/research/game-airp-review-2026-10-21.md:168` (R-2)
 * keeps the Game surface's closing direction open pending an A/B. The absence is asserted here
 * so the field cannot quietly appear on one surface only, and so that closing R-2 is a deliberate
 * edit to this assertion instead of an unnoticed one.
 */
test("the Game catalogue carries no closing direction, because R-2 has not been decided", () => {
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
async function mountedSystemPrompt(surface: "chat" | "game", addition: string): Promise<string> {
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
  assert.match(game, /Only state what you actually observed\./u);

  const chat = await mountedSystemPrompt("chat", addition);
  assert.equal(
    chat.includes(SENTINEL_PROMPT_ADD),
    false,
    "the addition is the Game surface's own; a Chat mount that read it would show a setting its own group does not",
  );
});
