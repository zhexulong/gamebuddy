import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildWireContractReading,
  judgeCardVoiceOrdering,
  judgeGameToolAbsence,
  judgePostHistorySentinel,
  narrateWireContract,
  systemPromptOf,
  WIRE_CARD_VOICE_SENTINEL,
  WIRE_POST_HISTORY_SENTINEL,
  wireMessageText,
} from "./wire-contract.mjs";

/**
 * `STARDEW_ACTION_TOOL_NAMES` is the ONLY population assertion 2 may check: the registry is a closed
 * projection, so a hand-written list here would pass the day an action is added and never be looked at.
 * Read from the built registry (`host/dist-test`), which is the same artifact the harness family runs
 * against - importing `host/src/action-registry.ts` from a bare `.mjs` test would need a TS loader.
 */
const HOST_TEST_ROOT = join(fileURLToPath(new URL("../../../host/", import.meta.url)), "dist-test");

async function stardewToolNames() {
  const module = await import(pathToFileURL(join(HOST_TEST_ROOT, "action-registry.js")).href);
  const names = Object.values(module.STARDEW_ACTION_TOOL_NAMES);
  assert.ok(names.length > 0, "the registry declared no tool names, so the population assertion would be vacuous");
  return names;
}

/**
 * The Host floor anchor, read from the module that declares it. `COMPANION_ACTION_SYNTAX` is the one
 * asterisk form the Chat surface teaches, and it renders in the surface block that precedes the identity
 * block and the card's directive - so it is the floor's own position, not a sentence transcribed here.
 */
async function houseFloorAnchor() {
  const module = await import(pathToFileURL(join(HOST_TEST_ROOT, "identity-profile.js")).href);
  const anchor = module.COMPANION_ACTION_SYNTAX;
  assert.equal(typeof anchor, "string");
  assert.ok(anchor.length > 0, "the product declared no action syntax, so the floor has no anchor");
  return anchor;
}

/** One synthetic request in the shape Pi's `openai-completions` adapter posts. */
function request({ system = "You are a companion.", messages = [], tools = [] } = {}) {
  return {
    model: "gamebuddy-wire-capture",
    messages: [{ role: "system", content: system }, ...messages],
    tools,
  };
}

const USER = (text) => ({ role: "user", content: [{ type: "text", text }] });

test("the closing direction must be in the LAST message, not merely somewhere in the request", () => {
  // The position is the contract: the field is a per-turn tail appended after the transcript, which is
  // what lets an edited direction take effect on the next turn without moving the cached prefix. A
  // presence-only check passes on a copy that rode the system prompt and is wrong in the expensive way.
  const tail = request({
    messages: [
      USER("Good morning."),
      { role: "assistant", content: "Morning." },
      USER(`go\n${WIRE_POST_HISTORY_SENTINEL}`),
    ],
  });
  const ok = judgePostHistorySentinel({ request: tail });
  assert.equal(ok.state, "verified");
  assert.equal(ok.detail.messageIndex, 3);

  // The falsifier: the SAME sentinel, in the system prompt instead of the tail.
  const inHead = request({ system: `You are a companion.\n${WIRE_POST_HISTORY_SENTINEL}`, messages: [USER("hi")] });
  const head = judgePostHistorySentinel({ request: inHead });
  assert.equal(head.state, "failed");
  assert.equal(head.reason, "post_history_sentinel_not_last");

  // And a card whose record was never written: absent, which is a failure, not a gap - the request DID
  // arrive, so the missing field is the product's answer.
  const missing = judgePostHistorySentinel({ request: request({ messages: [USER("hi")] }) });
  assert.equal(missing.state, "failed");
  assert.equal(missing.reason, "post_history_sentinel_absent");

  // A request that never arrived is the one case that is a gap: nothing was observed.
  assert.equal(judgePostHistorySentinel({ request: undefined }).state, "unobserved");
  assert.equal(judgePostHistorySentinel({ request: undefined }).reason, "request_carried_no_messages");

  // Twice is also wrong: two tails means one of them is in a position the contract does not describe.
  const twice = request({ messages: [USER(WIRE_POST_HISTORY_SENTINEL), USER(WIRE_POST_HISTORY_SENTINEL)] });
  assert.equal(judgePostHistorySentinel({ request: twice }).reason, "post_history_sentinel_repeated");
});

test("a Game action tool name anywhere on the Chat wire is a failure, sourced from the registry", async () => {
  const gameToolNames = await stardewToolNames();
  // The population is read, not written: assert it is the registry's own and covers the action surface.
  assert.ok(gameToolNames.includes("stardew_express_emote"), "the registry no longer maps express_emote");

  const clean = [request({ messages: [USER("hi")] })];
  const ok = judgeGameToolAbsence({ requests: clean, gameToolNames });
  assert.equal(ok.state, "verified");
  assert.equal(ok.detail.checkedNames, gameToolNames.length);

  // Route 1: a DECLARED tool. Chat mounts `allowedToolNames = []`, so any Game name here is a leak.
  const declared = [
    request({ tools: [{ type: "function", function: { name: "stardew_express_emote", parameters: {} } }] }),
  ];
  const declaredVerdict = judgeGameToolAbsence({ requests: declared, gameToolNames });
  assert.equal(declaredVerdict.state, "failed");
  assert.equal(declaredVerdict.reason, "game_tool_declared_on_chat_wire");
  assert.deepEqual(declaredVerdict.detail.declared, ["stardew_express_emote"]);

  // Route 2: a MENTION. The declarative half passes this, which is why the message half exists: an
  // instruction to call a tool the surface never mounted is a lie in the product's own voice.
  const mentioned = [request({ messages: [USER("Use stardew_navigate_to_destination to walk over.")] })];
  const mentionedVerdict = judgeGameToolAbsence({ requests: mentioned, gameToolNames });
  assert.equal(mentionedVerdict.state, "failed");
  assert.equal(mentionedVerdict.reason, "game_tool_named_in_chat_prompt");
  assert.deepEqual(mentionedVerdict.detail.named, ["stardew_navigate_to_destination"]);

  // Not asked, and an empty population, are both gaps rather than passes.
  assert.equal(judgeGameToolAbsence({ requests: [], gameToolNames }).state, "unobserved");
  assert.equal(judgeGameToolAbsence({ requests: clean, gameToolNames: [] }).reason, "game_tool_name_population_empty");
});

test("the card's voice must sit AFTER the Host floor, not before it", async () => {
  const houseFloor = await houseFloorAnchor();
  const floorLine = `To show a gesture, write it exactly as ${houseFloor}.`;
  const ordered = [`You are a companion.`, floorLine, "【角色演出指导】", WIRE_CARD_VOICE_SENTINEL].join("\n");
  const ok = judgeCardVoiceOrdering({ systemPrompt: ordered, houseFloor });
  assert.equal(ok.state, "verified");
  assert.ok(ok.detail.cardVoiceIndex > ok.detail.floorIndex);

  // The falsifier: the same two sentences, the card's copy placed above the floor. A byte-count gate
  // reads this prompt as identical to the one above; only an ordering assertion can tell them apart.
  const inverted = [`You are a companion.`, WIRE_CARD_VOICE_SENTINEL, floorLine].join("\n");
  const invertedVerdict = judgeCardVoiceOrdering({ systemPrompt: inverted, houseFloor });
  assert.equal(invertedVerdict.state, "failed");
  assert.equal(invertedVerdict.reason, "card_voice_not_after_floor");

  // The floor anchor itself is supplied by the caller, from the product. If the surface stopped carrying
  // it, the ordering question has no reference point and saying "verified" would be an invented pass.
  const noFloor = `You are a companion.\n${WIRE_CARD_VOICE_SENTINEL}`;
  assert.equal(judgeCardVoiceOrdering({ systemPrompt: noFloor, houseFloor }).reason, "house_floor_anchor_absent");
  assert.equal(judgeCardVoiceOrdering({ systemPrompt: noFloor }).state, "unobserved");
  assert.equal(judgeCardVoiceOrdering({ systemPrompt: noFloor }).reason, "house_floor_anchor_not_supplied");
  assert.equal(judgeCardVoiceOrdering({ systemPrompt: "", houseFloor }).state, "unobserved");
});

test("the three judgements roll up to the worst state, and a missing capture is unobserved", async () => {
  const gameToolNames = ["stardew_express_emote"];
  const houseFloor = await houseFloorAnchor();

  // No request at all: every check is a gap, and the envelope must not read as a clean run.
  const nothing = buildWireContractReading({ requests: [], gameToolNames, houseFloor });
  assert.equal(nothing.state, "unobserved");
  assert.equal(nothing.requests, 0);
  assert.equal(
    nothing.checks.every((check) => check.state === "unobserved"),
    true,
  );

  // One failure outvotes two passes.
  const failing = buildWireContractReading({
    requests: [
      {
        body: request({
          system: `floor ${houseFloor}\n${WIRE_CARD_VOICE_SENTINEL}`,
          messages: [USER(`tail\n${WIRE_POST_HISTORY_SENTINEL}`)],
          tools: [{ type: "function", function: { name: "stardew_express_emote" } }],
        }),
      },
    ],
    gameToolNames,
    houseFloor,
  });
  assert.equal(failing.state, "failed");
  assert.equal(failing.checks.find((check) => check.id === "postHistoryReachesTail").state, "verified");
  assert.equal(failing.checks.find((check) => check.id === "cardVoiceAfterFloor").state, "verified");
  assert.equal(failing.checks.find((check) => check.id === "noGameToolOnChatWire").state, "failed");

  // The narration names every check and never the bytes.
  const narration = narrateWireContract(failing);
  assert.match(narration, /state=failed/u);
  assert.match(narration, /postHistoryReachesTail: verified/u);
  assert.match(narration, /noGameToolOnChatWire: failed \(game_tool_declared_on_chat_wire\)/u);
  assert.equal(narration.includes(WIRE_POST_HISTORY_SENTINEL), false, "the narration echoed prompt content");
});

test("systemPromptOf reads the system message and tolerates either content shape", () => {
  assert.equal(systemPromptOf(request({ system: "plain" })), "plain");
  assert.equal(systemPromptOf({ messages: [{ role: "system", content: [{ type: "text", text: "parts" }] }] }), "parts");
  assert.equal(systemPromptOf({ messages: [{ role: "user", content: "no system here" }] }), "");
  assert.equal(systemPromptOf(undefined), "");
  assert.equal(wireMessageText({ content: 42 }), "");
});

test("the sentinels are synthetic: no product asset carries them", async () => {
  // The assertions read "the string is present", so a sentinel that also appears in a shipped card or a
  // product module would pass with the field's writer removed. This is the guard that keeps the string
  // synthetic, and it is derived from the repository's own files rather than from a memory of them.
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const sources = [
    join(repositoryRoot, "assets", "tavern", "presets", "default-companion", "card.json"),
    join(repositoryRoot, "host", "src", "identity-profile.ts"),
    join(repositoryRoot, "host", "src", "tavern", "post-history-instructions.ts"),
  ];
  const houseFloor = await houseFloorAnchor();
  const digests = [];
  for (const path of sources) {
    const text = await readFile(path, "utf8");
    digests.push(createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12));
    assert.equal(text.includes(WIRE_POST_HISTORY_SENTINEL), false, `${path} already carries the post-history sentinel`);
    assert.equal(text.includes(WIRE_CARD_VOICE_SENTINEL), false, `${path} already carries the card-voice sentinel`);
    // The floor anchor is the opposite kind of constant: it MUST be in the product, or the ordering
    // assertion has no reference point.
    if (path.endsWith("identity-profile.ts"))
      assert.equal(text.includes(houseFloor), true, "the floor anchor is no longer declared by the product");
  }
  assert.equal(new Set(digests).size, digests.length, "two sources hashed equal, so the read is not per-file");
});
