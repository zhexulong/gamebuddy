// The create gesture the drivers share, and the premise it stands on.
//
// The failure this exists for, measured on `shots-final55`: driver E pressed the opening card's prose
// five times, got five `clicked` answers, made no Chat, and the run reported a green `DONE-CAPTURE`
// with a one-row list - so E's second-row claims, its 41b/41c screenshots and driver K's whole switch
// were gone. The cause was `c55ea777`: the card became a container a player reads, selects and copies,
// and the commit moved onto `[data-testid="opening-option-commit"]`. Both drivers still clicked the
// prose, which commits nothing but still answers a click.
//
// So two things are held here. The premise: the panel still publishes the control the kit presses, and
// the card's prose is still not a control. And the answer: `createChat` reports whether a Chat really
// was created - read from the surface the shell lands on, never from a click that returned.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createChat } from "./common.cjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PANEL = readFileSync(join(REPO, "dialogue-web", "src", "components", "management-surface-panels.tsx"), "utf8");

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

const held = (button, present) => ({
  async count() {
    return present ? 1 : 0;
  },
  isVisible: button.isVisible,
  click: button.click,
});

/**
 * A page on which the create control is pressed once and the picker's commit, when published, is
 * pressed; `lands` says whether the shell then shows the chat surface. Everything `createChat` reads
 * is here, so the answer it returns is a fact about the answer and not about a browser.
 */
function pageAfterCreate({ commitPublished, lands }) {
  const seen = { reads: 0, commits: 0, selectors: [] };
  const button = {
    async isVisible() {
      return commitPublished;
    },
    async click() {
      seen.commits += 1;
    },
  };
  return {
    seen,
    async evaluate() {
      seen.reads += 1;
      return seen.reads === 1 ? "clicked" : lands && seen.commits > 0;
    },
    async waitForTimeout() {},
    locator(selector) {
      seen.selectors.push(selector);
      // Only the commit control is on this page: a locator for anything else finds nothing, which is what
      // makes the answer depend on WHICH control the helper presses and not just that it pressed one.
      return {
        nth: () => held(button, selector === '[data-testid="opening-option-commit"]' && commitPublished),
      };
    },
  };
}

test("a create that lands is answered with the surface the shell landed on", async () => {
  const page = pageAfterCreate({ commitPublished: true, lands: true });
  assert.deepEqual(await createChat(page), { started: "clicked", committed: 0, landed: true });
  assert.deepEqual(page.seen.selectors, ['[data-testid="opening-option-commit"]']);
  assert.equal(page.seen.commits, 1, "the picker's commit control was pressed exactly once");
});

test("a picker with no commit control pressed creates nothing, and the answer says so", async () => {
  // The `shots-final55` shape: the control answers, nothing is created, and only the surface can say it.
  const page = pageAfterCreate({ commitPublished: false, lands: false });
  const answer = await createChat(page, { rounds: 3 });
  assert.deepEqual(answer, { started: "clicked", committed: null, landed: false });
  assert.equal(page.seen.reads, 4, "the shell was read on every round, so a slow landing is not a no");
});

test("a mount with no create control names the control rather than the absence of a Chat", async () => {
  const page = {
    ...pageAfterCreate({ commitPublished: false, lands: false }),
    evaluate: async () => "no_create_control",
  };
  assert.deepEqual(await createChat(page), { started: "no_create_control", committed: null, landed: false });
});
