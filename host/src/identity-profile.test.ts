import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EXPRESSION_ONLY_ACTION_IDS, STARDEW_ACTION_TOOL_NAMES } from "./action-registry.js";
import { GAME_DELIVERY_PACING } from "./companion-delivery-pacing.js";
import { buildGameCompanionSystemPrompt } from "./game-surface-prompt-floor.js";
import { BUILDER_METHODS, MOUNTED_GAME_SURFACE_TOOL_NAMES } from "./game-surface-prompt-floor.test-support.js";
import { SLEEPING_IS_AN_ACTION } from "./games/stardew/prompt/stardew-game-conduct.js";
import {
  createIdentityProfileBinding,
  DEFAULT_IDENTITY_PROFILE,
  identityProfileHash,
  validateIdentityProfile,
  writeIdentityProfile,
} from "./identity-profile.js";
import { buildChatCompanionSystemPrompt } from "./companion-prompt-assembly.js";
import { CHAT_SURFACE_DIVERGENCE, COMPANION_ACTION_SYNTAX } from "./chat-surface-block.js";
import { DEFAULT_COMPANION_PRESET } from "./tavern/default-companion-preset.js";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";

const REPOSITORY_ROOT = (() => {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(directory, "assets", "tavern", "presets"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("repository_root_not_found");
    directory = parent;
  }
})();

/**
 * The preset `main` text, read from the file a session mounts.
 *
 * A rule that left the framework or the card is re-derived from the document that states it now, so this file never
 * carries a second copy of authored prose that would go stale the moment the preset is rewritten.
 */
function presetMainText(file = "amber-chat.json"): string {
  const document = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "assets", "tavern", "presets", file), "utf8")) as {
    prompts?: readonly { identifier?: string; content?: string }[];
  };
  for (const prompt of document.prompts ?? []) if (prompt.identifier === "main") return prompt.content ?? "";
  throw new Error(`${file} has no main entry`);
}

test("IdentityProfile canonical hash is stable", () => {
  const hash = identityProfileHash(DEFAULT_IDENTITY_PROFILE);
  assert.match(hash, /^[a-f0-9]{64}$/);
});

test("buildChatCompanionSystemPrompt and buildGameCompanionSystemPrompt render pure character persona without companion_text", () => {
  const chatPrompt = buildChatCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.doesNotMatch(chatPrompt, /companion_text/);
  assert.doesNotMatch(chatPrompt, /private/);
  // Chat surface: the Chat block opens the prompt, then the identity block - no framework head at all. The fourth wall
  // is the Chat BLOCK's now, not the head's: it is false on a surface whose preset names the game.
  assert.ok(
    chatPrompt.startsWith(CHAT_SURFACE_DIVERGENCE),
    "the Chat prompt opens with the Chat surface's own block, because the framework writes no head",
  );
  assert.doesNotMatch(chatPrompt, /fictional roleplay chat/);
  assert.doesNotMatch(chatPrompt, /Stay in character/);
  assert.match(chatPrompt, /\[Character: GameBuddy Companion\]/);
  // The head names nobody and prescribes no form: both were the card's, and both were said twice. Re-derived from the
  // card rather than dropped - the two facts still have to REACH the prompt, from the layer that owns them.
  assert.doesNotMatch(chatPrompt, /^You are /u, "the head no longer states the binding");
  assert.doesNotMatch(chatPrompt, /in the first person/u, "the head no longer states the form");
  const shipped = DEFAULT_COMPANION_PRESET.profile;
  const shippedChat = buildChatCompanionSystemPrompt(shipped);
  assert.ok(
    shippedChat.includes(`[Character: ${shipped.identity.name}]`),
    "her name reaches the prompt as the identity block, which is where the card's `data.name` renders",
  );
  // The address is the card's first line, and it arrives through `characterVoice` - macro-rendered, so the fragment is
  // what is asserted rather than the stored text.
  const directive = shipped.characterVoice?.text ?? "";
  assert.match(directive, /始终使用第一人称/u, "the card's own directive states the first person");
  assert.match(directive, /称呼直接叫「你」/u, "and that she addresses the player directly");
  assert.match(shippedChat, /始终使用第一人称/u, "and it reaches the prompt the player's session runs on");

  // The head is GONE, and this is what proves it rather than a phrase list: the Chat block is followed IMMEDIATELY by
  // the identity block (nothing of the framework's sits between them), and both surfaces carry the same tail from the
  // identity block onward, so one assembly differs between them only by the surface's own block.
  assert.equal(
    chatPrompt.indexOf("[Character: GameBuddy Companion]"),
    chatPrompt.indexOf(CHAT_SURFACE_DIVERGENCE) + CHAT_SURFACE_DIVERGENCE.length + "\n\n".length,
    "the Chat block is followed immediately by the identity block: the framework writes no head",
  );
  const gamePrompt = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  const identityTail = (prompt: string): string => prompt.slice(prompt.indexOf("[Character: GameBuddy Companion]"));
  assert.equal(
    identityTail(gamePrompt),
    identityTail(chatPrompt),
    "both surfaces render the same identity/card tail: they differ only by the surface's own block",
  );
  assert.doesNotMatch(gamePrompt, /companion_text/);
  assert.doesNotMatch(gamePrompt, /private/);
  assert.match(gamePrompt, /\[Character: GameBuddy Companion\]/);
});

test("the Game conduct forbids claiming an NPC reaction the game never reported, and the persona layer states it", () => {
  // Prompt-side half of the presence loop: two real live runs narrated an NPC
  // reaction ("她那个开心劲儿" / "连眼睛都弯了") while the gift receipt recorded
  // showed_response=false — the game never staged any reaction to read. The
  // detector lives in tools/lib/companion-interaction-gate.mjs; this pins the
  // guidance that stops the model from needing it. 2026-11-23: the guidance left the
  // floor for the layer that owns who she is - the Game preset's Main - because "state
  // only what the game reported" is a claim about her, not about what a block means;
  // the preset already said it one noun narrower ({{user}}'s reactions are his), so it
  // was widened there rather than stated a second time beside it.
  const gamePrompt = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.doesNotMatch(gamePrompt, /Only state what you actually observed/);
  assert.doesNotMatch(
    gamePrompt,
    /never claim an NPC smiled, beamed, was delighted, or said something on your account/,
  );
  assert.match(
    presetMainText("amber-game.json"),
    /没真的看到|别替人家编/u,
    "the observation contract has to be stated by the layer that owns it, or the deletion was a loss rather than a move",
  );
  // A third live run answered that instruction by reading the receipt's wire
  // format to the player ("（gift_given）…quest_25_completed 还是 false"), so the
  // conduct must also say which language to use, not just what to assert.
  assert.match(gamePrompt, /Speak in the player's language, never in the game's internal one/);
  assert.match(gamePrompt, /say what they MEAN to a person instead of reading them out/);
});

test("the Game floor carries no rule about speaking while she works, and the card still forbids step reports", () => {
  // Real live runs measured the opposite failure from the two above: the conduct
  // said "never narrate your own actions", and A/B runs of the same task produced
  // zero companion words across a whole multi-action chain (2/2 tool messages
  // with no text), leaving the player in silence for the length of the task. The
  // floor then permitted a short remark and bounded it - permission, count and
  // delivery claim, all three about her speech. 2026-11-22 left them to the layer
  // that owns her voice: the card's directive (不报进度 / 拒绝工作汇报与行程报备), which a
  // Game session mounts as `characterVoice`.
  const game = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  for (const gone of [
    /You may speak while you work/u,
    /never list your steps/u,
    /A brief remark goes a long way/u,
    /the surface carries one per reply/u,
    /silence while thinking is fine/u,
  ])
    assert.doesNotMatch(
      game,
      gone,
      `${String(gone)} is a rule about when or how much she speaks, and the floor owns none`,
    );
  const shipped = buildGameCompanionSystemPrompt(DEFAULT_COMPANION_PRESET.profile);
  assert.match(
    shipped,
    /不报进度/u,
    "the card's own ban on progress reports has to reach the prompt the player's Game runs on",
  );
  // Body language is routed to a channel the Agent can actually call. Three pins went stale here in a row, one per
  // attempt: the conduct first named `express_emote` / `face_direction` (the Mod's bare ids, which are not tools), then
  // `stardew_express_emote` / `stardew_face_direction` while a plan surface dropped them, then the plan step while
  // expression stayed a work-shaped route. Each pin asserted a literal that was true of some other surface. What it
  // asserts now is the channel the mounted set really carries - the two tools the registry declares expression-only -
  // and the route that is gone; `action-route-gate.test.ts` holds the population.
  assert.match(game, /Body language has its own tool/);
  assert.match(game, /stardew_express_emote` raises an overhead emote balloon/);
  assert.match(game, /stardew_face_direction` turns you to a cardinal direction/);
  assert.doesNotMatch(game, /Body language is an action in the plan you submit|never a tool of its own/);
  // And the parenthesis rule is the surface's own fact, stated as what it does:
  // a bracket tag is audio the voice channel performs, so a body action written
  // there is never performed and only reaches the player as prose.
  assert.match(game, /audio tag the voice channel performs instead of speaking/);
  assert.doesNotMatch(game, /Never narrate your own actions step by step/);
});

test("the Game floor states the bubble and asks for no line on any turn", () => {
  // Measured 2026-10-27, audit of a chain-fixed run: `firstPieceTtfbMs = 88,532` over
  // a 130 s run whose first SIXTEEN assistant messages were pure `toolCall` turns with
  // no text field at all. The renderer was not withholding anything - the Game
  // observer already releases one line per reply (`native-companion-content.ts`,
  // the `messageSentences[0] ?? messageAccumulator.flush()` branch under
  // `stopReason === "toolUse"`, plus the 3 s silence timer). The floor's answer was to
  // ask for that line on every turn, which is how a wake-up-say-one-thing-stop loop got
  // into the prompt; 2026-11-22 removed it, and the surface's delivery is stated as what
  // it is: one bubble, its size, and nothing about how many lines a reply owes. THE SIZE LEFT TOO (2026-11-24): 80 was
  // neither the transport's 4,000 nor the bubble's ~34 glyphs, and the delivery now cuts only at the wire's bound, so the
  // prompt states no size at all. The negative below is the guard, and `game-surface-prompt-floor.test.ts` holds it
  // against the delivery itself, one turn either side of the ceiling.
  //
  // WHEN a line belongs is the persona's: the card says 说完就停, and the preset the Game
  // surface mounts says what she does about it. `conversational-stance-gate.test.ts` reads
  // every rule in the floor and fails on any that states a moment or a count.
  const game = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.doesNotMatch(game, /One bubble holds \d+ characters/u, "a stated bubble size is a number she budgets by");
  assert.doesNotMatch(game, /the surface carries one per reply/);
  assert.doesNotMatch(game, /say it as you begin a stretch of work/);
  assert.doesNotMatch(game, /work quietly until you are done/);
  // The licence is exactly what the sixteen silent messages followed; it must not return.
  assert.doesNotMatch(game, /silence while thinking is fine/);
  assert.doesNotMatch(game, /better than filling every gap/);
  assert.doesNotMatch(game, /never list your steps/);
  assert.doesNotMatch(game, /not an inventory of your own procedure/);
});

test("the step-list and chore-recital bans are the card's now, and the floor does not restate them", () => {
  // Measured 2026-10-28 (live run game-1793179432152): nine thinking blocks carried say/speak intent and at least three
  // drafted a publishable line; the longest judged one a "step list" and called a tool instead. The floor's answer was a
  // boundary inside its own ban - one intent is company, the sequence is the inventory. That boundary, and the ban,
  // are the card's sentences (不报进度 / 不数第几颗 / 拒绝工作汇报与行程报备), so the floor states neither.
  const game = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.doesNotMatch(game, /One thing you are about to do is not a list/);
  assert.doesNotMatch(game, /is the inventory this forbids/);
  assert.doesNotMatch(game, /never list your steps/);
  assert.doesNotMatch(game, /work quietly until you are done/);
  // The RECITAL half of what `observed_only` used to state is the same claim one layer down: the card's 浇了是湿的、敲了是碎的、箱子里有几颗
  // 抬眼就看得见 says why a report of finished chores is noise, and the floor said it a second time. (The rule itself left
  // the floor for the preset on 2026-11-23; the recital detector is still the guard that keeps the ban from coming back.) The detector is the
  // CLASS rather than the sentence, and the two samples below are what prove it fires on the rule that was there and on
  // a rewording nobody wrote.
  const RECITAL = /never (?:audit|recite|list|report)[^.]*completed|inventory of completed|never list the chores/iu;
  for (const sample of [
    "never audit, recite, or list completed chores.",
    "Never report completed work back; your partner saw the field.",
  ])
    assert.match(sample, RECITAL, `the recital detector does not fire on "${sample}", so its silence proves nothing`);
  assert.doesNotMatch(
    game,
    RECITAL,
    "the card's 不报进度 already forbids a report of finished chores, so the floor must not restate it",
  );
  assert.match(DEFAULT_COMPANION_PRESET.profile.characterVoice?.text ?? "", /不报进度/u);
});

test("the Game floor does not command speech before every action, so the card keeps the turn's form", () => {
  // Removed 2026-11-11 (round46b: 36 minutes over 2 in-game days): the floor ordered her to "always deliver a spoken
  // remark ... before calling any action or planning tool", and the run answered it with 132 bubbles over 93 prompt
  // turns - 90 of them standalone speech with no tool call in the same message, one every 16 seconds. Then, 2026-11-22,
  // the rule's replacement ("land your first reaction on what they said") left too: a state-triggered line is the same
  // defect from the other side. The ordering is the card's own sentence (先接住人), which every Game session mounts.
  const game = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.doesNotMatch(game, /Speak before you act/);
  assert.doesNotMatch(game, /Never run tools in total silence/);
  assert.doesNotMatch(game, /land your first reaction on what they said/);
  assert.doesNotMatch(game, /One bubble holds \d+ characters/u, "the floor describes no box for her to budget by");
  assert.doesNotMatch(game, /One utterance per reply/);
  assert.match(buildGameCompanionSystemPrompt(DEFAULT_COMPANION_PRESET.profile), /先接住人/u);
});

test("the Game conduct names how a day ends, so going to bed is an act rather than a guess at an action id", () => {
  // Measured 2026-10-28 (run game-1793210285549, day 5). At in-game 22:00, standing in the
  // farmhouse, the companion's own thinking read: "Going to bed would be good. Let me check if
  // there's a sleep action. ... I don't know the action id. Let me not risk it; a brief line is
  // fine." It said "屋里十点了，我把灯拧小点……" and nothing moved. The engine's 02:00 pass-out took
  // the night, and `advance_day` - published, live-verified, and a plan-builder method - was never
  // dispatched. The scenario text HAD said 只在嘴里说一句“我睡了”而身体没躺下，天不会自己过去, so the
  // companion knew announcing was not the act; what nothing said is that the day's end is an
  // ACTION at all, in the same vocabulary as every other action. It went looking for one named
  // "sleep", found none, and chose silence.
  //
  // RE-DERIVED, NOT DELETED. This case used to assert the sentence "The day ends by going to bed and
  // sleeping, and that is an action like any other", which a later rewrite of the rule replaced: it was
  // red against a tree that carried the fact, which is a test that has stopped working - it would have
  // stayed red until someone deleted it, or gone green the moment the rule and this case were deleted
  // together. The fact is `SLEEPING_IS_AN_ACTION`'s now, so what is asserted here is the JOIN between
  // that rule and the prompt the player's Game runs on, and between the call it shows and the plan
  // surface's own vocabulary.
  const game = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.ok(
    game.includes(SLEEPING_IS_AN_ACTION),
    "floor_rule_left_the_prompt:SLEEPING_IS_AN_ACTION - the rule that says how a day ends is declared but never composed into the Game prompt, so going to bed is a guess at an action id again",
  );
  // THE FAILURE ITSELF, ruled out as the mechanism: a spoken goodnight leaves the day untouched.
  assert.match(game, /leaves the day exactly where it was/);
  // WHERE the day ends is stated by this rule and by nothing else now: the companion walked off into the
  // fields to sleep because nothing said the bed is inside, and a rule deleted on the belief that another
  // said it would leave her standing at the farmhouse door. (`BED_IS_INSIDE` left the floor on 2026-11-23
  // for the Mod's refusal - `SleepAndAdvanceDayLifecycle.cs` answers `not_home` - and this clause is what
  // the floor still owes her: walk inside first.)
  assert.match(
    game,
    /after entering the farmhouse/u,
    "the floor no longer says the day ends inside the farmhouse, so the bed is somewhere in the valley",
  );
  // AND THE ACTION ID IS NOT A GUESS. The measured failure was a body looking for an action named "sleep"
  // and giving up, so the id this rule teaches is resolved against the plan builder's real vocabulary - the
  // method list the live surface's own registrations produce - rather than accepted because it reads well.
  const taught = /builder\.([a-z_]+)\(\)/u.exec(SLEEPING_IS_AN_ACTION)?.[1];
  assert.ok(
    taught !== undefined,
    "the rule that says the day's end is an action no longer names the plan call that makes it one",
  );
  assert.ok(
    BUILDER_METHODS.includes(taught),
    `floor_teaches_an_unknown_action:builder.${taught}() - the plan surface publishes ${String(BUILDER_METHODS.length)} methods and ${taught} is not one of them, so the one call this rule shows is refused as plan_script_unknown_action`,
  );
  // It stays a fact about how a day ends, never a nightly duty: the conduct already grounds the
  // clock and the 02:00 pass-out, and an order to sleep at a stated hour would be the per-turn
  // obligation no card asked for.
  assert.doesNotMatch(game, /you must (go to bed|sleep)/iu);
  // The mechanism is NOT named as an id either. That arm is already held elsewhere rather than
  // restated here: `dialogue-web/tests/prompt-tool-name-gate.test.mjs` (prompt-tool.2) reads the
  // registry's ids and fails a bare `advance_day` on any line that names no mounted tool carrying
  // it, and prompt-tool.1 fails a `stardew_*` name no module declares - both derived from the
  // authorities, so neither goes stale.
  // Chat has no day to end, so it carries none of this.
  assert.doesNotMatch(buildChatCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE), /The day ends by going to bed/u);
});

test("the system prompt states the action syntax and no longer prescribes the turn's form", () => {
  // Owner ruling: "the prompt governs the floor, the card governs the form; anything
  // that governs form gets deleted." Two shared constraints prescribed the SHAPE of a
  // turn and each one beat the card. The chat prompt capped a reply at "a few
  // sentences at most" and steered it away from action ("sharing thoughts and
  // impressions rather than step-by-step actions"); the Chat divergence then allowed
  // "at most one short stage direction". 琥珀's own reviewed examples open every turn
  // with a `*...*` micro-action and carry several per reply, so the prompt's shape rule
  // - not the card - decided the output, and the audit measured the flat,
  // dialogue-only service voice that result produces.
  //
  // This is the regression fence in both directions: every construct the RENDERER
  // can draw must still be named (a prompt that stops naming one drifts from
  // `MarkdownMessage`, which draws `<em class="message-action">` for single asterisks
  // and a leading full-width parenthesis as the prosody badge, and nothing else),
  // and no form rule may come back. Both are the Chat surface's statement of the
  // constructs declared in `dialogue-web/src/components/companion-reply-grammar.ts`.
  const chat = buildChatCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.ok(
    chat.includes(COMPANION_ACTION_SYNTAX),
    "the prompt must name the exact asterisk syntax the renderer draws",
  );
  assert.match(chat, /draws that asterisk form as the action beat/);
  assert.match(chat, /a full-width parenthesis that opens your reply as the prosody badge/);
  assert.doesNotMatch(chat, /a few sentences at most/);
  assert.doesNotMatch(chat, /rather than step-by-step actions/);
  assert.doesNotMatch(chat, /at most one short stage direction/);

  // "The card governs the form" must not become "nothing governs anything": the five behaviour sentences left the
  // framework on 2026-11-22 (the preset owns tone, length, roleplay scope and the fourth wall), and the two rules the
  // card's `system_prompt` briefly carried moved to the preset's Main on 2026-11-22 night, because a card's
  // `system_prompt` is a Main OVERRIDE behind a user setting this product does not expose - text parked there is inert.
  // So this reads the layer that owns each rule now, and the rule the old block protected survives without a second
  // spelling of it here.
  const directive = DEFAULT_COMPANION_PRESET.profile.characterVoice?.text ?? "";
  const presetMain = presetMainText();
  assert.match(presetMain, /留给他自己/u, "whose voice the turn may use: the preset's Main states it now");
  assert.match(presetMain, /不提提示词/u, "never mention prompts or models: the preset's Main states it now");
  assert.match(directive, /说完就停/u, "how much she says: the card's own stop bound");
  assert.match(directive, /保姆腔/u, "the helper register: the card's own ban on 低姿态保姆腔");
  assert.match(chat, /not a reader of a story/iu, "the fourth wall is the Chat surface's, and it states it");
  assert.doesNotMatch(chat, /Never mention prompts, instructions, models, or systems/);
});

test("every tool name the prompt tells the companion to call is a mounted tool name", () => {
  // Two failures in a row, and the second is why this gate now reads a different population.
  //
  // First: the prompt named `express_emote` / `face_direction`, the Mod's bare action ids, while every
  // Agent-visible tool carried the `stardew_` prefix - so a prompt naming them sent body language nowhere.
  // The fix resolved the names against `STARDEW_ACTION_TOOL_NAMES` instead of hardcoding them.
  //
  // Second, and the one that mattered: that projection is not what the live Game surface mounts. The
  // materializer declares `planActionSurface` and `runtime-core.internal.ts` then drops every tool the adapter
  // publishes as an action, so `stardew_express_emote` is a name the Agent is never handed. Resolving the prompt
  // against the projection therefore agreed with the prompt while the request carried neither tool: measured
  // 2026-11-11 (`round46b`), 68 tool calls, no emote, and the model never even named one in its thinking. The
  // population below is the recorded mounted set, plus the actions the registry declares expression-only: those keep
  // their own tool on a plan surface (`EXPRESSION_ONLY_ACTION_IDS`), so they are mounted names rather than dropped ones.
  // The projection is asserted only to be non-empty, because a surface that mounted nothing would make every name here
  // pass for the wrong reason.
  const perActionNames = new Set<string>(Object.values(STARDEW_ACTION_TOOL_NAMES));
  assert.ok(
    perActionNames.size > 0,
    "the per-action tool projection must exist for the negative below to mean anything",
  );
  const expressionOnlyNames = new Set<string>(
    EXPRESSION_ONLY_ACTION_IDS.map((actionId) => STARDEW_ACTION_TOOL_NAMES[actionId]),
  );
  const droppedPerActionNames = new Set<string>([...perActionNames].filter((name) => !expressionOnlyNames.has(name)));
  const mounted = new Set<string>(MOUNTED_GAME_SURFACE_TOOL_NAMES);
  assert.ok(
    mounted.size > 0,
    "the recorded mounted Game tool set is empty, so every name would pass for the wrong reason",
  );

  const game = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  const gameNamed = game.match(/stardew_[a-z_]+/gu) ?? [];
  assert.ok(gameNamed.length > 0, "the Game conduct names no tool at all, so there is no channel to check");
  for (const name of gameNamed) {
    assert.ok(
      !droppedPerActionNames.has(name),
      `the Game prompt names ${name}, a per-action tool the plan surface drops: the Agent is handed ` +
        `${MOUNTED_GAME_SURFACE_TOOL_NAMES.join(", ")} instead, and body language is a mounted tool of its own`,
    );
    assert.ok(mounted.has(name), `the Game prompt names a tool the live Game surface does not mount: ${name}`);
  }

  // Chat mounts no game tool at all, so its prompt may name none of them.
  const chatNamed = buildChatCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE).match(/stardew_[a-z_]+/gu) ?? [];
  assert.deepEqual(chatNamed, [], "the Chat surface mounts no Stardew tool, so its prompt cannot name one");
});

test("the Game floor carries no pacing bound at all", () => {
  // The old ruling removed a length ("keep each remark to a few words") and a count of
  // actions ("One quick remark between actions is plenty"), and then a pacing bound
  // survived in three more spellings. All of them are the persona's: the floor states
  // nothing about how often or how much she says, and nothing about the size of the box
  // either (below).
  const game = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  for (const gone of [
    /Keep lines short and conversational/u,
    /a few words/u,
    /One quick remark between actions/u,
    /A brief remark goes a long way/u,
    /never list your steps/u,
    /You may speak while you work/u,
  ])
    assert.doesNotMatch(game, gone, `${String(gone)} paces her speech, which the persona owns`);
});

test("the Game floor states no bubble ceiling, because it describes no surface", () => {
  // Measured against the three surfaces the deleted rule named at once: the presentation transport carries 4,000
  // characters (`MAX_COMPANION_PRESENTATION_TEXT_CHARS`, the Mod's own `MaximumPresentationTextLength`), the bubble draws
  // two lines of 448 px - about 34 CJK glyphs - and clamps itself with a visible `…`, and the chat line keeps the whole
  // text for scroll-back. "One bubble holds 80 characters" was 50× the first divided by 2× the second, so a compliant
  // 79-character line already ended in `…` on screen, and on `round62` the number deleted 18 turns' tails for it. The
  // delivery now cuts at the transport's own bound (`companion-delivery-pacing.ts`), and no size is stated to her at all.
  const game = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.doesNotMatch(game, /One bubble holds \d+ characters/u, "a stated bubble size is a number she budgets by");
  assert.doesNotMatch(game, /past the bubble's ceiling is deleted/u, "and the deletion past it is the same claim");
  const budget = GAME_DELIVERY_PACING.lengthBudget;
  assert.ok(budget !== null, "the Game surface still declares the transport's bound, so delivery stays bounded");
  assert.ok(
    game.length > 0 && !game.includes(String(budget.maxChars)),
    "the prompt must not restate the transport's number either: it is the wire's, not something she can act on",
  );
  // Layout is the preset's as of 2026-11-23: markdown, lists and 首先/其次/最后 were a FORMAT rule wearing a channel's
  // clothes, so they left the floor for the layer that owns how a reply reads, and the floor states none of them.
  assert.doesNotMatch(game, /No markdown headings, lists, bold or block quotes/);
  const gamePresetMain = presetMainText("amber-game.json");
  assert.match(gamePresetMain, /排版/u, "amber-game.json no longer bans a reply's layout in her voice");
  assert.match(gamePresetMain, /首先其次最后/u, "and it no longer names the sequencing words a person does not say");
  // How MANY utterances one reply carries is the preset's (2026-11-15): the floor states no box, and
  // `conversational-stance-gate.test.ts` refuses a count here.
  assert.doesNotMatch(game, /say one thing per reply/);
  assert.doesNotMatch(game, /stop when it has been said/);
  assert.doesNotMatch(game, /首先/);
  assert.doesNotMatch(game, /总结/);
  // A bracketed beat is never a body: the parenthesis becomes audio the voice
  // performs, and an asterisk beat is dropped by the bubble entirely.
  assert.match(game, /Write no bracketed stage direction at all/);
  assert.match(game, /\*a sigh\*/);
  assert.match(game, /dropped from the bubble entirely/);
});

test("the Game conduct names the ids she may not say out loud, and keeps them where they do work", () => {
  // Measured on a live session: the companion said "我们带着 (T)Hoe 去 Town". The fact line was the source and is
  // fixed beside this (`formatGameEnvironmentFacts`, runtime-core.internal.ts), but the other half is speech: an id
  // is a handle for an action argument, never a word the player hears. The rule names the concrete failures - the
  // item identity, the mine's internal map name - and the word to say instead, because a bare "do not use ids" was
  // already covered by the machine-vocabulary line beside it and did not stop this one.
  const game = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.match(game, /Name the things you handle in words, never in the game's own ids/);
  assert.match(game, /\(T\)Hoe/);
  assert.match(game, /UndergroundMine10/);
  assert.match(game, /矿洞第 10 层/);
  // The ids are not banned outright: a plan argument and a snapshot comparison still need the exact value.
  assert.match(game, /ids keep their own place/);
  assert.match(game, /copied exactly into an action argument/);
  // Chat has no world and no such ids, so the rule stays on the Game surface.
  assert.doesNotMatch(buildChatCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE), /\(T\)Hoe/u);
});

test("the house's own form is the live line's, not a book entry waiting on a keyword", () => {
  // Measured 2026-11-05, day 2 at 18:00 in the starter farmhouse: the companion said
  // "六点了，锅里没东西可下，我烧壶水泡点茶对付一口算了" in a house with neither a kitchen nor a stove. The shipped
  // book DOES say so (`wb-entry-07`), but only behind a keyword-gated entry, and that sentence carries none of
  // its keys - so the entry could not fire on it. The floor answered with a rule about the starter house, and that
  // rule is gone: the Mod publishes the room instead, and `厨房: 有` / `厨房: 无` is read off its own
  // `cookingStationTargets` scan of the map she is standing on (`game-world-vocabulary.ts` `formatKitchen`).
  // `game-surface-prompt-floor.test.ts` holds that join - every fact the live line renders reaches her in
  // `<world-state>`, both polarities of the kitchen - so what is asserted HERE is that the rule did not come back
  // and that the book's entry is still the one an author can reach, not a keyword trap.
  const SENTENCE = "六点了，锅里没东西可下，我烧壶水泡点茶对付一口算了";
  const kitchenEntries = DEFAULT_COMPANION_PRESET.worldBook.entries.filter(
    (entry) => entry.constant !== true && /厨房|灶台/u.test(`${entry.title}${entry.content}`),
  );
  assert.ok(
    kitchenEntries.length > 0,
    "the shipped book is where the room's form was written; if it no longer says so, the premise below is the only carrier and this test has to name what replaced it",
  );
  for (const entry of kitchenEntries)
    assert.deepEqual(
      (entry.keys ?? []).filter((key) => SENTENCE.includes(key)),
      [],
      `${entry.entryId} would have fired on the measured sentence, so a keyword gate is not what cost that run`,
    );
  const game = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.doesNotMatch(
    game,
    /the starting house is one room|a kitchen with a stove|never cook, brew/u,
    "the room's form is the live line's every turn; a rule about the starter house is the second spelling that goes stale the day it is upgraded",
  );
  // Chat has no world and no room, so the premise must not follow the shared card onto that surface.
  assert.doesNotMatch(buildChatCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE), /kitchen|stove/u);
});

test("the Game floor no longer puts a line in a refusal, and the register is the persona's now", () => {
  // Two registers the companion falls into when it has no line for them: the
  // Mod's reason for a refusal (a live run read `gift_given` / `quest_25_completed`
  // aloud) and the host answering a customer ("好的，我这就为您……"). Both are
  // machine talk in the player's ear. The refusal half is the card's sentence now
  // (「遇上卡路、没体力、天黑，只讲眼前这道障碍，不讲原因、不讲规则」); the register half left this floor on
  // 2026-11-23 for the two layers that own tone, and it left AFTER the guards here could fail - the
  // card states the class in her own words and the Game preset states the wording, so a deletion that
  // lost the fact shows up as a red line below rather than as a quieter prompt.
  const game = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.doesNotMatch(game, /the player hears a person's reaction to the obstacle/);
  assert.doesNotMatch(game, /no reason code, no exhaustion threshold, no field name/);
  assert.match(
    DEFAULT_COMPANION_PRESET.profile.characterVoice?.text ?? "",
    /只讲眼前这道障碍/u,
    "the obstacle in her own words has to be stated by the layer that owns it, or the deletion was a loss",
  );
  assert.doesNotMatch(
    game,
    /never to a customer|customer-service warmth/iu,
    "the floor states the customer register again: tone is the persona's, and the floor may not command a register",
  );
  assert.doesNotMatch(game, /祝你玩得开心/u, "and the concrete service phrasing is the preset's, not the floor's");
  // THE CLASS, stated by the card the product actually mounts (`characterVoice` is in every Game prompt).
  assert.match(
    DEFAULT_COMPANION_PRESET.profile.characterVoice?.text ?? "",
    /保姆腔/u,
    "no layer bans the low-posture helper register any more, so the deletion was a loss rather than a move",
  );
  // THE WORDING, stated by the Game preset the surface mounts: a class on its own left the measured run
  // answering "好的，我这就为您……" in a service voice the card had banned in the abstract.
  const gamePreset = presetMainText("amber-game.json");
  assert.match(gamePreset, /不是客服/u, "amber-game.json no longer forbids the customer register in her voice");
  assert.match(gamePreset, /还有什么需要吗/u, "and it no longer names the closing offer of further help");
  // The two correctness lines this block already carried stay untouched as CLAIMS: an unobserved NPC reaction left for
  // the persona layer on 2026-11-23 (it is a claim about her, not about a block), and the emote channel is still the
  // floor's own - the first is asserted where it now lives (`presetMainText`), the second here.
  assert.doesNotMatch(game, /never claim an NPC smiled, beamed, was delighted, or said something on your account/);
  assert.match(presetMainText("amber-game.json"), /没真的看到|别替人家编/u);
  assert.match(game, /Body language has its own tool/);
});

test("the Game floor anchors the partner's turn nowhere, and the card states it (MaiBot & QQ bot simulation protocol)", () => {
  // The three sentences here were the floor's. Each is a rule about what she says or when: the person-first opening, the
  // ban on walkie-talkie telemetry, and the grounding in tangible specifics. All three are the card's now - the shipped
  // directive states them in her own words - and the floor states what the blocks mean instead.
  const game = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  assert.doesNotMatch(game, /land your first reaction on what they said/iu);
  assert.doesNotMatch(game, /walkie-talkie dispatcher|internal event logger/iu);
  assert.doesNotMatch(game, /Ground feelings in tangible specifics/iu);
  const card = DEFAULT_COMPANION_PRESET.profile.characterVoice?.text ?? "";
  assert.match(card, /第一句就落到他的句子上/u, "the card owns the person-first opening the floor may not state");
  assert.match(card, /不当对讲机/u, "and the ban on telemetry in her voice, which 2026-11-22 left to the card");
});

test("IdentityProfile rejects malformed or control-bearing content", () => {
  assert.throws(
    () => validateIdentityProfile({ ...DEFAULT_IDENTITY_PROFILE, revision: 0 }),
    /invalid_identity_profile/,
  );
  assert.throws(
    () =>
      validateIdentityProfile({
        ...DEFAULT_IDENTITY_PROFILE,
        identity: { ...DEFAULT_IDENTITY_PROFILE.identity, role: "bad\u0000role" },
      }),
    /invalid_identity_profile/,
  );
  assert.throws(
    () =>
      validateIdentityProfile({ ...DEFAULT_IDENTITY_PROFILE, examples: [{ user: "ok", companion: "bad\u0000reply" }] }),
    /invalid_identity_profile/,
  );
});

test("IdentityProfile canonicalizes a bounded reviewed persona guide", () => {
  const profile = validateIdentityProfile({
    ...DEFAULT_IDENTITY_PROFILE,
    profileId: "gamebuddy.companion.rin",
    persona: { core: "calm\nfocused\tand warm", interactionStyle: "listen first", expressionStyle: "brief" },
    examples: [{ user: "tired", companion: "let us slow down" }],
  });
  assert.equal(profile.persona?.core, "calm\nfocused\tand warm");
  assert.notEqual(identityProfileHash(profile), identityProfileHash(DEFAULT_IDENTITY_PROFILE));
});

test("IdentityProfile writes reject a replaced symlink target without touching the outside sentinel", async (t) => {
  const root = await canonicalTestRoot("gamebuddy-identity-profile-boundary-");
  const outside = await canonicalTestRoot("gamebuddy-identity-profile-outside-");
  const outsideFile = join(outside, "sentinel.json");
  const target = join(root, "identity-profile.json");
  try {
    await writeFile(outsideFile, "outside-sentinel", "utf8");
    try {
      await symlink(outsideFile, target, "file");
    } catch (error) {
      if (error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))) {
        t.skip("symlink fixture creation is unsupported");
        return;
      }
      throw error;
    }
    await assert.rejects(
      writeIdentityProfile(target, DEFAULT_IDENTITY_PROFILE, { containmentRoot: root }),
      /unsafe_path_boundary/,
    );
    assert.equal(await readFile(outsideFile, "utf8"), "outside-sentinel");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("IdentityProfile binding is opaque and never stores profile body", async () => {
  const root = await canonicalTestRoot("gamebuddy-identity-profile-");
  const binding = createIdentityProfileBinding("a".repeat(64), DEFAULT_IDENTITY_PROFILE, "session.jsonl");
  const path = join(root, "binding.json");
  await writeFile(path, JSON.stringify(binding), "utf8");
  const stored = await readFile(path, "utf8");
  assert.match(stored, /canonicalHash/);
  assert.doesNotMatch(stored, /GameBuddy Companion/);
  assert.doesNotMatch(stored, /continuity/);
});
test("IdentityProfile accepts long user-authored description up to the anti-blowup ceiling (product policy: never truncate)", () => {
  const longCore = "x".repeat(5_000);
  const profile = validateIdentityProfile({
    ...DEFAULT_IDENTITY_PROFILE,
    persona: {
      core: longCore,
      interactionStyle: "listen first",
      expressionStyle: "brief",
    },
    examples: [
      { user: "u".repeat(2_000), companion: "c".repeat(2_000) },
      { user: "u2", companion: "c2" },
      { user: "u3", companion: "c3" },
      { user: "u4", companion: "c4" },
      { user: "u5", companion: "c5" },
    ],
  });
  assert.equal(profile.persona?.core, longCore);
  assert.equal(profile.examples?.length, 5);
  // Only the physical anti-blowup ceiling (64 KiB chars) rejects.
  assert.throws(
    () =>
      validateIdentityProfile({
        ...DEFAULT_IDENTITY_PROFILE,
        persona: { core: "x".repeat(65_537), interactionStyle: "i", expressionStyle: "e" },
      }),
    /invalid_identity_profile/,
  );
});
