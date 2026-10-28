// Driver M: the opening a new Chat starts on — the picker, the single-opening case, and the proof
// that the picked opening is the one the new conversation actually opens on.
//
// The default companion carries three openings (`first_mes` plus two `alternate_greetings`), so the
// picker is the state a fresh run starts in; the case that matters more is the one with nothing to
// choose, and it is reached by editing her opening set down to exactly one through the surface's own
// editor (`data-opening-editor`). The chat the picker creates is NOT the mounted one, so the choice
// is proven twice: the panel's own card for the created Chat, and the transcript's first row after
// switching to that Chat — read from the row the panel itself previews with the chosen text.
const { connect, reporter, PAGE_HELPERS, activateSurface, shot } = require("./common.cjs");

const NEW_CHAT = '[data-testid="new-chat"]';

const chatRows = () => {
  const surface = document.querySelector('[data-testid="chats-surface"]');
  if (surface === null) return { present: false, rows: [] };
  const rows = [...surface.querySelectorAll('[data-testid="chat-item"]')];
  return {
    present: true,
    rows: rows.map((row, index) => ({
      index,
      title: (row.querySelector(".chat-item-title")?.textContent ?? "").trim(),
      preview: (row.querySelector('[data-testid="chat-item-preview"]')?.textContent ?? "").trim(),
      selected: (row.getAttribute("data-selected") ?? "") === "true",
    })),
  };
};

/** The panel's card for the Chat it just created: it is the one `.chat-item-card` that is not a row. */
const createdCard = () => {
  const cards = [...document.querySelectorAll(".chat-item-card")].filter(
    (card) => !card.hasAttribute("data-testid"),
  );
  if (cards.length === 0) return null;
  const card = cards[0];
  return {
    title: (card.querySelector(".chat-item-title")?.textContent ?? "").trim(),
    opening: (card.querySelector(".chat-item-main")?.innerText ?? "").trim(),
  };
};

const pickerFacts = () => {
  const picker = document.querySelector('[data-testid="opening-picker"]');
  if (picker === null) return { present: false };
  const box = picker.getBoundingClientRect();
  const options = [...picker.querySelectorAll('[data-testid="opening-option"]')];
  return {
    present: true,
    box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
    title: (picker.querySelector("h1,h2,h3")?.textContent ?? "").trim(),
    optionCount: options.length,
    options: options.map((option) => ({
      name: (option.querySelector('[data-testid="opening-option-name"]')?.textContent ?? "").trim(),
      // The stage direction the opening leads with: an option is a pair (the beat, then her line).
      action: (option.querySelector(".opening-option-action")?.textContent ?? "").trim() || null,
      line: (option.querySelector('[data-testid="opening-option-line"]')?.textContent ?? "").trim(),
      box: (() => {
        const r = option.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      })(),
    })),
  };
};

const openingEditorFacts = () => {
  const editor = document.querySelector("[data-opening-editor]");
  if (editor === null) return { present: false };
  const rows = [...editor.querySelectorAll(".opening-variant-row")];
  const buttons = [...editor.querySelectorAll("button")];
  const named = (text) => buttons.find((button) => (button.textContent ?? "").trim() === text) ?? null;
  return {
    present: true,
    sectionLabel: (editor.querySelector("h3")?.textContent ?? "").trim(),
    label: editor.querySelector("#opening-label")?.value ?? null,
    variantCount: rows.length,
    variants: rows.map((row) => (row.querySelector("textarea")?.value ?? "").trim().slice(0, 48)),
    discardDisabled: rows.map((row) => row.querySelector("button")?.disabled ?? null),
    addControl: named("添加开场白") !== null,
    saveDisabled: named("保存开场白")?.disabled ?? null,
    notice: (editor.querySelector('p[role="status"]')?.textContent ?? "").trim() || null,
  };
};

// The transcript read as the player sees it: a stage direction is its own `<em class="message-action">`
// element and her spoken words are the plain text around it. They are read apart because a row that
// opens on a beat carries that beat BEFORE the line she says.
const transcript = () =>
  [...document.querySelectorAll(".message-list > li.message")].map((row, index) => {
    const bubble = row.querySelector(".message-bubble");
    const beats =
      bubble === null
        ? []
        : [...bubble.querySelectorAll("em.message-action")].map((beat) => (beat.textContent ?? "").trim());
    const spoken = (() => {
      if (bubble === null) return null;
      const clone = bubble.cloneNode(true);
      for (const beat of [...clone.querySelectorAll("em.message-action")]) beat.remove();
      return (clone.textContent ?? "").trim();
    })();
    return {
      index,
      role: row.className.includes("player") ? "player" : "companion",
      text: (bubble?.innerText ?? "").trim(),
      beats,
      spoken,
    };
  });

// Playwright's `page.evaluate(fn, arg)` accepts exactly ONE argument: passing two throws
// "Too many arguments. If you need to pass more than 1 argument to the function wrap them in an object".
// The call site below passes the scope and the button's name, so they travel as one object.
const clickButtonNamed = ({ selector, text }) => {
  const scope = document.querySelector(selector);
  if (scope === null) return "no_scope";
  const button = [...scope.querySelectorAll("button")].find((node) => (node.textContent ?? "").trim() === text);
  if (button === undefined) return `no_button:${text}`;
  if (button.disabled) return `disabled:${text}`;
  button.click();
  return "clicked";
};

// The commit is the picker's own `opening-option-commit` (`用这个开场`), not the card's prose: since
// `c55ea777` the card is a container a player reads, selects and copies, and the prose creates
// nothing. Clicking it answered "clicked" while nothing was committed, which is why every run from
// shots-final51 on read `the opening the player chose is the one the Chat opened on: false`.
const clickOption = (index) => {
  const options = [...document.querySelectorAll('[data-testid="opening-option-commit"]')];
  const option = options[index];
  if (option === undefined) return "no_such_option";
  option.click();
  return "clicked";
};

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("m-opening-picker.txt");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(`${PAGE_HELPERS};undefined`);

  say("=== ITEM: her opening set, as the 角色 surface's own editor holds it ===");
  await activateSurface(page, "角色");
  await page.waitForTimeout(1600);
  const editorBefore = await page.evaluate(openingEditorFacts);
  say(JSON.stringify(editorBefore, null, 1));

  say("=== ITEM: New Chat with openings to choose from ===");
  // The New Chat control lives on the Chats LIST (会话), not in the open conversation (聊天).
  await activateSurface(page, "会话");
  await page.waitForTimeout(1600);
  const rowsBefore = await page.evaluate(chatRows);
  say(`chat rows before: ${rowsBefore.rows.length} (the list is ${rowsBefore.present ? "mounted" : "NOT mounted"})`);
  await page.locator(NEW_CHAT).first().click();
  await page.waitForTimeout(1500);
  const picker = await page.evaluate(pickerFacts);
  say(JSON.stringify(picker, null, 1));
  say(`picker present: ${picker.present}; options=${picker.optionCount}`);
  if (picker.present) {
    await shot(page, "85-opening-picker-1440x900.png");
    await page.setViewportSize({ width: 400, height: 800 });
    await page.waitForTimeout(1000);
    const narrow = await page.evaluate(pickerFacts);
    say(
      `picker @400x800: box=${JSON.stringify(narrow.box)} options=${narrow.optionCount} optionBoxes=${JSON.stringify(narrow.options.map((option) => option.box))}`,
    );
    await shot(page, "85-opening-picker-400x800.png");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(900);
  }

  let chosen = null;
  if (picker.present && picker.optionCount > 1) {
    const index = 1;
    chosen = picker.options[index];
    say(`choosing option #${index + 1} (NOT the default #1): ${JSON.stringify(chosen)}`);
    say(`the click answers: ${await page.evaluate(clickOption, index)}`);
    // Picking an opening creates the Chat and the shell lands IN it, so the created
    // conversation is the mounted one and its first line is read from the transcript.
    let rows = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.waitForTimeout(1200);
      rows = await page.evaluate(transcript);
      if (rows.length > 0) break;
    }
    say("=== ITEM: the new Chat's first line (the transcript's own row 0) ===");
    say(JSON.stringify(rows.slice(0, 2), null, 1));
    say(`the surface the shell left us on: chat-surface=${await page.evaluate(() => document.querySelector('[data-testid="chat-surface"]') !== null)}`);
    // The chosen opening is the one the Chat opened on, compared as rendered structure: the chooser's
    // own option (its action line and its line) against the row's beat element and its spoken text.
    const first = rows[0] ?? null;
    const rowBeats = first?.beats ?? [];
    const beatMatches =
      chosen.action === null ? rowBeats.length === 0 : rowBeats.length === 1 && rowBeats[0] === chosen.action;
    const spokenMatches = first !== null && first.spoken !== null && first.spoken.startsWith(chosen.line);
    say(`first row role=${first?.role ?? null} (companion expected)`);
    say(`chosen opening: beat=${JSON.stringify(chosen.action)} line=${JSON.stringify(chosen.line)}`);
    say(`the row's own beat(s), as em.message-action: ${JSON.stringify(rowBeats)}`);
    say(`the row's spoken text, its beat's element excluded: ${JSON.stringify(first?.spoken ?? null)}`);
    say(`the opening the player chose is the one the Chat opened on: ${beatMatches && spokenMatches}`);
    await shot(page, "85-chosen-opening-chat-1440x900.png");
    await page.setViewportSize({ width: 400, height: 800 });
    await page.waitForTimeout(1200);
    await shot(page, "85-chosen-opening-chat-400x800.png");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(900);
    await activateSurface(page, "会话");
    await page.waitForTimeout(1400);
    const created = await page.evaluate(createdCard);
    const rowsAfterChoice = await page.evaluate(chatRows);
    say(`the panel's card for the created Chat: ${JSON.stringify(created)}`);
    say(`chat rows before=${rowsBefore.rows.length} after=${rowsAfterChoice.rows.length} (one new conversation, on the other opening)`);
    await shot(page, "85-created-chat-opening-1440x900.png");
  } else {
    say("SKIPPED:no_picker_to_choose_from (the companion published at most one opening)");
  }

  say("=== ITEM: her opening set edited down to exactly one ===");
  await activateSurface(page, "角色");
  await page.waitForTimeout(1600);
  let removed = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const state = await page.evaluate(openingEditorFacts);
    if (state.variantCount <= 1) break;
    const dropped = await page.evaluate(() => {
      const editor = document.querySelector("[data-opening-editor]");
      const rows = [...editor.querySelectorAll(".opening-variant-row")];
      const last = rows[rows.length - 1];
      const button = last === null ? null : last.querySelector("button");
      if (button === null || button.disabled) return "not_removable";
      button.click();
      return "dropped";
    });
    if (dropped !== "dropped") break;
    removed += 1;
    await page.waitForTimeout(500);
  }
  const edited = await page.evaluate(openingEditorFacts);
  say(`rows discarded: ${removed}`);
  say(JSON.stringify(edited, null, 1));
  say(
    `saving the one-opening set: ${await page.evaluate(clickButtonNamed, { selector: "[data-opening-editor]", text: "保存开场白" })}`,
  );
  await page.waitForTimeout(2200);
  const saved = await page.evaluate(openingEditorFacts);
  say(JSON.stringify(saved, null, 1));
  say(`notice after saving: ${JSON.stringify(saved.notice)}`);
  await shot(page, "85-opening-editor-single-1440x900.png");

  say("=== ITEM: New Chat with exactly one opening — no picker at all ===");
  await activateSurface(page, "会话");
  await page.waitForTimeout(1600);
  const rowsBeforeSingle = await page.evaluate(chatRows);
  await page.locator(NEW_CHAT).first().click();
  await page.waitForTimeout(2600);
  const singlePicker = await page.evaluate(pickerFacts);
  const landed = await page.evaluate(() => document.querySelector('[data-testid="chat-surface"]') !== null);
  say(`picker present: ${singlePicker.present}; options=${singlePicker.optionCount ?? 0}`);
  say(`the New Chat created the conversation outright (the shell landed in it): ${landed}`);
  await shot(page, "85-new-chat-single-opening-1440x900.png");
  await activateSurface(page, "会话");
  await page.waitForTimeout(1600);
  const rowsAfterSingle = await page.evaluate(chatRows);
  const createdSingle = await page.evaluate(createdCard);
  say(`chat rows before=${rowsBeforeSingle.rows.length} after=${rowsAfterSingle.rows.length} (a Chat was created without a step in between)`);
  say(`the panel's card for the created Chat: ${JSON.stringify(createdSingle)}`);

  flush();
  await browser.close().catch(() => undefined);
  say("DONE-M");
})().catch((error) => {
  console.log("DRIVER M FAILED:", String(error).slice(0, 900));
  process.exit(1);
});
