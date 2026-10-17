// Driver E: the Chats rows. A row carries an identity: two unnamed Chats read 新对话 1 / 新对话 2
// (1-based, in displayed list order), a renamed row shows its own title with NO number, and no row
// shows a raw `*` or `{{`. The row meta line is clamped to two lines (height, line clamp, chars
// inside the box, plus a forced 160-char preview probe — the wire's own maximum), and the meta
// colour's contrast against its card is measured at both widths.
const { connect, reporter, PAGE_HELPERS, activateSurface, shot } = require("./common.cjs");

const RENAME = "重命名契约行";

const readRows = () => {
  const surface = document.querySelector('[data-testid="chats-surface"]');
  const rows = [...surface.querySelectorAll('[data-testid="chat-item"]')];
  const metaFacts = (row) => {
    const meta = row.querySelector('[data-testid="chat-item-meta"]');
    const when = row.querySelector('[data-testid="chat-item-when"]');
    const preview = row.querySelector('[data-testid="chat-item-preview"]');
    if (meta === null) return { meta: null };
    const style = getComputedStyle(meta);
    const lineHeight = parseFloat(style.lineHeight);
    const height = Math.round(meta.getBoundingClientRect().height * 100) / 100;
    const foreground = window.__shots.parseColor(style.color);
    const background = window.__shots.parseColor(window.__shots.effectiveBackground(meta));
    const previewStyle = preview === null ? null : getComputedStyle(preview);
    const previewHeight = preview === null ? null : Math.round(preview.getBoundingClientRect().height * 100) / 100;
    return {
      meta: {
        height,
        lineHeight: Number.isFinite(lineHeight) ? lineHeight : null,
        lines: Number.isFinite(lineHeight) && lineHeight > 0 ? Math.round((height / lineHeight) * 100) / 100 : null,
        lineClamp: style.webkitLineClamp,
        display: style.display,
        overflowY: style.overflowY,
        scrollHeight: meta.scrollHeight,
        clientHeight: meta.clientHeight,
        clippedVertically: meta.scrollHeight > meta.clientHeight + 1,
        color: style.color,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        background: window.__shots.effectiveBackground(meta),
        contrast: foreground === null || background === null ? null : window.__shots.contrast(foreground, background),
      },
      when: when === null ? null : (when.textContent ?? "").trim(),
      previewChars: preview === null ? null : (preview.textContent ?? "").length,
      previewHeight,
      previewLines: previewStyle === null ? null : Math.round((preview.getBoundingClientRect().height / parseFloat(previewStyle.lineHeight)) * 100) / 100,
      previewLineClamp: previewStyle === null ? null : previewStyle.webkitLineClamp,
    };
  };
  return {
    rowCount: rows.length,
    rows: rows.map((row) => {
      const title = row.querySelector(".chat-item-title");
      const selected = (row.getAttribute("data-selected") ?? "") === "true";
      return {
        titleText: (title?.textContent ?? "").trim(),
        rowText: (row.innerText ?? "").replace(/\s+/g, " ").trim(),
        rowRect: window.__shots.rect(row),
        selected,
        ...metaFacts(row),
      };
    }),
  };
};

const renameRow = ({ index }) => {
  const surface = document.querySelector('[data-testid="chats-surface"]');
  const rows = [...surface.querySelectorAll('[data-testid="chat-item"]')];
  const row = rows[index];
  if (row === undefined) return "no_such_row";
  const pencil = [...row.querySelectorAll("button")].find((button) => (button.getAttribute("aria-label") ?? "").includes("重命名"));
  if (pencil === undefined) return "no_rename_button";
  pencil.click();
  return "armed";
};

const commitRename = ({ title }) => {
  const input = document.querySelector('[data-testid="chats-surface"] input[type="text"]');
  if (input === null) return "no_input";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, title);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const surface = document.querySelector('[data-testid="chats-surface"]');
  const save = [...surface.querySelectorAll("button")].find((button) => (button.textContent ?? "").trim() === "保存");
  if (save === undefined) return "no_save";
  save.click();
  return "saved";
};

const forceLongPreview = () => {
  // In-page measurement only: the wire admits at most 160 characters of preview
  // (isLengthBoundedString(preview, 0, 160)), so the clamp is measured against the longest preview
  // the product can actually receive.
  const sample = "晨风卷着松林和湿泥的草腥气拂过门廊,石阶背风处温着一壶粗茶。听见推门声,顺手拍了拍身旁的木台阶,把捂热的粗瓷茶杯递过去,说快过来坐这儿背风。";
  const text = sample.repeat(3).slice(0, 160);
  const preview = document.querySelector('[data-testid="chat-item-preview"]');
  const meta = document.querySelector('[data-testid="chat-item-meta"]');
  const row = document.querySelector('[data-testid="chat-item"]');
  if (preview === null || meta === null) return { present: false };
  const original = preview.textContent;
  preview.textContent = text;
  const metaStyle = getComputedStyle(meta);
  const lineHeight = parseFloat(metaStyle.lineHeight);
  const forced = {
    present: true,
    injectedChars: text.length,
    metaHeight: Math.round(meta.getBoundingClientRect().height * 100) / 100,
    metaLineHeight: lineHeight,
    metaLines: Math.round((meta.getBoundingClientRect().height / lineHeight) * 100) / 100,
    metaScrollHeight: meta.scrollHeight,
    metaClientHeight: meta.clientHeight,
    clippedVertically: meta.scrollHeight > meta.clientHeight + 1,
    rowHeight: Math.round(row.getBoundingClientRect().height),
  };
  preview.textContent = original;
  return forced;
};

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("e-chats-rows.txt");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(`${PAGE_HELPERS};undefined`);
  await activateSurface(page, "会话");
  await page.waitForTimeout(1500);

  let facts = await page.evaluate(readRows);
  say("=== ITEM: 会话 rows as the surface opens ===");
  say(JSON.stringify(facts, null, 1));

  let landedInChat = null;
  while (facts.rowCount < 2) {
    const created = await page.evaluate(() => {
      const surface = document.querySelector('[data-testid="chats-surface"]');
      if (surface === null) return "no_chats_surface";
      const button = [...surface.querySelectorAll("button")].find((candidate) => (candidate.textContent ?? "").includes("新建会话"));
      if (button === undefined) return "no_create_button";
      button.click();
      return "clicked";
    });
    say("create another conversation:", created);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.waitForTimeout(1500);
      // Creating a Chat now lands IN it: the shell selects the new conversation and moves
      // the region to the chat surface, so the list is not on screen any more. Recorded
      // here as the fact it is (this driver used to read the list straight after the
      // click, which is what made it throw on a null `chats-surface`), and the list is
      // asked for again below before the rows are read.
      landedInChat = await page.evaluate(() => document.querySelector('[data-testid="chat-surface"]') !== null);
      if (landedInChat) break;
      facts = await page.evaluate(readRows);
      if (facts.rowCount >= 2) break;
    }
    if (created !== "clicked") break;
    if (landedInChat === true) {
      say("create landed in the new Chat (the shell selected it), so the list is re-opened:", landedInChat);
      const reopened = await activateSurface(page, "会话");
      say("re-opened the Chats surface:", reopened);
      await page.waitForTimeout(1200);
      facts = await page.evaluate(readRows);
    }
  }

  say("=== ITEM: rows with two conversations (both must be UNNAMED here) ===");
  say(JSON.stringify(facts, null, 1));
  say(`rowCount=${facts.rowCount}`);
  for (const [index, row] of facts.rows.entries()) {
    say(`ROW ${index + 1} titleText: ${JSON.stringify(row.titleText)}`);
    say(`ROW ${index + 1} visible text: ${JSON.stringify(row.rowText)}`);
    say(`ROW ${index + 1} hasAsterisk=${row.rowText.includes("*")} hasMustache=${row.rowText.includes("{{")}`);
  }
  const unnamedTitleTexts = facts.rows.map((row) => row.titleText);
  say(`unnamed title texts in list order: ${JSON.stringify(unnamedTitleTexts)}`);
  say(`names read 新对话 1 / 新对话 2 in list order: ${JSON.stringify(unnamedTitleTexts) === JSON.stringify(["新对话 1", "新对话 2"])}`);
  say(`the two rows are distinguishable (titles differ): ${unnamedTitleTexts[0] !== unnamedTitleTexts[1]}`);
  say(`no row carries a raw "*" or "{{": ${facts.rows.every((row) => !row.rowText.includes("*") && !row.rowText.includes("{{"))}`);
  await shot(page, "40-chats-rows-1440x900.png");

  say("=== ITEM: meta colour + contrast + clamp at both widths ===");
  for (const size of [{ w: 1440, h: 900, tag: "1440x900" }, { w: 400, h: 800, tag: "400x800" }]) {
    await page.setViewportSize({ width: size.w, height: size.h });
    await page.waitForTimeout(1200);
    const atSize = await page.evaluate(readRows);
    say(`--- @${size.tag}: meta colour/contrast per row`);
    for (const [index, row] of atSize.rows.entries()) {
      say(`  row ${index + 1}: color=${JSON.stringify(row.meta?.color)} fontSize=${row.meta?.fontSize} fontWeight=${row.meta?.fontWeight} background=${JSON.stringify(row.meta?.background)} contrast=${row.meta?.contrast}`);
    }
    say(`--- @${size.tag}: row geometry + clamp`);
    for (const [index, row] of atSize.rows.entries()) {
      say(`  row ${index + 1}: rowHeight=${row.rowRect.h} metaHeight=${row.meta?.height} metaLineHeight=${row.meta?.lineHeight} metaLines=${row.meta?.lines} lineClamp=${row.meta?.lineClamp} scrollHeight=${row.meta?.scrollHeight} clientHeight=${row.meta?.clientHeight} clippedVertically=${row.meta?.clippedVertically} previewHeight=${row.previewHeight} previewLines=${row.previewLines} previewChars=${row.previewChars}`);
    }
    const forced = await page.evaluate(forceLongPreview);
    say(`--- @${size.tag}: forced 160-char preview probe (the wire's maximum): ${JSON.stringify(forced)}`);
    if (size.w === 400) await shot(page, "40-chats-rows-400x800.png");
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(1000);
  const armed = await page.evaluate(renameRow, { index: 1 });
  say("rename row 2 -> armed:", armed);
  await page.waitForTimeout(600);
  const committed = await page.evaluate(commitRename, { title: RENAME });
  say("rename commit:", committed);
  let renamed = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(1500);
    renamed = await page.evaluate(readRows);
    if (renamed.rows.some((row) => row.titleText === RENAME)) break;
  }
  say("=== ITEM: rows after renaming row 2 ===");
  say(JSON.stringify(renamed, null, 1));
  say(`renamed row titleText: ${JSON.stringify(renamed.rows.map((row) => row.titleText))}`);
  const renamedRow = renamed.rows.find((row) => row.titleText === RENAME) ?? null;
  say(`renamed row shows its own title: ${renamedRow !== null}`);
  say(`renamed row carries no number: ${renamedRow !== null && !/[0-9]/.test(renamedRow.titleText)}`);
  const stillUnnamed = renamed.rows.filter((row) => row.titleText !== RENAME).map((row) => row.titleText);
  say(`the remaining unnamed row(s): ${JSON.stringify(stillUnnamed)} (renumbered to 1-based list order)`);
  await shot(page, "41-chats-renamed-1440x900.png");

  flush();
  await browser.close().catch(() => undefined);
  say("DONE-E");
})().catch((error) => {
  console.log("DRIVER E FAILED:", String(error).slice(0, 900));
  process.exit(1);
});