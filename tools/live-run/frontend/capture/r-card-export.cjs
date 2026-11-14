// Driver R: the character card in both forms, and the PNG form read back in (brief item 6).
//
// The section exports the companion IN PLAY (`data-companion-card-export-json` /
// `-png`), each control named for the form it saves. The card is the Host's own bytes handed to the
// browser's download surface, so the driver measures the Host's answer (`GET
// /api/tavern/v1/companions/<handle>/card?format=...`, read through the page's own session) AND what
// the browser was handed (the download event, when one arrives), and it decodes the PNG arm here in
// Node: signature, IHDR dimensions, and the `chara` chunk's own card - which is the round trip the
// work claims, because that is the file the surface's own picker is then given back.
const { readFileSync } = require("node:fs");
const { connect, reporter, PAGE_HELPERS, activateSurface, shot, observe, observationStart } = require("./common.cjs");

const sectionFacts = () => {
  const section = document.querySelector("[data-companion-card-export-section]");
  if (section === null) return { present: false };
  const rect = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const control = (selector) => {
    const node = section.querySelector(selector);
    return node === null
      ? null
      : { text: (node.textContent ?? "").trim(), ariaLabel: node.getAttribute("aria-label"), disabled: node.disabled, box: rect(node) };
  };
  return {
    present: true,
    heading: (section.querySelector("h3")?.textContent ?? "").trim(),
    hint: (section.querySelector("p")?.textContent ?? "").trim().slice(0, 200),
    nothingToExport: section.querySelector("[data-companion-card-export-nothing]") !== null,
    jsonControl: control("[data-companion-card-export-json]"),
    pngControl: control("[data-companion-card-export-png]"),
    notice: (section.querySelector("[data-companion-card-export-notice]")?.textContent ?? "").trim() || null,
    section: rect(section),
  };
};

const rosterFacts = () =>
  [...document.querySelectorAll("[data-companion-entry]")].map((row) => {
    const image = row.querySelector(".avatar img.avatar-image");
    return {
      name: (row.querySelector("[data-companion-entry-name]")?.textContent ?? "").trim(),
      hasImage: image !== null,
      naturalWidth: image === null ? null : image.naturalWidth,
      src: image === null ? null : image.getAttribute("src"),
      monogram: image === null ? (row.querySelector(".avatar")?.textContent ?? "").trim() : null,
    };
  });

const servedAvatar = async (handle) => {
  const response = await fetch(`/assets/companions/${handle}/avatar.png`);
  if (!response.ok) return { status: response.status };
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, byteLength: bytes.length };
};

/** PNG structure, read here rather than in the page: the file is the fact. */
function pngFacts(bytes) {
  const signature = bytes.subarray(0, 8);
  const isPng = signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const chunkTypes = [];
  let width = null;
  let height = null;
  let chara = null;
  if (isPng && bytes.length > 33) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
    const prefix = Buffer.from("chara\0", "latin1");
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
      chunkTypes.push(`${type}:${length}`);
      if (type === "tEXt") {
        const payload = bytes.subarray(offset + 8, offset + 8 + length);
        if (payload.subarray(0, prefix.length).equals(prefix)) chara = payload.subarray(prefix.length).toString("latin1");
      }
      offset += 12 + length;
      if (type === "IEND") break;
    }
  }
  return {
    isPng,
    byteLength: bytes.length,
    ihdr: { width, height },
    chunks: chunkTypes,
    charaBase64Chars: chara === null ? null : chara.length,
    chara,
  };
}

// One pick of a file, and what the SURFACE did with it.
//
// `setInputFiles` resolves when the browser has taken the file, which says nothing about the
// card: whether it staged is a fact of the product and is read as one. The `waitForTimeout(2000)`
// this replaced returned "staged" whatever happened, so a pick that was refused, still in flight
// or dropped printed as success - and the empty lists that followed were then read as "the
// exported card cannot be re-imported". It settles on one of the surface's own two answers: the
// staged review, or its own failure sentence.
const stagePicker = async (page, name, bytes, timeoutMs = 30000) => {
  const picker = page.locator("[data-card-import-file]").first();
  if ((await picker.count()) === 0) return { outcome: "no_file_picker" };
  await picker.setInputFiles({ name, mimeType: "image/png", buffer: bytes });
  try {
    await page
      .locator("[data-card-import-review], [data-card-import-result=error]")
      .first()
      .waitFor({ state: "attached", timeout: timeoutMs });
  } catch {
    return { outcome: `no_stage_settled_within_${timeoutMs}ms` };
  }
  if ((await page.locator("[data-card-import-review]").count()) > 0) return { outcome: "staged" };
  const refused = await page.evaluate(
    () => (document.querySelector("[data-card-import-result=error]")?.textContent ?? "").replace(/\s+/gu, " ").trim(),
  );
  return { outcome: "staging_failed", sentence: refused };
};

// The durable roster, read through the page's own session: the authority on WHO is in it.
//
// The rows name a companion for the player to read; they publish no identity, and the only
// handle in the markup is the avatar's `src` - absent for a companion without a picture. A
// re-import of the player's own card produces a second companion with the SAME NAME, so
// attributing the import by name subtracted her predecessor and reported "rows added: []" for a
// successful import. Identity is the handle, and the list that owns it is this route.
const rosterIdentities = async (page) => {
  const answer = await page.evaluate(async () => {
    const response = await fetch("/api/tavern/v1/companions");
    if (!response.ok) return { status: response.status, companions: null };
    const body = await response.json();
    return { status: response.status, companions: Array.isArray(body.companions) ? body.companions : null };
  });
  return answer;
};

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("r-card-export.txt");
  const observationFrom = await observationStart(page);

  const observed = { lastExport: null, downloads: [] };
  page.on("response", async (response) => {
    if (!response.url().includes("/card?format=")) return;
    try {
      observed.lastExport = { url: response.url(), status: response.status(), body: await response.json() };
    } catch {
      observed.lastExport = { url: response.url(), status: response.status(), body: null };
    }
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(`${PAGE_HELPERS};undefined`);
  await activateSurface(page, "角色");
  await page.waitForTimeout(2200);

  say("=== ITEM: the export section and its two named controls ===");
  const section = await page.evaluate(sectionFacts);
  say(JSON.stringify(section, null, 1));
  say(`json control: ${JSON.stringify(section.jsonControl?.text)} ${section.jsonControl?.box.w}x${section.jsonControl?.box.h}; png control: ${JSON.stringify(section.pngControl?.text)} ${section.pngControl?.box.w}x${section.pngControl?.box.h}`);
  await shot(page, "89-card-export-controls-1440x900.png");

  const rosterBefore = await page.evaluate(rosterFacts);
  say(`companions before the exports: ${JSON.stringify(rosterBefore.map((row) => row.name))}`);

  /** One export: the click, the Host's answer, and whatever the browser was handed to save. */
  const runExport = async (format) => {
    const control = format === "json" ? "[data-companion-card-export-json]" : "[data-companion-card-export-png]";
    observed.lastExport = null;
    const download = page.waitForEvent("download", { timeout: 15000 }).catch(() => null);
    await page.locator(control).first().click();
    const saved = await download;
    let savedFile = null;
    if (saved !== null) {
      const filePath = await saved.path().catch(() => null);
      savedFile = {
        suggestedFilename: saved.suggestedFilename(),
        failure: saved.failure() ?? null,
        byteLength: filePath === null ? null : readFileSync(filePath).length,
        pathTaken: filePath !== null,
      };
    }
    for (let attempt = 0; attempt < 20 && observed.lastExport === null; attempt += 1) await page.waitForTimeout(500);
    const notice = await page.evaluate(() => (document.querySelector("[data-companion-card-export-notice]")?.textContent ?? "").trim() || null);
    return { format, download: savedFile, response: observed.lastExport, notice };
  };

  say("=== ITEM: the JSON export ===");
  const jsonExport = await runExport("json");
  const jsonBody = jsonExport.response?.body ?? null;
  say(`download the browser was handed: ${JSON.stringify(jsonExport.download)}`);
  say(`the Host's answer: status=${jsonExport.response?.status} format=${JSON.stringify(jsonBody?.format)} spec=${JSON.stringify(jsonBody?.spec)} fileName=${JSON.stringify(jsonBody?.fileName)} cardChars=${typeof jsonBody?.card === "string" ? jsonBody.card.length : null}`);
  const jsonNotice = jsonExport.notice;
  say(`the surface's own notice: ${JSON.stringify(jsonNotice)}`);
  if (typeof jsonBody?.card === "string") {
    try {
      const card = JSON.parse(jsonBody.card);
      const data = card.data ?? {};
      say(`the exported JSON card parses: spec=${JSON.stringify(card.spec)} name=${JSON.stringify(data.name)} alternateGreetings=${(data.alternate_greetings ?? []).length} firstMesChars=${(data.first_mes ?? "").length} hasWorldBook=${(data.character_book ?? null) !== null} systemPromptChars=${(data.system_prompt ?? "").length}`);
    } catch (error) {
      say(`the exported JSON card does NOT parse: ${String(error).slice(0, 120)}`);
    }
  }
  await shot(page, "89-card-export-json-1440x900.png");

  say("=== ITEM: the PNG export ===");
  const pngExport = await runExport("png");
  const pngBody = pngExport.response?.body ?? null;
  say(`download the browser was handed: ${JSON.stringify(pngExport.download)}`);
  say(`the Host's answer: status=${pngExport.response?.status} format=${JSON.stringify(pngBody?.format)} fileName=${JSON.stringify(pngBody?.fileName)} base64Chars=${typeof pngBody?.cardFileBase64 === "string" ? pngBody.cardFileBase64.length : null}`);
  say(`the surface's own notice: ${JSON.stringify(pngExport.notice)}`);
  const pngBytes = typeof pngBody?.cardFileBase64 === "string" ? Buffer.from(pngBody.cardFileBase64, "base64") : null;
  const exportedPng = pngBytes === null ? null : pngFacts(pngBytes);
  let exportedCard = null;
  if (exportedPng !== null && pngBytes !== null) {
    say(`the exported PNG: ${JSON.stringify({ isPng: exportedPng.isPng, byteLength: exportedPng.byteLength, ihdr: exportedPng.ihdr, chunks: exportedPng.chunks, charaBase64Chars: exportedPng.charaBase64Chars })}`);
    if (exportedPng.chara !== null) {
      try {
        // The parsed chunk object is `exportedPng` — reading a bare `png` here is what made this driver
        // report `ReferenceError: png is not defined` as if the PRODUCT's export were broken, and a
        // four-reviewer pass read it that way. A driver that misreports costs more than one that fails
        // loudly: it sends people to fix code that is already correct.
        exportedCard = JSON.parse(Buffer.from(exportedPng.chara, "base64").toString("utf8"));
        say(`the card inside the PNG parses: spec=${JSON.stringify(exportedCard.spec)} name=${JSON.stringify(exportedCard.data?.name)} firstMesChars=${(exportedCard.data?.first_mes ?? "").length}`);
      } catch (error) {
        say(`the card inside the PNG does NOT parse: ${String(error).slice(0, 120)}`);
      }
    }
    if (jsonBody !== null && typeof jsonBody.card === "string" && exportedCard !== null) {
      const jsonCard = JSON.parse(jsonBody.card);
      say(`the PNG's card and the JSON card describe the same companion: ${jsonCard.data?.name === exportedCard.data?.name}`);
    }
  } else {
    say("no PNG arm came back (the Host refused the PNG form; its own sentence is above)");
  }
  await shot(page, "89-card-export-png-1440x900.png");

  say("=== ITEM: the exported PNG, given back to the surface's own picker ===");
  if (pngBytes === null) {
    say(`SKIPPED:no_png_card_to_re_import (the refusal above is the named outcome; the JSON control stays offered: ${JSON.stringify(section.jsonControl?.text)})`);
  } else {
    const rosterBeforeIdentities = await rosterIdentities(page);
    const staged = await stagePicker(page, pngBody?.fileName ?? "card.png", pngBytes);
    say(`staging the exported file: ${JSON.stringify(staged)}`);
    const review = await page.evaluate(() => {
      const node = document.querySelector("[data-card-import-review]");
      return node === null
        ? { present: false }
        : { present: true, text: (node.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 240) };
    });
    say(`the review of the exported card: ${JSON.stringify(review)}`);
    await shot(page, "89-card-reimport-review-1440x900.png");
    if (staged.outcome !== "staged") {
      say(`the exported card could not be re-imported at the surface's own picker: ${staged.outcome}${staged.sentence === undefined ? "" : ` (${JSON.stringify(staged.sentence)})`}`);
      say(`the roster the picker left behind: ${JSON.stringify((rosterBeforeIdentities.companions ?? []).map((companion) => companion.name))}`);
    } else {
      const confirm = page.locator("[data-card-import-review-confirm]").first();
      await confirm.click();
      await page.waitForTimeout(3000);
      const result = await page.evaluate(() => {
        const node = document.querySelector("[data-card-import-result]");
        return node === null ? null : { state: node.getAttribute("data-card-import-result"), text: (node.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 200) };
      });
      say(`the import's own answer: ${JSON.stringify(result)}`);
      const rosterAfterIdentities = await rosterIdentities(page);
      const added = (rosterAfterIdentities.companions ?? []).filter(
        (companion) => !(rosterBeforeIdentities.companions ?? []).some((before) => before.handle === companion.handle),
      );
      say(`companions the re-import added, by handle: ${JSON.stringify(added.map((companion) => `${companion.name}:${companion.handle}`))}`);
      say(`the re-import created a companion: ${added.length === 1} (the roster went ${(rosterBeforeIdentities.companions ?? []).length} -> ${(rosterAfterIdentities.companions ?? []).length})`);
      await page.waitForTimeout(1500);
      const rosterAfter = await page.evaluate(rosterFacts);
      say(`companions after the re-import: ${JSON.stringify(rosterAfter.map((row) => ({ name: row.name, hasImage: row.hasImage, decoded: (row.naturalWidth ?? 0) > 0 })))}`);
      for (const companion of added) {
        const row = rosterAfter.find((candidate) => (candidate.src ?? "").split("/")[3] === companion.handle) ?? null;
        if (row === null) {
          say(`${companion.name}: the roster renders no row whose picture names ${companion.handle}`);
          continue;
        }
        say(`${companion.name}: her picture ${row.hasImage ? "is drawn" : "is a monogram"} (decoded=${(row.naturalWidth ?? 0) > 0}), src=${JSON.stringify(row.src)}`);
        say(`the picture the imported companion serves: ${JSON.stringify(await page.evaluate(servedAvatar, companion.handle))}`);
        say(`her picture survived the round trip: ${row.hasImage && (row.naturalWidth ?? 0) > 0}; the exported PNG carries a ${exportedPng?.ihdr.width}x${exportedPng?.ihdr.height} picture`);
      }
      await shot(page, "89-card-reimported-1440x900.png");

      // The picker's own reset: `CharacterCardImport.tsx` clears `input.value` inside `onChange`
      // so that choosing the SAME file again still fires `change`, and this is the only place a
      // live run can watch that happen to the real Host. The second pick is cancelled instead of
      // imported - one new companion per run is enough to prove the first import.
      say("=== ITEM: the same file, picked a second time ===");
      const again = await stagePicker(page, pngBody?.fileName ?? "card.png", pngBytes);
      say(`picking the same file again: ${JSON.stringify(again)}`);
      say(`the picker takes the same file twice: ${again.outcome === "staged"}`);
      if (again.outcome === "staged") await page.locator("[data-card-import-review-cancel]").first().click();
      const dropped = await page.evaluate(() => document.querySelector("[data-card-import-review]") === null && document.querySelector("[data-card-import-result]") === null);
      say(`the second pick was cancelled and staged nothing: ${dropped}`);
      const rosterFinal = await rosterIdentities(page);
      say(`companions after the cancelled second pick: ${(rosterFinal.companions ?? []).length}`);

      await page.setViewportSize({ width: 400, height: 800 });
      await page.waitForTimeout(1200);
      await shot(page, "89-card-reimported-400x800.png");
    }
  }

  await observe(page, say, "r", { sinceMs: observationFrom });
  flush();
  await browser.close().catch(() => undefined);
  say("DONE-R");
})().catch((error) => {
  console.log("DRIVER R FAILED:", String(error).slice(0, 900));
  process.exit(1);
});
