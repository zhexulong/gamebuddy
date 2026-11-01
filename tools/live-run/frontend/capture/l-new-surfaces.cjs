// Driver L: the surfaces the night's work added or changed, measured on the running product —
// the companion's picture (real PNG decoded, or the monogram fallback), the read-only inspector
// drawer a roster row opens, and the World Info library's authoring panel (empty state, create,
// read the entry body, edit, and the arm-then-confirm delete whose geometry once blew a row to
// 3148 px in a sibling surface).
//
// It reports computed facts and says `could_not_drive` rather than guessing when a flow cannot be
// reached. The bytes behind an avatar cannot be hashed from inside the page; what the page CAN say
// is whether the image decoded (`naturalWidth > 0`) instead of falling back, which is the fact that
// matters - the byte identity is proven separately by `scratch/probe-avatar-e2e.mjs`.
const path = require("node:path");
const zlib = require("node:zlib");
const { connect, reporter, SHOTS, PAGE_HELPERS, activateSurface, shot } = require("./common.cjs");

/**
 * A real PNG character card: signature + IHDR + tEXt(`chara`) + IEND, CRC32s correct.
 *
 * A run can show only a picture the product was given, and the default companion now carries her
 * own (`assets/tavern/presets/default-companion/avatar.png`, provisioned into her companion root),
 * so her roster row is already a decoded image. Importing a PNG card is what shows a picture a CARD
 * brought with it - the case this item exists to record - while a `.json` card's companion is the
 * monogram fallback in the same element.
 */
/**
 * The same PNG card the HOST's own tests hand to the decoder, so a refusal here cannot be a
 * difference between two hand-rolled PNG writers. The kit's driver falls back to its own
 * builder (and says so) when the compiled fixture is not reachable.
 */
function hostPngCardFile(cardJson) {
  try {
    const fixture = require(path.resolve(__dirname, "../../../host/dist-test/test-support/png-card.test-support.js"));
    return Buffer.from(fixture.pngCardFile(cardJson));
  } catch (error) {
    console.log(`HOST FIXTURE UNAVAILABLE (${String(error).slice(0, 120)}) - using the driver's own PNG builder`);
    return pngCardFile(cardJson);
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}
function pngCardFile(cardJson) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  // One real pixel: a filter byte then RGBA. Without IDAT the file is a container with
  // no picture, and the import refuses it - which is what the first attempt of this
  // driver learned (`surfaceMentionsImportFailure: true` with no review).
  const idat = zlib.deflateSync(Buffer.from([0x00, 0x40, 0x80, 0xc0, 0xff]));
  const payload = Buffer.concat([Buffer.from("chara\0", "latin1"), Buffer.from(cardJson, "latin1")]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("tEXt", payload),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("l-new-surfaces.txt");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(`${PAGE_HELPERS};undefined`);
  await activateSurface(page, "角色");
  await page.waitForTimeout(1500);

  /** Every roster row: her name element, and whether her picture decoded or fell back. */
  const readAvatars = () =>
    [...document.querySelectorAll("[data-companion-entry]")].map((row) => {
      const image = row.querySelector(".avatar img.avatar-image");
      const avatarBox = row.querySelector(".avatar");
      const box = avatarBox === null ? null : avatarBox.getBoundingClientRect();
      return {
        name: (row.querySelector("[data-companion-entry-name]")?.textContent ?? "").trim(),
        hasImage: image !== null,
        src: image === null ? null : image.getAttribute("src"),
        naturalWidth: image === null ? null : image.naturalWidth,
        naturalHeight: image === null ? null : image.naturalHeight,
        srcIsSameOriginAsset: image === null ? null : (image.getAttribute("src") ?? "").startsWith("/assets/companions/"),
        fallbackText: image === null ? (avatarBox?.textContent ?? "").trim() : null,
        avatarBox: box === null ? null : { w: Math.round(box.width), h: Math.round(box.height) },
      };
    });

  say("=== ITEM: roster avatars (real picture decoded, or the monogram) ===");
  const avatars = await page.evaluate(readAvatars);
  say(JSON.stringify(avatars, null, 1));
  say(`rows=${avatars.length} withImage=${avatars.filter((row) => row.hasImage).length} decoded=${avatars.filter((row) => (row.naturalWidth ?? 0) > 0).length}`);
  say(`every picture is a same-origin /assets/companions/ URL: ${avatars.every((row) => row.srcIsSameOriginAsset !== false)}`);
  await shot(page, "70-characters-avatars-1440x900.png");

  // The inspector: the drawer a roster row opens, its four groups, and that it edits nothing.
  say("=== ITEM: the read-only inspector drawer ===");
  const opener = page.locator("[data-companion-entry] [data-companion-inspect]").first();
  const openerName = await opener.locator("[data-companion-entry-name]").textContent().catch(() => null);
  await opener.click();
  await page.waitForTimeout(1200);
  const drawerFacts = await page.evaluate(() => {
    const drawer = document.querySelector('[data-testid="companion-inspector"]');
    if (drawer === null) return { present: false };
    const box = drawer.getBoundingClientRect();
    const group = (name) => {
      const section = drawer.querySelector(`[data-companion-inspector-${name}]`);
      if (section === null) return null;
      return {
        present: section.querySelector("[data-companion-inspector-absent]") === null,
        headings: [...section.querySelectorAll("h3")].map((heading) => (heading.textContent ?? "").trim()),
        absentText: (section.querySelector("[data-companion-inspector-absent]")?.textContent ?? "").trim() || null,
      };
    };
    return {
      present: true,
      heading: (drawer.querySelector("h1,h2,h3")?.textContent ?? "").trim(),
      width: Math.round(box.width),
      height: Math.round(box.height),
      writableControls: drawer.querySelectorAll('input, textarea, select, [contenteditable="true"]').length,
      buttons: [...drawer.querySelectorAll("button")].map((button) => (button.getAttribute("aria-label") ?? button.textContent ?? "").trim()),
      groups: {
        persona: group("persona"),
        scenario: group("scenario"),
        openings: group("openings"),
        worldBook: group("world-book"),
      },
      paintsAPlaceholder: (drawer.textContent ?? "").includes("{{"),
    };
  });
  say(JSON.stringify({ openerName, ...drawerFacts }, null, 1));
  await shot(page, "71-companion-inspector-1440x900.png");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  const focusReturned = await page.evaluate(() => document.activeElement?.hasAttribute("data-companion-inspect") ?? false);
  say(`Escape closed it and focus returned to the row control: ${focusReturned}`);
  say(`drawer closed: ${await page.locator('[data-testid="companion-inspector"]').count() === 0}`);

  // The World Info library's authoring panel.
  say("=== ITEM: the World Info library's authoring panel ===");
  const panelBefore = await page.evaluate(() => {
    const panel = document.querySelector("[data-world-book]");
    if (panel === null) return { present: false };
    return {
      present: true,
      emptyStateText: (panel.querySelector("[data-world-book-empty]")?.textContent ?? "").trim() || null,
      itemCount: panel.querySelectorAll("[data-world-book-item]").length,
      createControl: (panel.querySelector("[data-world-book-create]")?.textContent ?? "").trim() || null,
    };
  });
  say(JSON.stringify(panelBefore, null, 1));

  let created = "could_not_drive";
  // A draft left open by an earlier attempt hides the create control (the panel shows one
  // or the other, never both), so the flow starts from a known state rather than from
  // whatever the previous run left on a page that is still alive.
  const openDraft = await page.locator("[data-world-book-cancel]").count();
  if (openDraft > 0) {
    await page.locator("[data-world-book-cancel]").first().click();
    await page.waitForTimeout(500);
    say("an open draft from an earlier attempt was cancelled first");
  }
  if (panelBefore.present && panelBefore.itemCount === 0) {
    const create = page.locator("[data-world-book-create]").first();
    if ((await create.count()) > 0) {
      await create.click();
      await page.waitForTimeout(400);
      const title = page.locator("[data-world-book-draft] input").first();
      if ((await title.count()) > 0) {
        await title.fill("射击场规则");
        // The draft's own summary is REQUIRED before the submit enables
        // (`worldBookDraftIsComplete`), which is why the first attempt of this driver sat on a
        // disabled button for 30 s: a flow driver has to fill every required field, not the ones
        // whose effect is visible in a screenshot.
        const draftSummary = page.locator("[data-world-book-draft] textarea").first();
        if ((await draftSummary.count()) > 0) await draftSummary.fill("玩家自己写下的世界设定。");
        const entryTitle = page.locator("[data-world-book-entry-draft] input").first();
        if ((await entryTitle.count()) > 0) await entryTitle.fill("盐碱地");
        const entryBody = page.locator("[data-world-book-entry-draft] textarea").first();
        if ((await entryBody.count()) > 0) await entryBody.fill("玩家在盐碱地上种不了防风草。");
        const entryKeys = page.locator("[data-world-book-entry-draft] input").nth(1);
        if ((await entryKeys.count()) > 0) await entryKeys.fill("盐碱地");
        const submit = page.locator("[data-world-book-submit]").first();
        const enabled = await submit.isEnabled().catch(() => false);
        say(`submit enabled after filling every required field: ${enabled}`);
        if (enabled) {
          await submit.click();
          await page.waitForTimeout(1500);
          created = "submitted";
        } else {
          created = "submit_never_enabled";
        }
      }
    }
  }
  const afterCreate = await page.evaluate(() => {
    const panel = document.querySelector("[data-world-book]");
    if (panel === null) return { present: false };
    return {
      present: true,
      itemCount: panel.querySelectorAll("[data-world-book-item]").length,
      titles: [...panel.querySelectorAll("[data-world-book-item]")].map((item) => (item.textContent ?? "").trim().slice(0, 40)),
      emptyStateText: (panel.querySelector("[data-world-book-empty]")?.textContent ?? "").trim() || null,
    };
  });
  say(`create flow: ${created}`);
  say(JSON.stringify(afterCreate, null, 1));
  await shot(page, "72-world-info-authoring-1440x900.png");

  // Reading one item's entries and the body behind the fold, then the arm-then-confirm delete.
  let openedBody = null;
  let armGeometry = null;
  let deleted = "could_not_drive";
  if (afterCreate.present && afterCreate.itemCount > 0) {
    await page.locator("[data-world-book-open]").first().click();
    await page.waitForTimeout(1200);
    const list = await page.locator("[data-world-book-entry-list]").first();
    if ((await list.count()) > 0) {
      const entry = list.locator("[data-world-book-entry]").first();
      // The entry's own words are its title and the paragraph under it; the marked facts line
      // carries the scope and the trigger words. Read both, so "the player can read the entry"
      // is a measured fact rather than an assumption about a marker name.
      const title = await entry.locator("strong").first().textContent().catch(() => null);
      const summary = await entry.locator("p").first().textContent().catch(() => null);
      openedBody = summary;
      const facts = entry.locator("[data-world-book-entry-facts]").first();
      say(`entry title: ${JSON.stringify(title)}`);
      say(`entry text: ${JSON.stringify(summary)}`);
      say(`entry facts: ${JSON.stringify((await facts.textContent().catch(() => null)) ?? null)}`);
    }
    await shot(page, "73-world-info-item-1440x900.png");

    const remove = page.locator("[data-world-book-delete]").first();
    if ((await remove.count()) > 0) {
      await remove.click();
      await page.waitForTimeout(500);
      armGeometry = await page.evaluate(() => {
        const prompt = document.querySelector("[data-world-book-confirm-prompt]");
        if (prompt === null) return null;
        const box = prompt.getBoundingClientRect();
        const row = prompt.closest("[data-world-book-item]") ?? prompt.parentElement;
        const rowBox = row === null ? null : row.getBoundingClientRect();
        return {
          promptText: (prompt.textContent ?? "").trim().slice(0, 60),
          promptBox: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
          rowHeight: rowBox === null ? null : Math.round(rowBox.height),
          rowWidth: rowBox === null ? null : Math.round(rowBox.width),
          yes: (document.querySelector("[data-world-book-confirm-yes]")?.textContent ?? "").trim() || null,
          no: (document.querySelector("[data-world-book-confirm-no]")?.textContent ?? "").trim() || null,
        };
      });
      say(`armed delete: ${JSON.stringify(armGeometry)}`);
      await shot(page, "74-world-info-delete-armed-1440x900.png");
      const yes = page.locator("[data-world-book-confirm-yes]").first();
      if ((await yes.count()) > 0) {
        await yes.click();
        await page.waitForTimeout(1500);
        const remaining = await page.locator("[data-world-book-item]").count();
        deleted = `remaining=${remaining}`;
      }
    }
  }
  say(`delete flow: ${deleted}`);

  // The transcript: the companion's bubble carries the picture, the player's never does.
  say("=== ITEM: the transcript's avatars ===");
  await activateSurface(page, "聊天");
  await page.waitForTimeout(1500);
  const transcript = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".message-list > li")];
    return rows.map((row) => {
      const image = row.querySelector(".avatar img.avatar-image");
      const avatar = row.querySelector(".avatar");
      return {
        role: row.classList.contains("player") ? "player" : "companion",
        hasImage: image !== null,
        naturalWidth: image === null ? null : image.naturalWidth,
        src: image === null ? null : image.getAttribute("src"),
        fallbackText: image === null ? (avatar?.textContent ?? "").trim() : null,
      };
    });
  });
  say(JSON.stringify(transcript, null, 1));
  say(`player rows carry no image: ${transcript.filter((row) => row.role === "player").every((row) => row.hasImage === false)}`);
  await shot(page, "75-chat-avatars-1440x900.png");
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(1200);
  await shot(page, "75-chat-avatars-400x800.png");

  // A PNG card, imported through the surface's own picker: this is what makes a real
  // picture appear, and the only way to measure that the browser decodes it.
  say("=== ITEM: a PNG card's picture, imported and shown ===");
  await activateSurface(page, "角色");
  await page.waitForTimeout(1200);
  // The stage route's own answer, so a refusal is named rather than guessed at from the
  // surface's generic sentence.
  const stageAnswers = [];
  page.on("response", async (response) => {
    if (!response.url().includes("/api/tavern/v1/imports")) return;
    const body = await response.text().catch(() => "");
    const sent = response.request().postData() ?? "";
    // What the client actually sent, so the arm it chose and the payload it encoded are
    // facts rather than inferences: a refusal is only diagnosable with both halves.
    let sentShape = sent.slice(0, 160);
    try {
      const parsed = JSON.parse(sent);
      sentShape = JSON.stringify({
        keys: Object.keys(parsed),
        cardSource: parsed.cardSource,
        cardChars: typeof parsed.card === "string" ? parsed.card.length : undefined,
        base64Chars: typeof parsed.cardFileBase64 === "string" ? parsed.cardFileBase64.length : undefined,
        base64Head: typeof parsed.cardFileBase64 === "string" ? parsed.cardFileBase64.slice(0, 24) : undefined,
      });
    } catch {
      /* not JSON: the raw head is the fact */
    }
    stageAnswers.push({ status: response.status(), url: response.url().split("/api")[1], sent: sentShape, body: body.slice(0, 300) });
  });
  const rosterBefore = await page.evaluate(readAvatars);
  await page.locator("[data-card-import-file]").first().setInputFiles({
    name: "picture-card.png",
    mimeType: "image/png",
    buffer: hostPngCardFile(
      // The payload is base64 of the UTF-8 JSON, which is what a real card carries: `tEXt` is a
      // latin1 chunk, so a raw JSON with non-ASCII text in it comes back mangled (a Chinese
      // glyph's bytes turn into control characters) and the decoder refuses it as invalid JSON.
      // Base64 is the convention for exactly this reason, and it is also the branch of
      // `decodeCharaValue` a real card takes.
      Buffer.from(
        JSON.stringify({ spec: "chara_card_v3", data: { name: "画中人", description: "卡片里自带一张图。" } }),
        "utf8",
      ).toString("base64"),
    ),
  });
  await page.waitForTimeout(1500);
  const staged = await page.evaluate(() => {
    const surface = document.querySelector('[data-testid="characters-surface"]');
    const text = (surface?.innerText ?? "").replace(/\s+/gu, " ");
    const marker = (name) => document.querySelector(`[data-card-import-${name}]`) !== null;
    const review = document.querySelector("[data-card-import-review]");
    return {
      reviewPresent: review !== null,
      reviewText: (review?.textContent ?? "")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 220),
      confirmPresent: marker("review-confirm"),
      resultPresent: marker("result"),
      resultText: (document.querySelector("[data-card-import-result]")?.textContent ?? "")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 240),
      surfaceMentionsImportFailure: /失败|无法|拒绝|错误/.test(text.slice(0, 400)),
    };
  });
  say(`after picking the PNG card: ${JSON.stringify(staged)}`);
  say(`the stage route answered: ${JSON.stringify(stageAnswers)}`);
  const confirm = page.locator("[data-card-import-review-confirm]").first();
  if ((await confirm.count()) > 0) {
    await confirm.click();
    await page.waitForTimeout(2500);
    const confirmed = await page.evaluate(() => {
      const result = document.querySelector("[data-card-import-result]");
      return {
        resultText: (result?.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 200),
        resultState: result === null ? null : result.getAttribute("data-card-import-result"),
      };
    });
    say(`after confirming: ${JSON.stringify(confirmed)}`);
  } else {
    say("no review control appeared, so the confirm step was not taken");
  }
  const rosterAfter = await page.evaluate(readAvatars);
  say(`roster before the import: ${JSON.stringify(rosterBefore.map((row) => ({ name: row.name, hasImage: row.hasImage })))}`);
  say(`roster after the import:  ${JSON.stringify(rosterAfter.map((row) => ({ name: row.name, hasImage: row.hasImage, decoded: (row.naturalWidth ?? 0) > 0, src: row.src })))}`);
  const importedRow = rosterAfter.find((row) => row.name === "画中人") ?? null;
  say(`the imported companion is in the roster: ${importedRow !== null}`);
  say(`her picture decoded in the browser (naturalWidth > 0): ${(importedRow?.naturalWidth ?? 0) > 0}`);
  await shot(page, "76-imported-avatar-1440x900.png");

  flush();
  await browser.close().catch(() => undefined);
  say("DONE-L");
})().catch((error) => {
  console.log("DRIVER L FAILED:", String(error).slice(0, 600));
  process.exit(1);
});
