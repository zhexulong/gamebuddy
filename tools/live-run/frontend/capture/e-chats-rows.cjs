// Driver E: the Chats rows. A row carries an identity: two unnamed Chats read 新对话 1 / 新对话 2
// (1-based, in displayed list order), a renamed row shows its own title with NO number, and no row
// shows a raw `*` or `{{`. The row meta line is clamped to two lines (height, line clamp, chars
// inside the box, plus a forced 160-char preview probe — the wire's own maximum), and the meta
// colour's contrast against its card is measured at both widths.
const { connect, reporter, PAGE_HELPERS, activateSurface, shot, readDurableTranscript, createChat } = require("./common.cjs");

const RENAME = "重命名契约行";
/** The three controls every active row carries, by the accessible name the surface gives them. */
const RENAME_LABEL = "重命名会话";
const ARCHIVE_LABEL = "归档";
const TRASH_LABEL = "删除";

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

/**
 * Every row and the controls that row carries.
 *
 * The owner's ruling is that a row's rename, archive and trash name THAT row's own Chat, so the
 * controls are read per row rather than from one row: `data-selected` is the panel's own statement of
 * which Chat the mount is on, and it is what tells the driver which rows this measurement must leave
 * alone.
 */
const rowControls = () => {
  const surface = document.querySelector('[data-testid="chats-surface"]');
  if (surface === null) return { present: false, rows: [] };
  const rows = [...surface.querySelectorAll('[data-testid="chat-item"]')];
  return {
    present: true,
    rows: rows.map((row, index) => ({
      index,
      title: (row.querySelector(".chat-item-title")?.textContent ?? "").trim(),
      selected: (row.getAttribute("data-selected") ?? "") === "true",
      selectable: (row.getAttribute("data-selectable") ?? "") === "true",
      controls: [...row.querySelectorAll(".chat-item-actions button")].map(
        (button) => (button.getAttribute("aria-label") ?? (button.textContent ?? "").trim()),
      ),
      armed: row.querySelector('[data-testid="chat-retention-confirm"]') !== null,
    })),
  };
};

/** Click one named control in one row. */
const armControl = ({ index, label }) => {
  const surface = document.querySelector('[data-testid="chats-surface"]');
  if (surface === null) return "no_chats_surface";
  const row = [...surface.querySelectorAll('[data-testid="chat-item"]')][index];
  if (row === undefined) return "no_such_row";
  const button = [...row.querySelectorAll(".chat-item-actions button")].find(
    (candidate) => (candidate.getAttribute("aria-label") ?? "") === label,
  );
  if (button === undefined) return `no_control:${label}`;
  if (button.disabled) return `disabled:${label}`;
  button.click();
  return "clicked";
};

/**
 * Open one row's rename editor.
 *
 * Self-contained like every other page function here: the pencil is found by the panel's own accessible
 * name for it (the driver's RENAME_LABEL is the same string), and the label is inlined because a
 * serialized function cannot see module scope - the same reason `commitRename` inlines the save label.
 */
const renameRow = ({ index }) => {
  const surface = document.querySelector('[data-testid="chats-surface"]');
  if (surface === null) return "no_chats_surface";
  const row = [...surface.querySelectorAll('[data-testid="chat-item"]')][index];
  if (row === undefined) return "no_such_row";
  const button = [...row.querySelectorAll(".chat-item-actions button")].find(
    (candidate) => (candidate.getAttribute("aria-label") ?? "") === "重命名会话",
  );
  if (button === undefined) return "no_rename_control";
  if (button.disabled) return "rename_disabled";
  button.click();
  return "opened";
};

/** The armed archive/trash confirmation, and which row it belongs to. */
const retentionConfirmFacts = () => {
  const block = document.querySelector('[data-testid="chat-retention-confirm"]');
  if (block === null) return { present: false };
  const row = block.closest('[data-testid="chat-item"]');
  const rect = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    present: true,
    rowTitle: (row?.querySelector(".chat-item-title")?.textContent ?? "").trim(),
    prompt: (block.querySelector('[role="status"]')?.textContent ?? "").trim(),
    yes: (block.querySelector('[data-testid="chat-retention-confirm-yes"]')?.textContent ?? "").trim(),
    no: (block.querySelector('[data-testid="chat-retention-confirm-no"]')?.textContent ?? "").trim(),
    box: rect(block),
    controlsInThatRowWhileArmed: row === null ? null : row.querySelectorAll(".chat-item-actions button").length,
  };
};

const commitRetention = () => {
  const yes = document.querySelector('[data-testid="chat-retention-confirm-yes"]');
  if (yes === null) return "no_confirm";
  yes.click();
  return "confirmed";
};

/** One row's own select control. K drives this same gesture; the archive half uses it to go back. */
const clickChatSelect = ({ index }) => {
  const surface = document.querySelector('[data-testid="chats-surface"]');
  if (surface === null) return "no_chats_surface";
  const row = [...surface.querySelectorAll('[data-testid="chat-item"]')][index];
  if (row === undefined) return "no_such_row";
  const button = row.querySelector('[data-testid="chat-select"]');
  if (button === null) return "no_chat_select";
  if (button.disabled) return "select_disabled";
  button.click();
  return "clicked";
};

/** The select requests the wire carries - the one thing a non-mounted mutation must not produce. */
const selectRequests = (wire) => wire.filter((entry) => entry.route.includes("/chat/select"));

/**
 * What the mount is showing, in both halves the ruling is about: the Host's own projection of the
 * mounted Chat (title + transcript, read through the product's own state route) and the rows the
 * transcript renders. Byte-identity is the comparison of these two serializations.
 */
async function mountedSnapshot(page) {
  const durable = await readDurableTranscript(page);
  const dom = await page.evaluate(() =>
    [...document.querySelectorAll(".message-list > li.message")].map((row) => ({
      handle: row.getAttribute("data-handle"),
      role: row.className.includes("player") ? "player" : "companion",
      text: (row.querySelector(".message-bubble")?.innerText ?? "").trim(),
    })),
  );
  return { durable, dom };
}

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

/** The same snapshot with the per-mount identity removed, for comparisons across a re-mount. */
function withoutHandles(snapshot) {
  const { selection: _selection, transcript, ...rest } = snapshot.durable ?? {};
  return {
    durable: {
      ...rest,
      transcript: (transcript ?? []).map(({ handle: _handle, ...keep }) => keep),
    },
    dom: (snapshot.dom ?? []).map(({ handle: _handle, ...keep }) => keep),
  };
}

/** What actually differs between two mounted snapshots, in one line - or "identical". */
function snapshotDifference(before, after) {
  const parts = [];
  const durableKeys = new Set([...Object.keys(before.durable ?? {}), ...Object.keys(after.durable ?? {})]);
  for (const key of durableKeys) {
    if (key === "transcript") continue;
    if (JSON.stringify(before.durable?.[key]) !== JSON.stringify(after.durable?.[key])) {
      parts.push(`durable.${key}: ${JSON.stringify(before.durable?.[key])} -> ${JSON.stringify(after.durable?.[key])}`);
    }
  }
  const a = before.durable?.transcript ?? [];
  const b = after.durable?.transcript ?? [];
  if (a.length !== b.length) parts.push(`transcript length: ${a.length} -> ${b.length}`);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (JSON.stringify(a[index]) !== JSON.stringify(b[index])) {
      const left = a[index] ?? {};
      const right = b[index] ?? {};
      const changed = [...new Set([...Object.keys(left), ...Object.keys(right)])]
        .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
        .map((key) => `${key}: ${JSON.stringify(left[key])} -> ${JSON.stringify(right[key])}`);
      parts.push(`transcript[${index}] ${changed.join(", ")}`.slice(0, 240));
      break;
    }
  }
  if (JSON.stringify(before.dom) !== JSON.stringify(after.dom)) {
    parts.push(`rendered rows: ${before.dom.length} -> ${after.dom.length}`);
  }
  return parts.length === 0 ? "identical" : parts.join(" | ").slice(0, 400);
}

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("e-chats-rows.txt");

  /** A claim about the product fails the driver when it is false: a false print would read as a pass. */
  const assertClaim = (label, ok, detail) => {
    say(`${label}: ${ok}${detail === undefined ? "" : ` (${detail})`}`);
    if (!ok) {
      // The facts file is this driver's only report: write the lines it did measure before failing, so a
      // red run says which item it reached instead of leaving the report to guess.
      flush();
      throw new Error(`driver_e: ${label}`);
    }
  };
  // Every request this page makes, so "a non-mounted mutation produces no selection" can be a fact about the
  // wire rather than an inference from the DOM (`selectRequests` above filters this list).
  const wire = [];
  page.on("request", (request) => {
    try {
      wire.push({ route: new URL(request.url()).pathname, method: request.method() });
    } catch {
      // A request whose URL does not parse is not a route this check is about.
    }
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(`${PAGE_HELPERS};undefined`);
  await activateSurface(page, "会话");
  await page.waitForTimeout(1500);

  let facts = await page.evaluate(readRows);
  say("=== ITEM: 会话 rows as the surface opens ===");
  say(JSON.stringify(facts, null, 1));

  // One control, two jobs: with openings to choose from the create control opens the picker, and the
  // Chat exists only once an opening is COMMITTED. This driver means "another conversation", which is
  // the default opening - the same thing a companion with no choice gets. The commit is the picker's
  // own `opening-option-commit`, not the card's prose: `c55ea777` made the prose inert text a reader
  // can select and copy, and clicking it now creates nothing (which is how this loop came to press it
  // five times, get five `clicked` answers, and still measure a one-row list).
  let createAttempts = 0;
  while (facts.rowCount < 2) {
    createAttempts += 1;
    if (createAttempts > 5) {
      say(`gave up after ${createAttempts - 1} create attempts without a second row on the list`);
      break;
    }
    const created = await createChat(page);
    say(`create another conversation: control=${created.started} committed_opening=${JSON.stringify(created.committed)} landed_in_the_new_chat=${created.landed}`);
    if (!created.landed) break;
    // Creating a Chat lands IN it: the shell selects the new conversation and moves the region to the
    // chat surface, so the list is not on screen any more. It is asked for again before the rows are read.
    say("create landed in the new Chat (the shell selected it), so the list is re-opened:", created.landed);
    const reopened = await activateSurface(page, "会话");
    say("re-opened the Chats surface:", reopened);
    await page.waitForTimeout(1200);
    facts = await page.evaluate(readRows);
  }

  say("=== ITEM: rows with two conversations (both must be UNNAMED here) ===");
  say(JSON.stringify(facts, null, 1));
  say(`rowCount=${facts.rowCount}`);
  // The whole family below (identity, numbering, rename, and the 41b/41c half that manages a row the
  // mount is not on) is about TWO rows, and a fresh root starts with one. "I could not make a second"
  // printed as a false and skipped past is what let `shots-final55` report a green run with 41b and
  // 41c missing. So a list this driver could not grow is a named failure.
  assertClaim(
    "the list carries the two conversations this family measures",
    facts.rowCount >= 2,
    `${facts.rowCount} row(s) after ${createAttempts} create attempt(s): ${JSON.stringify(facts.rows.map((row) => row.titleText))}`,
  );
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

  // === ITEM: a management operation on a row that is NOT the mounted Chat ===
  //
  // The owner's ruling covers all three commands: an operation names that row's own Chat, and the mounted
  // Chat - its lease and its stream - is left alone. Read the Host's own projection of the mounted
  // conversation before and after (the product's state route plus the rows the transcript renders), and read
  // the wire for the one request the ruling forbids: a selection.
  const listBefore = await page.evaluate(rowControls);
  const selectedIndex = listBefore.rows.findIndex((row) => row.selected);
  const otherIndex = listBefore.rows.findIndex((row) => !row.selected);
  const snapshotBefore = await mountedSnapshot(page);
  say("=== ITEM: a row that is not the mounted Chat ===");
  say(`rows=${listBefore.rows.length} selected=${selectedIndex} notSelected=${otherIndex}`);
  say(
    `the mounted Chat before: ${JSON.stringify({ title: snapshotBefore.durable.title, kept: (snapshotBefore.durable.transcript ?? []).length, rendered: snapshotBefore.dom.length })}`,
  );
  say(
    `(the Chats list is the surface on screen, so ${snapshotBefore.dom.length} transcript rows are rendered here - the durable half is what carries the comparison)`,
  );

  assertClaim(
    "the list has a selected row and a row that is not it (the two the management half needs)",
    selectedIndex >= 0 && otherIndex >= 0,
    `selected=${selectedIndex} notSelected=${otherIndex} of ${listBefore.rows.length}`,
  );
  // The half below is scoped: its two unique titles and the spare Chat it creates belong to the rows this
  // assertion just required, and nothing after this block needs them.
  {
    // Two unique titles carry the identity of the rows this half acts on. An auto-title cannot: the list
    // renumbers 新对话 1 / 新对话 2 as rows come and go, so the same row reads differently later.
    const OTHER_TITLE = "不是我在的那一行";
    const SPARE_TITLE = "驱动E造的备用会话";

    // === ITEM: a row that is not the mounted Chat ===
    const wireBeforeRename = wire.length;
    say(`renaming row ${otherIndex}: ${await page.evaluate(renameRow, { index: otherIndex })}`);
    await page.waitForTimeout(600);
    say(`commit: ${await page.evaluate(commitRename, { title: OTHER_TITLE })}`);
    let listAfterRename = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.waitForTimeout(1500);
      listAfterRename = await page.evaluate(rowControls);
      if (listAfterRename.rows.some((row) => row.title === OTHER_TITLE)) break;
    }
    const snapshotAfterRename = await mountedSnapshot(page);
    assertClaim("that row carries its own title now", listAfterRename.rows.some((row) => row.title === OTHER_TITLE));
    assertClaim(
      "the mounted row is the same row and still selected",
      listAfterRename.rows.findIndex((row) => row.selected) === selectedIndex,
      `selected index ${listAfterRename.rows.findIndex((row) => row.selected)} was ${selectedIndex}`,
    );
    assertClaim(
      "the mounted Chat is byte-identical after the rename",
      JSON.stringify(snapshotAfterRename) === JSON.stringify(snapshotBefore),
    );
    assertClaim(
      "the rename produced no selection request",
      selectRequests(wire.slice(wireBeforeRename)).length === 0,
      JSON.stringify(selectRequests(wire.slice(wireBeforeRename))),
    );
    await shot(page, "41b-chats-renamed-a-row-you-are-not-in-1440x900.png");

    // === ITEM: the spare Chat this driver creates, so the row the archive half removes is one it made ===
    //
    // The list belongs to the whole run: a driver that archives a row it FOUND spends a row the drivers after it
    // need (K chooses a NON-selected row). So the row archived below is one this driver creates, and it is given a
    // unique title immediately - which is what lets the archive half name it after two other rows have moved.
    say("=== ITEM: the spare Chat this driver creates for the archive half ===");
    const spare = await createChat(page);
    say(`the product's own New Chat control: control=${spare.started} committed_opening=${JSON.stringify(spare.committed)} landed=${spare.landed}`);
    assertClaim("the created Chat became the mount (the shell lands in what it creates)", spare.landed);
    say("re-opened the Chats surface:", await activateSurface(page, "会话"));
    await page.waitForTimeout(1200);
    let spareRows = await page.evaluate(rowControls);
    for (let attempt = 0; attempt < 12 && spareRows.rows.length <= listBefore.rows.length; attempt += 1) {
      await page.waitForTimeout(1500);
      spareRows = await page.evaluate(rowControls);
    }
    assertClaim(
      "the created Chat is on the list",
      spareRows.rows.length > listBefore.rows.length,
      `${spareRows.rows.length} rows, was ${listBefore.rows.length}`,
    );
    const createdRowIndex = spareRows.rows.findIndex((row) => row.selected);
    assertClaim("the created Chat is the selected row", createdRowIndex >= 0, `index ${createdRowIndex}`);
    say(`renaming the created row to a unique title: ${await page.evaluate(renameRow, { index: createdRowIndex })}`);
    await page.waitForTimeout(600);
    say(`commit: ${await page.evaluate(commitRename, { title: SPARE_TITLE })}`);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.waitForTimeout(1500);
      spareRows = await page.evaluate(rowControls);
      if (spareRows.rows.some((row) => row.title === SPARE_TITLE)) break;
    }
    assertClaim("the spare carries its own unique title", spareRows.rows.some((row) => row.title === SPARE_TITLE));

    // Back to the Chat this driver started on: the only row that is neither of the two unique titles.
    const backIndex = spareRows.rows.findIndex((row) => row.title !== OTHER_TITLE && row.title !== SPARE_TITLE);
    assertClaim("the row this driver started on is still on the list", backIndex >= 0, `index ${backIndex}`);
    say(`choosing the row this driver started on again (row ${backIndex}): ${await page.evaluate(clickChatSelect, { index: backIndex })}`);
    let backSelected = false;
    for (let attempt = 0; attempt < 20 && backSelected === false; attempt += 1) {
      await page.waitForTimeout(1500);
      if (await page.evaluate(() => document.querySelector('[data-testid="chat-surface"]') !== null)) {
        await activateSurface(page, "会话");
        await page.waitForTimeout(1000);
      }
      spareRows = await page.evaluate(rowControls);
      backSelected = spareRows.rows[backIndex]?.title !== SPARE_TITLE && spareRows.rows[backIndex]?.selected === true;
    }
    const snapshotAfterBack = await mountedSnapshot(page);
    assertClaim("the row this driver started on is the mounted one again", backSelected);
    // **Content**, not bytes: selecting a row is a re-mount, and a message handle is minted by the mount's own
    // projection (`lease.browserProjection.projectMessageHandle`, `chat-pipeline-service.ts:496`) - so the same
    // message carries a different handle after every re-mount, by design. The first run of this claim failed on
    // exactly that (`transcript[0] handle: "LWIK-Fgn…" -> "0qd00-YR…"`) and on nothing else, which is what says
    // the content is what this claim is about. The archive below runs without a re-mount, so it keeps the
    // byte-for-byte form - but against the mount this driver is on now (`snapshotAfterBack`), never against
    // `snapshotBefore`, whose handles belong to the mount two switches ago.
    assertClaim(
      "the mount is the same Chat with the same content after coming back to it (handles are per-mount)",
      JSON.stringify(withoutHandles(snapshotAfterBack)) === JSON.stringify(withoutHandles(snapshotBefore)),
      snapshotDifference(withoutHandles(snapshotBefore), withoutHandles(snapshotAfterBack)),
    );

    // === ITEM: archive the spare, from the list, while the mount is the row this driver started on ===
    //
    // The byte-identity baseline is `snapshotAfterBack` - the mount this driver is on right now - and
    // NOT `snapshotBefore`, which was read before this driver created the spare and selected back, so
    // its handles belong to a mount two switches ago. A message handle is minted per mount: an HMAC
    // keyed on a secret created once per `startMountedChatRuntime`
    // (host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts:1709,2977),
    // and a switch releases the old mount and mints the successor - so any switch changes handles, and
    // a byte comparison may only span a window with no switch in it. Archiving a row that is NOT the
    // mounted one has no switch in it: the panel's `transition()` re-reads the list and calls
    // `onCurrentChatRemoved` only when the removed handle IS the mounted one
    // (dialogue-web/src/components/management-surface-panels.tsx:505-512), and the Host swaps the lane
    // only for a committed `chat.select`
    // (host/src/composition/desktop-presentation-admission-owner.ts:743). So the mount stays the same
    // object - handles, chat handle and selection generation included - and that byte-identity is what
    // proves the archive did not re-mount.
    const archiveIndex = spareRows.rows.findIndex((row) => row.title === SPARE_TITLE);
    assertClaim("the spare is on the list to archive", archiveIndex >= 0, `index ${archiveIndex}`);
    const wireBeforeArchive = wire.length;
    say(`the mounted identity just before the archive: ${JSON.stringify(snapshotAfterBack.durable.selection)}`);
    say(`archiving the spare (row ${archiveIndex} of ${spareRows.rows.length})`);
    say(`arming: ${await page.evaluate(armControl, { index: archiveIndex, label: ARCHIVE_LABEL })}`);
    await page.waitForTimeout(800);
    const armed = await page.evaluate(retentionConfirmFacts);
    say(`the armed confirmation, and whose row it is: ${JSON.stringify(armed)}`);
    assertClaim("the confirmation belongs to the spare", armed.rowTitle === SPARE_TITLE, `row ${armed.rowTitle}`);
    say(`confirming: ${await page.evaluate(commitRetention)}`);
    let listAfterArchive = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.waitForTimeout(1500);
      listAfterArchive = await page.evaluate(rowControls);
      if (!listAfterArchive.rows.some((row) => row.title === SPARE_TITLE)) break;
    }
    const snapshotAfterArchive = await mountedSnapshot(page);
    say(`rows now: ${JSON.stringify(listAfterArchive.rows.map((row) => row.title))}`);
    assertClaim("the archived row left the list", !listAfterArchive.rows.some((row) => row.title === SPARE_TITLE));
    assertClaim(
      "the two rows this driver found are still on the list (one of them renamed)",
      listAfterArchive.rows.length === listBefore.rows.length &&
        listAfterArchive.rows.some((row) => row.title === OTHER_TITLE),
      `${listAfterArchive.rows.length} rows, was ${listBefore.rows.length}`,
    );
    say(`the mounted identity just after the archive: ${JSON.stringify(snapshotAfterArchive.durable.selection)}`);
    assertClaim(
      "the mounted Chat is byte-identical after the archive (same mount: unchanged message handles, chat handle and selection generation)",
      JSON.stringify(snapshotAfterArchive) === JSON.stringify(snapshotAfterBack),
      snapshotDifference(snapshotAfterBack, snapshotAfterArchive),
    );
    assertClaim(
      "the archive produced no selection request",
      selectRequests(wire.slice(wireBeforeArchive)).length === 0,
      JSON.stringify(selectRequests(wire.slice(wireBeforeArchive))),
    );
    await shot(page, "41c-chats-archived-a-row-you-are-not-in-1440x900.png");
  }

  flush();
  await browser.close().catch(() => undefined);
  say("DONE-E");
})().catch((error) => {
  console.log("DRIVER E FAILED:", String(error).slice(0, 900));
  process.exit(1);
});