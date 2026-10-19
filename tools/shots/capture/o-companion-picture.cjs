// Driver O: her picture — where it is drawn, and the monogram that stands in for it.
//
// The app bar draws her with the same `CompanionAvatar` the roster row and the message bubble use
// (it used to be a hard-coded monogram), so all three are read the same way and with the same three
// facts: is an `<img>` there at all, did the BROWSER decode it (`naturalWidth > 0`), and what does
// the plate say when there is none. A same-origin `/assets/companions/<handle>/avatar.png` URL is
// the address the Host owns, and the bytes behind it are reported by fetching that exact URL from
// the page, so "her picture" is a served file rather than a `<img>` tag that may be broken.
//
// The monogram is not a missing asset: it is the case of a companion a card brought without a
// picture. A `.json` card carries no image arm at all, so the companion it provisions IS the
// fallback case, and it is driven through the surface's own picker.
const { connect, reporter, PAGE_HELPERS, activateSurface, shot } = require("./common.cjs");

const CARD = JSON.stringify({
  spec: "chara_card_v3",
  data: {
    name: "无相",
    description: "卡片里没有图,只有字。",
    scenario: "一个只有文字的房间。",
    first_mes: "“你看不见我,可我在说话。”",
  },
});

/**
 * The one page-side reader every measurement below shares.
 *
 * `page.evaluate` serializes the single function it is handed, so a helper three closures share has
 * to live in the page (the way `window.__shots` does) instead of in this module: a module-level
 * helper is simply not defined where the body runs.
 */
const PICTURE_HELPER = `
window.__pictureOf = (scope) => {
  const plate = scope.querySelector(".avatar");
  const image = scope.querySelector(".avatar img.avatar-image");
  return {
    hasImage: image !== null,
    src: image === null ? null : image.getAttribute("src"),
    naturalWidth: image === null ? null : image.naturalWidth,
    naturalHeight: image === null ? null : image.naturalHeight,
    srcIsSameOriginCompanionAsset: image === null ? null : (image.getAttribute("src") ?? "").startsWith("/assets/companions/"),
    fallbackText: image === null ? (plate?.textContent ?? "").trim() : null,
    plate: plate === null ? null : window.__shots.rect(plate),
  };
};
`;

const appBarFacts = () => {
  const block = document.querySelector(".app-bar-companion");
  if (block === null) return { present: false };
  return {
    present: true,
    companionName: (block.querySelector(".app-bar-title")?.textContent ?? "").trim(),
    bar: window.__shots.rect(document.querySelector(".app-bar")),
    ...window.__pictureOf(block),
  };
};

const rosterFacts = () =>
  [...document.querySelectorAll("[data-companion-entry]")].map((row) => ({
    name: (row.querySelector("[data-companion-entry-name]")?.textContent ?? "").trim(),
    current: row.querySelector(".companion-current-badge") !== null,
    ...window.__pictureOf(row),
  }));

const transcriptFacts = () => [...document.querySelectorAll(".message-list > li.message")].map((row) => ({
  role: row.className.includes("player") ? "player" : "companion",
  text: (row.querySelector(".message-bubble")?.innerText ?? "").trim().slice(0, 24),
  ...window.__pictureOf(row),
}));

/** The served bytes of the address the page itself asked for (status, type, length, PNG signature). */
const servedBytes = async (url) => {
  try {
    const response = await fetch(url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      url,
      status: response.status,
      contentType: response.headers.get("content-type"),
      byteLength: bytes.length,
      headHex: [...bytes.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join(" "),
    };
  } catch (error) {
    return { url, failed: String(error).slice(0, 120) };
  }
};

const stageJsonCard = (card) => {
  const section = document.querySelector("[data-card-import]");
  if (section === null) return "no_import_section";
  const details = section.querySelector("details.custom-disclosure");
  if (details === null) return "no_paste_disclosure";
  if (!details.open) details.querySelector("summary")?.click();
  const textarea = section.querySelector("textarea");
  if (textarea === null) return "no_paste_textarea";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(textarea, card);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  const submit = [...section.querySelectorAll("button")].find(
    (button) => (button.textContent ?? "").trim() === "导入角色卡",
  );
  if (submit === undefined) return "no_submit";
  submit.click();
  return "staged";
};

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("o-companion-picture.txt");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(`${PAGE_HELPERS};${PICTURE_HELPER};undefined`);
  await activateSurface(page, "聊天");
  await page.waitForTimeout(1500);

  say("=== ITEM: her picture in the app bar ===");
  const appBar1440 = await page.evaluate(appBarFacts);
  say(JSON.stringify(appBar1440, null, 1));
  say(`app bar @1440x900: hasImage=${appBar1440.hasImage} decoded=${(appBar1440.naturalWidth ?? 0) > 0} monogram=${JSON.stringify(appBar1440.fallbackText)}`);
  await shot(page, "84-appbar-avatar-1440x900.png");
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(1200);
  const appBar400 = await page.evaluate(appBarFacts);
  say(`app bar @400x800: hasImage=${appBar400.hasImage} decoded=${(appBar400.naturalWidth ?? 0) > 0} plate=${JSON.stringify(appBar400.plate)} monogram=${JSON.stringify(appBar400.fallbackText)}`);
  await shot(page, "84-appbar-avatar-400x800.png");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(900);

  say("=== ITEM: her picture in the transcript ===");
  const transcript = await page.evaluate(transcriptFacts);
  say(JSON.stringify(transcript, null, 1));
  say(`transcript rows=${transcript.length} companionWithPicture=${transcript.filter((row) => row.role === "companion" && (row.naturalWidth ?? 0) > 0).length} playerRowsWithPicture=${transcript.filter((row) => row.role === "player" && row.hasImage).length}`);
  say(`every companion row addresses the Host's own picture URL: ${transcript.filter((row) => row.role === "companion").every((row) => row.srcIsSameOriginCompanionAsset !== false)}`);
  await shot(page, "84-transcript-avatars-1440x900.png");

  say("=== ITEM: her picture in the roster ===");
  await activateSurface(page, "角色");
  await page.waitForTimeout(1500);
  const rosterBefore = await page.evaluate(rosterFacts);
  say(JSON.stringify(rosterBefore, null, 1));
  say(`roster rows=${rosterBefore.length} withPicture=${rosterBefore.filter((row) => row.hasImage).length} decoded=${rosterBefore.filter((row) => (row.naturalWidth ?? 0) > 0).length} monograms=${JSON.stringify(rosterBefore.filter((row) => !row.hasImage).map((row) => `${row.name}->${row.fallbackText}`))}`);
  for (const row of rosterBefore.filter((entry) => entry.hasImage)) {
    say(`served bytes ${row.name}: ${JSON.stringify(await page.evaluate(servedBytes, row.src))}`);
  }
  await shot(page, "84-roster-avatars-1440x900.png");

  say("=== ITEM: the monogram fallback — a card that carries no picture ===");
  let importOutcome = "could_not_drive";
  const reviewBefore = await page.locator("[data-card-import-cancel], [data-card-import-review-cancel]").count();
  if (reviewBefore > 0) {
    await page.locator("[data-card-import-review-cancel]").first().click().catch(() => undefined);
    await page.waitForTimeout(500);
  }
  const picker = page.locator("[data-card-import-file]").first();
  if ((await picker.count()) === 0) {
    importOutcome = "no_file_picker_on_the_characters_surface";
  } else {
    await picker.setInputFiles({
      name: "no-picture-card.json",
      mimeType: "application/json",
      buffer: Buffer.from(CARD, "utf8"),
    });
    await page.waitForTimeout(1800);
    const review = await page.evaluate(() => {
      const node = document.querySelector("[data-card-import-review]");
      return node === null
        ? { present: false }
        : { present: true, text: (node.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 220) };
    });
    say(`review for a .json card: ${JSON.stringify(review)}`);
    const confirm = page.locator("[data-card-import-review-confirm]").first();
    if ((await confirm.count()) > 0) {
      await confirm.click();
      await page.waitForTimeout(2600);
      importOutcome = await page.evaluate(() => {
        const result = document.querySelector("[data-card-import-result]");
        return result === null ? "no_result_marker" : (result.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 160);
      });
    } else {
      importOutcome = "no_review_after_staging_the_json_card";
    }
  }
  say(`json-card import: ${JSON.stringify(importOutcome)}`);
  await page.waitForTimeout(1200);
  const rosterAfter = await page.evaluate(rosterFacts);
  say("=== ITEM: the roster after the JSON card ===");
  say(JSON.stringify(rosterAfter, null, 1));
  const monogramRows = rosterAfter.filter((row) => !row.hasImage);
  say(`roster rows=${rosterAfter.length}; rows drawn as a monogram=${JSON.stringify(monogramRows.map((row) => ({ name: row.name, monogram: row.fallbackText })))}`);
  await shot(page, "84-monogram-fallback-1440x900.png");
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(1200);
  const rosterNarrow = await page.evaluate(rosterFacts);
  say(`roster @400x800: rows=${rosterNarrow.length} withPicture=${rosterNarrow.filter((row) => row.hasImage).length} monograms=${JSON.stringify(rosterNarrow.filter((row) => !row.hasImage).map((row) => row.fallbackText))}`);
  await shot(page, "84-monogram-fallback-400x800.png");

  flush();
  await browser.close().catch(() => undefined);
  say("DONE-O");
})().catch((error) => {
  console.log("DRIVER O FAILED:", String(error).slice(0, 900));
  process.exit(1);
});
