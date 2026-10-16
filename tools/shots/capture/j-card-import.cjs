// Driver J: card-import review field names. The review (data-card-import-review) names the Host's
// staged field report in the PLAYER'S words — human labels, and NOT one snake_case identifier — and
// cancelling the staged card must leave the durable companion list unchanged.
//
// A synthetic chara_card_v3 card is staged through the paste lane (in-page textarea + native input
// event; nothing leaves the browser). The review is then cancelled, so no companion is provisioned.
const { connect, reporter, PAGE_HELPERS, activateSurface, shot } = require("./common.cjs");

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

const beforeFacts = () => {
  const panel = document.querySelector("[data-characters-panel]");
  const cards = [...panel.children].map((card) => String((card.innerText || "").split("\n")[0] || "").trim());
  const section = document.querySelector('[data-testid="characters-surface"]');
  return {
    companionCards: cards,
    importSectionPresent: section?.querySelector("[data-card-import]") !== null,
  };
};

const stageCard = () => {
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
  setter.call(textarea, CARD);
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

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("j-card-import.txt");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(`${PAGE_HELPERS};undefined`);
  await activateSurface(page, "角色");
  await page.waitForTimeout(1500);

  const before = await page.evaluate(beforeFacts);
  say("=== ITEM: card-import review field names — state before staging ===");
  say(JSON.stringify(before, null, 1));
  if (before.importSectionPresent !== true) {
    say("review verdict: SKIPPED:no_card_import_section_on_characters_surface");
    flush();
    await browser.close().catch(() => undefined);
    say("DONE-J");
    process.exit(0);
  }

  const staged = await page.evaluate(stageCard);
  say("staging:", staged);
  if (staged !== "staged") {
    say("review verdict: SKIPPED:staging_failed:" + staged);
    flush();
    await browser.close().catch(() => undefined);
    say("DONE-J");
    process.exit(0);
  }

  let review = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.waitForTimeout(1500);
    review = await page.evaluate(reviewFacts);
    if (review.present) break;
  }
  say("=== ITEM: the card-import review (staged, pre-confirm) ===");
  say(JSON.stringify(review, null, 1));
  say("review verdict:", review.present ? await page.evaluate(reviewVerdict) : "SKIPPED:no_review_after_stage");
  const reviewText = review.present ? (review.text ?? "") : "";
  say(`review text snake_case count: ${(reviewText.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/gu) ?? []).length}`);
  say(`human field words in the review: ${JSON.stringify(review.present ? review.humanWords : [])}`);
  if (review.present) await shot(page, "54-card-import-review-1440x900.png");

  const cancelled = await page.evaluate(cancelReview);
  say("cancel:", cancelled);
  await page.waitForTimeout(800);
  const after = await page.evaluate(beforeFacts);
  say("=== ITEM: durable companion list unchanged after cancel ===");
  say(JSON.stringify(after, null, 1));
  say(`companion list unchanged: ${JSON.stringify(before.companionCards) === JSON.stringify(after.companionCards)}`);

  flush();
  await browser.close().catch(() => undefined);
  say("DONE-J");
})().catch((error) => {
  console.log("DRIVER J FAILED:", String(error).slice(0, 900));
  process.exit(1);
});