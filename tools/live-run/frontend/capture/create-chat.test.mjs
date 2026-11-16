// red-proof: inject  answering landed:true after the click instead of after the surface appears -> `✖ a picker with no
//   commit control pressed creates nothing, and the answer says so` (tools/live-run/frontend/capture/create-chat.test.mjs)
// red-proof: inject  the landed reading back to "the conversation is somewhere on the page" instead of "the shell is
//   showing it" -> `✖ a create the shell never moves onto is not a landing, and the commit it pressed is named`
//   (tools/live-run/frontend/capture/create-chat.test.mjs)
// The create gesture the drivers share, and the premise it stands on.
//
// The first failure this exists for, measured on `shots-final55`: driver E pressed the opening card's prose
// five times, got five `clicked` answers, made no Chat, and the run reported a green `DONE-CAPTURE`
// with a one-row list - so E's second-row claims, its 41b/41c screenshots and driver K's whole switch
// were gone. The cause was `c55ea777`: the card became a container a player reads, selects and copies,
// and the commit moved onto `[data-testid="opening-option-commit"]`. Both drivers still clicked the
// prose, which commits nothing but still answers a click.
//
// The second, measured on `frontend-final-r2.stage`: six create attempts answered
// `committed_opening=null landed_in_the_new_chat=true` and the list still held one row. The commit
// control was never pressed, and `landed` was read from `[data-testid="chat-surface"]` - which is on
// the page on EVERY surface, because the conversation is the one peer the shell keeps mounted and
// PARKS (`ComposedReferenceGameApp`'s `.surface-slot-parked`: `visibility: hidden`, never removed, so
// the transcript keeps its scroll offset). A reading that cannot answer "no" answered "landed" for
// free. `createChat` therefore reads the surface the shell SHOWS, from the shell's own authority for
// it: the `panel` word in the URL.
//
// So three things are held here. The premise: the panel still publishes the control the kit presses,
// the card's prose is still not a control, and the conversation is still parked rather than removed.
// The answer: `createChat` reports whether a Chat really was created - read from the surface the shell
// lands on, never from a click that returned. And the refusal: a create the shell does not move onto
// is answered as one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createChat, REPO_ROOT } from "./common.cjs";

/*
 * Resolved by walking up to the directory that owns `.git` (`common.cjs`), not by counting `..`: the kit
 * used to sit at `tools/shots`, and the three `..` that were right there name `tools/` once the kit moved -
 * which is how this premise read stopped finding the panel it guards.
 */
const PANEL = readFileSync(
  join(REPO_ROOT, "dialogue-web", "src", "components", "management-surface-panels.tsx"),
  "utf8",
);
const SHELL = readFileSync(
  join(REPO_ROOT, "dialogue-web", "src", "components", "ComposedReferenceGameApp.tsx"),
  "utf8",
);

test("the opening picker publishes the control this kit presses", () => {
  assert.match(
    PANEL,
    /data-testid="opening-option-commit"/u,
    "the picker's commit control is gone; every driver that creates a Chat through the picker presses it by that name",
  );
});

test("the opening card's prose is inert text, not the commit control", () => {
  // Clicking the prose committed the opening until `c55ea777`. The card is a `<div>` now. If it becomes
  // a control again, that is a product decision - and this reading is what says the kit may rely on it.
  assert.match(PANEL, /<div className="opening-option" data-testid="opening-option">/u);
});

test("the shell parks the conversation instead of removing it, so its presence is not a surface", () => {
  // This is the fact that makes a presence probe answer "yes" on every surface. If the conversation ever
  // becomes a peer that unmounts like the others, the parked read below is still correct - and this line
  // fails so the helper's premise is edited rather than left describing a shell that no longer exists.
  assert.match(
    SHELL,
    /shownSurface === CHAT_PANEL \? "surface-slot" : "surface-slot surface-slot-parked"/u,
    "the conversation's slot is no longer parked while another surface is selected",
  );
});

/**
 * A page on which the page functions the helper serializes are actually RUN, against a modelled DOM.
 *
 * The helper's probe is a pure read of two facts - the conversation's element, and the shell's own
 * `panel` word - so a fake that answers `evaluate` from a scripted sequence would decide the answer
 * for the helper instead of reading it, and could not tell "the conversation is on the page" from
 * "the shell is showing it". Both are modelled, and the serialized function is what reads them.
 */
function pageModel({ createControl = true, commitControl = true, panel = "chats", landsOnCommit = true } = {}) {
  const seen = { reads: 0, commits: 0, gestures: 0, selectors: [] };
  let shown = panel;
  const document = {
    querySelector(selector) {
      if (selector === '[data-testid="chat-surface"]') return {};
      if (selector === '[data-testid="new-chat"]')
        return createControl
          ? {
              disabled: false,
              click() {
                seen.gestures += 1;
              },
            }
          : null;
      return null;
    },
  };
  const window = {
    location: {
      get hash() {
        return `#profile=composed-reference-game&panel=${shown}`;
      },
    },
  };
  const commit = {
    async count() {
      return commitControl ? 1 : 0;
    },
    async isVisible() {
      return commitControl;
    },
    async click() {
      seen.commits += 1;
      if (landsOnCommit) shown = "chat";
    },
  };
  return {
    seen,
    async evaluate(fn) {
      seen.reads += 1;
      return new Function("document", "window", `return (${fn})()`)(document, window);
    },
    async waitForTimeout() {},
    locator(selector) {
      seen.selectors.push(selector);
      // Only the commit control is on this page: a locator for anything else finds nothing, which is what
      // makes the answer depend on WHICH control the helper presses and not just that it pressed one.
      return { nth: () => commit };
    },
  };
}

test("a create that lands is answered with the surface the shell landed on", async () => {
  // The conversation is on the page from the start (the shell parks it) and the shell is showing the
  // Chats list. A landing means the commit was pressed and the shell then showed the Chat - never the
  // first of those two on its own.
  const page = pageModel();
  assert.deepEqual(await createChat(page), { started: "clicked", committed: 0, landed: true });
  assert.deepEqual(page.seen.selectors, ['[data-testid="opening-option-commit"]']);
  assert.equal(page.seen.commits, 1, "the picker's commit control was pressed exactly once");
  assert.equal(page.seen.gestures, 1, "the create control was pressed exactly once");
});

test("a create the shell never moves onto is not a landing, and the commit it pressed is named", async () => {
  // The shape a presence probe cannot answer: the conversation is on the page, the commit was pressed,
  // and the shell stayed on the Chats list. Nothing was created here either - and the answer says so,
  // naming the opening that was tried.
  const page = pageModel({ landsOnCommit: false });
  assert.deepEqual(await createChat(page, { rounds: 2 }), { started: "clicked", committed: 0, landed: false });
  assert.equal(page.seen.commits, 2, "the commit is pressed on every round while the shell has not moved");
});

test("a picker with no commit control pressed creates nothing, and the answer says so", async () => {
  // The `shots-final55` shape: the control answers, nothing is created, and only the surface can say it.
  const page = pageModel({ commitControl: false });
  const answer = await createChat(page, { rounds: 3 });
  assert.deepEqual(answer, { started: "clicked", committed: null, landed: false });
  assert.equal(page.seen.reads, 4, "the shell was read on every round, so a slow landing is not a no");
});

test("a mount with no create control names the control rather than the absence of a Chat", async () => {
  const page = pageModel({ createControl: false });
  assert.deepEqual(await createChat(page), { started: "no_create_control", committed: null, landed: false });
});
