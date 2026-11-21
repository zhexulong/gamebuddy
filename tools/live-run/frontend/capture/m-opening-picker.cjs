// Driver M: the opening a new Chat starts on — the picker, the single-opening case, and the proof
// that the picked opening is the one the new conversation actually opens on.
//
// The default companion carries three openings (`first_mes` plus two `alternate_greetings`), so the
// picker is the state a fresh run starts in; the case that matters more is the one with nothing to
// choose, and it is reached by editing her opening set down to exactly one through the surface's own
// editor (`data-opening-editor`). The chat the picker creates is NOT the mounted one, so the choice
// is proven twice: the panel's own card for the created Chat, and the transcript's first row after
// switching to that Chat — read from the row the panel itself previews with the chosen text.
const { connect, reporter, PAGE_HELPERS, activateSurface, shot, observe, observationStart, waitForPanel, conversationShown } = require("./common.cjs");
const { reconciliationVerdict } = require("./reconciliation-verdict.mjs");

const NEW_CHAT = '[data-testid="new-chat"]';
// The Chats list, read as a panel: a row count that has stopped changing, with no loading line left. Every read
// of it below waits for that instead of for a duration (see `waitForPanel`).
const CHATS_LIST = { name: "chats-list", panel: '[data-testid="chats-surface"]', item: '[data-testid="chat-item"]' };
// The opening editor mounts with its section before its card read lands, so every read of it waits for
// the panel to be loaded rather than for a duration (see `waitForPanel`).
const OPENING_EDITOR = { name: "opening-editor", panel: "[data-opening-editor]", item: ".opening-variant-row" };

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

/**
 * The press on 新建聊天 is answered one of two ways, and which one is the companion's own fact: the picker mounts
 * when she has openings to choose from, and the Chat is created - with the shell landing in it - when she has
 * none. A fixed sleep answers for one of them only. `frontend--r13` waited 2600 ms for the single-opening press
 * on a machine whose build took 10.3 min against run 1's 4.2 and read a picker that had not mounted; the same
 * code passed at `40c9b7f5`, which is what makes this a driver reading rather than a product regression.
 *
 * `conversationShown` is the shell's own statement of the second answer (the surface route, not the parked
 * conversation's presence), and the picker's `data-testid` is the first. Bounded, and the answer is reported as
 * a fact (`picker` / `conversation` / `neither`) whether or not it arrived in time.
 */
const waitForNewChatAnswered = async (page, timeoutMs = 20000) => {
  const started = Date.now();
  for (;;) {
    if (await page.evaluate(() => document.querySelector('[data-testid="opening-picker"]') !== null))
      return { answer: "picker", waitedMs: Date.now() - started };
    if (await page.evaluate(conversationShown)) return { answer: "conversation", waitedMs: Date.now() - started };
    if (Date.now() - started > timeoutMs) return { answer: "neither", waitedMs: Date.now() - started };
    await page.waitForTimeout(250);
  }
};

/**
 * The 保存开场白 round trip, from the control that starts it.
 *
 * The editor publishes nothing else about a save: no loading line and no `data-state`. What it does publish is
 * the control itself - it reads 保存中… (so `saveDisabled`, which is read by the name 保存开场白, is null) while
 * the Host call is in flight and 保存开场白 again when the answer has landed - so the wait requires the press to
 * be SEEN taken before it accepts the control's return, and a click the panel refused cannot be answered with
 * the state that was there before it.
 */
const waitForOpeningSaveSettled = async (page, timeoutMs = 20000) => {
  const started = Date.now();
  let tookThePress = false;
  let facts = await page.evaluate(openingEditorFacts);
  while (Date.now() - started < timeoutMs) {
    if (facts.saveDisabled !== false) tookThePress = true;
    else if (tookThePress) return { facts, tookThePress, waitedMs: Date.now() - started };
    await page.waitForTimeout(250);
    facts = await page.evaluate(openingEditorFacts);
  }
  return { facts, tookThePress, waitedMs: Date.now() - started };
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

/**
 * Wait for the shell to SHOW the created conversation, and say what it saw if it never does.
 *
 * Committing an opening is two steps in order: the Chat is created durably (on the default opening)
 * and then the shell switches the region into it and applies the chosen opening. This was read one
 * round after the press - "does the transcript have rows" - and that is true immediately, because the
 * conversation already mounted keeps its rows while parked (`.surface-slot-parked` hides it without
 * removing it). The reading therefore answered about the OTHER conversation: measured r17, the surface
 * route said `chat-surface=false` 1.2 s after the press while the panel's card already held the new
 * Chat, and the assertion that exists to prove a chosen opening lands could not pass.
 */
const waitForCreatedConversation = async (page, timeoutMs = 30000) => {
  const started = Date.now();
  for (;;) {
    if (await page.evaluate(conversationShown)) return { landed: true, waitedMs: Date.now() - started, panel: null };
    if (Date.now() - started > timeoutMs) {
      const panel = await page.evaluate(() => new URLSearchParams(window.location.hash.slice(1)).get("panel"));
      return { landed: false, waitedMs: Date.now() - started, panel };
    }
    await page.waitForTimeout(250);
  }
};

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("m-opening-picker.txt");
  /*
   * The claims this driver makes, counted the way `t` and `u` count theirs. Both facts below were
   * printed and neither moved the exit code, so a run could say `the opening the player chose is the
   * one the Chat opened on: false` and still be counted as a pass (`reconciliation-verdict.mjs`).
   * Proving that a chosen opening lands is this driver's own purpose (its header), so the false is
   * what it exists to report - as a failure, not as a line beside a green run.
   */
  const claims = { assertions: 0, failures: 0 };
  const claim = (name, held, detail) => {
    claims.assertions += 1;
    if (!held) claims.failures += 1;
    say(`ASSERT ${name}: ${held ? "PASS" : "FAIL"} — ${detail}`);
  };
  const observationFrom = await observationStart(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(`${PAGE_HELPERS};undefined`);

  say("=== ITEM: her opening set, as the 角色 surface's own editor holds it ===");
  await activateSurface(page, "角色");
  await waitForPanel(page, OPENING_EDITOR);
  const editorBefore = await page.evaluate(openingEditorFacts);
  say(JSON.stringify(editorBefore, null, 1));

  say("=== ITEM: New Chat with openings to choose from ===");
  // The New Chat control lives on the Chats LIST (会话), not in the open conversation (聊天).
  await activateSurface(page, "会话");
  await waitForPanel(page, CHATS_LIST);
  const rowsBefore = await page.evaluate(chatRows);
  say(`chat rows before: ${rowsBefore.rows.length} (the list is ${rowsBefore.present ? "mounted" : "NOT mounted"})`);
  await page.locator(NEW_CHAT).first().click();
  const firstAnswer = await waitForNewChatAnswered(page);
  say(`the press was answered by the ${firstAnswer.answer} after ${String(firstAnswer.waitedMs)}ms`);
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
    // Picking an opening creates the Chat AND the shell lands IN it, so the created conversation is
    // the mounted one and its first line is read from the transcript - after the landing, not before
    // it (see `waitForCreatedConversation`).
    const landing = await waitForCreatedConversation(page);
    say(
      landing.landed
        ? `the shell showed the created conversation after ${String(landing.waitedMs)}ms`
        : `the shell never showed the created conversation in ${String(landing.waitedMs)}ms; the surface route still read panel=${JSON.stringify(landing.panel)}`,
    );
    const rows = landing.landed ? await page.evaluate(transcript) : [];
    say("=== ITEM: the new Chat's first line (the transcript's own row 0) ===");
    say(JSON.stringify(rows.slice(0, 2), null, 1));
    const landedInCreated = landing.landed;
    say(`the surface the shell left us on: chat-surface=${landedInCreated}`);
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
    /*
     * The one thing the product promises unconditionally when a chosen opening is committed:
     * "A refused commit leaves the Chat durable on the opening it was created with - the player
     * still lands in it" (`ComposedReferenceGameApp.handleChatSwitched`). Whether the opening itself
     * was applied is a separate fact the line above records, and a refused commit with the surface's
     * own sentence is a legal outcome, so it is not asserted here; the landing is.
     */
    claim(
      "committing-a-chosen-opening-lands-in-the-created-chat",
      landedInCreated === true,
      `chosen line=${JSON.stringify(chosen.line)}; shell's surface route showed the conversation=${landedInCreated}`,
    );
    await shot(page, "85-chosen-opening-chat-1440x900.png");
    await page.setViewportSize({ width: 400, height: 800 });
    await page.waitForTimeout(1200);
    await shot(page, "85-chosen-opening-chat-400x800.png");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(900);
    await activateSurface(page, "会话");
    await waitForPanel(page, CHATS_LIST);
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
  await waitForPanel(page, OPENING_EDITOR);
  let removed = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const state = await page.evaluate(openingEditorFacts);
    /*
     * The editor can leave the surface after the wait that saw it settled, and reading through an
     * element that is gone turned that into `TypeError: Cannot read properties of null` (measured
     * D:/gb-modcheck/frontend--r8). Whether the panel is still there is a fact this driver reads, so
     * it says it and stops the loop rather than crashing on the way to saying it.
     */
    if (state.present !== true) {
      say("the opening editor the wait saw is gone before it could be read; nothing was discarded");
      break;
    }
    if (state.variantCount <= 1) break;
    const dropped = await page.evaluate(() => {
      const editor = document.querySelector("[data-opening-editor]");
      if (editor === null) return "editor_gone";
      const rows = [...editor.querySelectorAll(".opening-variant-row")];
      const last = rows[rows.length - 1];
      const button = last === null ? null : last.querySelector("button");
      if (button === null || button.disabled) return "not_removable";
      button.click();
      return "dropped";
    });
    if (dropped !== "dropped") {
      if (dropped === "editor_gone") say("the opening editor left the surface mid-discard; nothing was discarded");
      break;
    }
    removed += 1;
    try {
      // The editor re-renders its rows on a discard, so the next read must not see the count this iteration
      // acted on: a stale 6 would drop a SIXTH row. `waitForPanel`'s two-read stability is that guarantee.
      await waitForPanel(page, OPENING_EDITOR);
    } catch (error) {
      say(`the opening editor did not settle after the discard, so this loop stops here: ${String(error).slice(0, 240)}`);
      break;
    }
  }
  const edited = await page.evaluate(openingEditorFacts);
  say(`rows discarded: ${removed}`);
  say(JSON.stringify(edited, null, 1));
  say(
    `saving the one-opening set: ${await page.evaluate(clickButtonNamed, { selector: "[data-opening-editor]", text: "保存开场白" })}`,
  );
  const saveWait = await waitForOpeningSaveSettled(page);
  const saved = saveWait.facts;
  say(
    `the save settled after ${String(saveWait.waitedMs)}ms (the panel was seen calling the Host: ${String(saveWait.tookThePress)})`,
  );
  say(JSON.stringify(saved, null, 1));
  say(`notice after saving: ${JSON.stringify(saved.notice)}`);
  await shot(page, "85-opening-editor-single-1440x900.png");

  say("=== ITEM: New Chat with exactly one opening — no picker at all ===");
  await activateSurface(page, "会话");
  await waitForPanel(page, CHATS_LIST);
  const rowsBeforeSingle = await page.evaluate(chatRows);
  await page.locator(NEW_CHAT).first().click();
  const singleAnswer = await waitForNewChatAnswered(page);
  say(`the press was answered by the ${singleAnswer.answer} after ${String(singleAnswer.waitedMs)}ms`);
  const singlePicker = await page.evaluate(pickerFacts);
  const landed = await page.evaluate(conversationShown);
  say(`picker present: ${singlePicker.present}; options=${singlePicker.optionCount ?? 0}`);
  claim(
    "new-chat-with-one-opening-lands-in-the-conversation",
    landed === true,
    `the shell's own surface route after the press: chat-surface shown=${landed}`,
  );
  await shot(page, "85-new-chat-single-opening-1440x900.png");
  await activateSurface(page, "会话");
  await waitForPanel(page, CHATS_LIST);
  const rowsAfterSingle = await page.evaluate(chatRows);
  const createdSingle = await page.evaluate(createdCard);
  say(`chat rows before=${rowsBeforeSingle.rows.length} after=${rowsAfterSingle.rows.length} (a Chat was created without a step in between)`);
  say(`the panel's card for the created Chat: ${JSON.stringify(createdSingle)}`);

  await observe(page, say, "m", { sinceMs: observationFrom });
  say(reconciliationVerdict({ assertions: claims.assertions, failures: claims.failures }));
  flush();
  await browser.close().catch(() => undefined);
  say("DONE-M");
})().catch((error) => {
  console.log("DRIVER M FAILED:", String(error).slice(0, 900));
  process.exit(1);
});
