import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_DELIVERY_PACING,
  CHAT_PACED_DELIVERY,
  GAME_DELIVERY_PACING,
  deliveryPacingFor,
} from "./companion-delivery-pacing.js";

/**
 * The stored preference is one record answering only "did the player turn it
 * on". These cases pin the composition rule that turns that answer into a
 * policy per surface, because getting it backwards would pace the transcript by
 * default and un-pace the bubble that needed it.
 */

test("game is paced by default and the player can turn it off", () => {
  assert.equal(deliveryPacingFor("game", false), CHAT_DELIVERY_PACING);
  assert.equal(deliveryPacingFor("game", true), GAME_DELIVERY_PACING);
});

test("chat is unpaced by default and the player can turn it on", () => {
  assert.equal(deliveryPacingFor("chat", false), CHAT_DELIVERY_PACING);
  assert.equal(deliveryPacingFor("chat", true), CHAT_PACED_DELIVERY);
});

test("turning it off is the same policy on both surfaces, and that policy paces nothing", () => {
  assert.equal(deliveryPacingFor("game", false), deliveryPacingFor("chat", false));
  assert.equal(deliveryPacingFor("chat", false).typing, null);
});

test("turning it on gives each surface its own policy, and both are paced", () => {
  const game = deliveryPacingFor("game", true);
  const chat = deliveryPacingFor("chat", true);
  assert.notEqual(game, chat);
  assert.notEqual(game.typing, null);
  assert.notEqual(chat.typing, null);
});

test("the chat-on policy keeps pacing and the sound, and shares the bubble vocabulary", () => {
  assert.notEqual(CHAT_PACED_DELIVERY.typing, null);
  assert.notEqual(CHAT_PACED_DELIVERY.reaction, null);
  assert.equal(CHAT_PACED_DELIVERY.reaction, GAME_DELIVERY_PACING.reaction);
});

test("the chat policy has no length budget, because a transcript row is one message", () => {
  assert.equal(CHAT_PACED_DELIVERY.lengthBudget, null);
  assert.notEqual(GAME_DELIVERY_PACING.lengthBudget, null, "a bubble still gets one");
});

test("an unset record delivers exactly what the surface delivered before pacing existed", () => {
  for (const surface of ["game", "chat"] as const) {
    const policy = deliveryPacingFor(surface, false);
    if (surface === "chat") {
      assert.equal(policy.typing, null);
      assert.equal(policy.reaction, null);
      assert.equal(policy.lengthBudget, null);
    }
  }
});
