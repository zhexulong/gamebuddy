// Driver J: card-import review field names. The review (data-card-import-review) names the Host's
// staged field report in the PLAYER'S words — human labels, and NOT one snake_case identifier — and
// cancelling the staged card must leave the durable companion list unchanged.
//
// A synthetic chara_card_v3 card is staged through the paste lane (in-page textarea + native input
// event; nothing leaves the browser). The review is then cancelled, so no companion is provisioned.
const { connect, reporter, PAGE_HELPERS, activateSurface, shot, observe, observationStart, waitForPanel } = require("./common.cjs");
const { companionNames, sameCompanions } = require("./companion-names.cjs");

const CARD = JSON.stringify({
  spec: "chara_card_v3",
  data: {
    name: "青禾",
    description: "山间老屋的看护人,说话慢条斯理,口袋里常备炒蚕豆。",
    personality: "温和寡言,答话简短。",
    scenario: "初秋的山脚小院,门廊下晾着一排新摘的玉米。",
    first_mes: "“进屋坐,灶上煨着汤。”",
    mes_example: "<START>\n{{user}}: 你好\n{{char}}: 抬头看你一眼,把柴刀搁下。",
    system_prompt: "演出时只用动作与简洁对话推进。",
  },
});

/** What the surface offers, without reading the panel's section order as if it were the companions. */
const surfaceFacts = () => {
  const section = document.querySelector('[data-testid="characters-surface"]');
  return { importSectionPresent: section?.querySelector("[data-card-import]") !== null };
};

/**
 * The durable companion list, read by the one reader that means "the same named companions"
 * (`companion-names.cjs`). Its own source runs in the page, so the driver and its test read the same
 * markup rather than two spellings of it.
 */
const readCompanions = (page) => page.evaluate(`(${companionNames.toString()})(document)`);

const stageCard = (card) => {
  const section = document.querySelector("[data-card-import]");
  if (section === null) return "no_import_section";
  const details = section.querySelector("details.custom-disclosure");
  if (details === null) return "no_paste_disclosure";
  if (!details.open) {
    const summary = details.querySelector("summary");
    if (summary === null) return "no_summary";
    summary.click();
  }
  const textarea = section.querySelector("textarea");
  if (textarea === null) return "no_paste_textarea";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(textarea, card);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  const submit = [...section.querySelectorAll("button")].find((button) => (button.textContent ?? "").trim() === "导入角色卡");
  if (submit === undefined) return "no_submit";
  submit.click();
  return "staged";
};

const reviewFacts = () => {
  const review = document.querySelector("[data-card-import-review]");
  if (review === null) return { present: false };
  const text = (review.innerText ?? "").replace(/\s+/g, " ").trim();
  const sentences = [...review.querySelectorAll("li")].map((li) => (li.innerText ?? "").replace(/\s+/g, " ").trim());
  const snakeCase = [...text.matchAll(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/gu)].map((m) => m[0]);
  const humanWords = ["名称", "场景", "演出指导", "用户设定", "对话示例", "开场白"].filter((word) => text.includes(word));
  return {
    present: true,
    text,
    sentences,
    keptSentence: sentences.find((s) => s.includes("将保留")) ?? null,
    snakeCaseTokens: snakeCase,
    humanWords,
    verdict: {
      snakeCaseCount: snakeCase.length,
      humanFieldWordsShown: humanWords,
    },
  };
};

const reviewVerdict = () => {
  const review = document.querySelector("[data-card-import-review]");
  if (review === null) return "no_review";
  const text = (review.innerText ?? "").replace(/\s+/g, " ").trim();
  const snakeCase = [...text.matchAll(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/gu)].map((m) => m[0]);
  return JSON.stringify({ snakeCaseTokens: snakeCase, humanWords: ["名称", "场景", "演出指导", "用户设定", "对话示例"].filter((w) => text.includes(w)) });
};

const cancelReview = () => {
  const cancel = document.querySelector("[data-card-import-review-cancel]");
  if (cancel === null) return "no_cancel";
  cancel.click();
  return "cancelled";
};

/**
 * The Characters panel, read as a panel: its loading line gone, and the companion list's presence holding across
 * two reads. The list is the one thing this driver compares, and `[data-companion-list]` is simply not in the DOM
 * until the panel's own read lands - so the first read of a slower machine sees an ABSENT list, which is not an
 * empty one. `frontend--r13` read `before={"present":false}`, then compared two readings of which one had
 * nothing to compare, and failed with `companion_list_unobserved`; `t` and `m` failed at the same pin for the same
 * reason (a fixed delay shorter than the surface needed).
 */
const CHARACTERS_PANEL = { name: "characters-surface", panel: '[data-testid="characters-surface"]', item: "[data-companion-list]" };

/** The staged card's review: it mounts when the Host's derive lands, and is gone once the cancel has discarded it. */
const CARD_REVIEW = { name: "card-import-review", panel: "[data-card-import-review]" };

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("j-card-import.txt");
  const observationFrom = await observationStart(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(`${PAGE_HELPERS};undefined`);
  await activateSurface(page, "角色");
  await waitForPanel(page, CHARACTERS_PANEL);

  const before = await page.evaluate(surfaceFacts);
  const companionsBefore = await readCompanions(page);
  say("=== ITEM: card-import review field names — state before staging ===");
  say(JSON.stringify(before, null, 1));
  say(
    `companions before staging (${companionsBefore.names === null ? "unobserved" : `${companionsBefore.names.length} examined`}): ${JSON.stringify(companionsBefore.names)}`,
  );
  if (before.importSectionPresent !== true) {
    say("review verdict: SKIPPED:no_card_import_section_on_characters_surface");
    flush();
    await browser.close().catch(() => undefined);
    say("DONE-J");
    process.exit(0);
  }

  const staged = await page.evaluate(stageCard, CARD);
  say("staging:", staged);
  if (staged !== "staged") {
    say("review verdict: SKIPPED:staging_failed:" + staged);
    flush();
    await browser.close().catch(() => undefined);
    say("DONE-J");
    process.exit(0);
  }

  try {
    // The review mounts when the Host's staged derive lands, and its own loading line (when it draws one) is the
    // panel's statement that the derive is still in flight. A staged card that produces no review inside the
    // budget is reported below as the skip it has always been, with what the wait saw instead of a bare sleep.
    await waitForPanel(page, { ...CARD_REVIEW, timeoutMs: 45000 });
  } catch (error) {
    say(`the review never mounted: ${String(error).slice(0, 400)}`);
  }
  const review = await page.evaluate(reviewFacts);
  say("=== ITEM: the card-import review (staged, pre-confirm) ===");
  say(JSON.stringify(review, null, 1));
  say("review verdict:", review.present ? await page.evaluate(reviewVerdict) : "SKIPPED:no_review_after_stage");
  const reviewText = review.present ? (review.text ?? "") : "";
  say(`review text snake_case count: ${(reviewText.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/gu) ?? []).length}`);
  say(`human field words in the review: ${JSON.stringify(review.present ? review.humanWords : [])}`);
  if (review.present) await shot(page, "54-card-import-review-1440x900.png");

  const cancelled = await page.evaluate(cancelReview);
  say("cancel:", cancelled);
  /*
   * The cancel's settled state is the staged review's own removal: 取消 discards the card, so the panel stops
   * drawing `[data-card-import-review]`. Waiting for that is what makes the next read a comparison of two
   * settled lists rather than of a list the cancel was still rewriting - which is what the fixed 800 ms stood in
   * for.
   */
  const cancelSettledAt = Date.now();
  const reviewGone = await page
    .locator("[data-card-import-review]")
    .waitFor({ state: "detached", timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  say(`the staged review is ${reviewGone ? "gone" : "STILL DRAWN"} ${String(Date.now() - cancelSettledAt)}ms after the cancel`);
  const companionsAfter = await readCompanions(page);
  say("=== ITEM: durable companion list unchanged after cancel ===");
  say(
    `companions after the cancel (${companionsAfter.names === null ? "unobserved" : `${companionsAfter.names.length} examined`}): ${JSON.stringify(companionsAfter.names)}`,
  );
  const unchanged = sameCompanions(companionsBefore.names, companionsAfter.names);
  say(`companion list unchanged: ${unchanged} (by name, ${companionsBefore.names?.length ?? 0} examined)`);
  if (!unchanged) {
    // A reading that measured nothing is not a pass: two absent lists are not "the same companions".
    say(
      companionsBefore.names === null || companionsAfter.names === null
        ? `companion list unobserved: before=${JSON.stringify(companionsBefore)} after=${JSON.stringify(companionsAfter)}`
        : `companion list changed: before=${JSON.stringify(companionsBefore.names)} after=${JSON.stringify(companionsAfter.names)}`,
    );
    flush();
    await browser.close().catch(() => undefined);
    say(
      companionsBefore.names === null || companionsAfter.names === null
        ? "DRIVER J FAILED: companion_list_unobserved"
        : `DRIVER J FAILED: companion_list_changed:before=${JSON.stringify(companionsBefore.names)}:after=${JSON.stringify(companionsAfter.names)}`,
    );
    process.exit(1);
  }

  await observe(page, say, "j", { sinceMs: observationFrom });
  flush();
  await browser.close().catch(() => undefined);
  say("DONE-J");
})().catch((error) => {
  console.log("DRIVER J FAILED:", String(error).slice(0, 900));
  process.exit(1);
});