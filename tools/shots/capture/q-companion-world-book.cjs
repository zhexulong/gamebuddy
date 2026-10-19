// Driver Q: her own world book, edited by the player (brief item 5).
//
// The book the companion in play carries (`data-companion-world-book`) is read, edited, added to and
// pruned, one save at a time, and every step is read back from the DOM AND from the Host's own
// projection (`GET /api/tavern/v1/companions/<handle>/worldbook`) — the draft saves the WHOLE list
// and CASes on the revision it was opened on, so "the change took" is a claim about the durable
// revisions, not about a field that still holds the player's typing.
//
// The refusal case is the one fact a save must not hide: a book that changed after the editor was
// opened must keep failing until the editor is reopened on the book that is there now. The editor
// pins its revision at open time and never rebases it, so this driver produces that staleness the
// only way it can be produced inside one tab — a second writer on the page's own session — and then
// measures the sentence the surface shows when the save it still offers is pressed.
const { connect, reporter, PAGE_HELPERS, activateSurface, shot } = require("./common.cjs");

const bookFacts = () => {
  const section = document.querySelector("[data-companion-world-book]");
  if (section === null) return { present: false };
  const rect = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const entries = [...section.querySelectorAll("[data-companion-world-book-entry]")].map((row) => ({
    title: (row.querySelector("strong")?.textContent ?? "").trim(),
    facts: (row.querySelector("p")?.textContent ?? "").trim(),
    body: (row.querySelector(".companion-world-book-body")?.textContent ?? "").trim(),
    bodyIsRendered: row.querySelector(".companion-world-book-body") !== null,
    textDisclosureOpen: row.querySelector("[data-companion-world-book-entry-text]")?.open ?? null,
  }));
  const edit = section.querySelector("[data-companion-world-book-edit]");
  const notice = section.querySelector('[data-companion-world-book-notice]');
  return {
    present: true,
    heading: (section.querySelector("h3")?.textContent ?? "").trim(),
    countText: (section.querySelector("[data-companion-world-book-count]")?.textContent ?? "").trim() || null,
    emptyText: (section.querySelector("[data-companion-world-book-empty]")?.textContent ?? "").trim() || null,
    disclosureOpen: section.querySelector("[data-companion-world-book-disclosure]")?.open ?? null,
    entryCount: entries.length,
    entries,
    editorOpen: section.querySelector("[data-companion-world-book-draft]") !== null,
    editControl: edit === null ? null : { text: (edit.textContent ?? "").trim(), box: rect(edit) },
    notice: notice === null ? null : { text: (notice.textContent ?? "").trim(), role: notice.getAttribute("role") },
    section: rect(section),
  };
};

const draftFacts = () => {
  const draft = document.querySelector("[data-companion-world-book-draft]");
  if (draft === null) return { present: false };
  const rect = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const rows = [...draft.querySelectorAll("[data-companion-world-book-entry-draft]")];
  const save = draft.querySelector("[data-companion-world-book-save]");
  const add = draft.querySelector("[data-companion-world-book-add]");
  const cancel = draft.querySelector("[data-companion-world-book-cancel]");
  return {
    present: true,
    heading: (draft.querySelector("h3")?.textContent ?? "").trim(),
    rowCount: rows.length,
    rows: rows.map((row) => ({
      title: row.querySelector('input[type="text"]')?.value ?? null,
      keys: row.querySelectorAll('input[type="text"]')[1]?.value ?? null,
      body: (row.querySelector("textarea")?.value ?? "").slice(0, 60),
      bodyChars: (row.querySelector("textarea")?.value ?? "").length,
      removeControl: (row.querySelector("[data-companion-world-book-remove]")?.textContent ?? "").trim() || null,
      armed: row.querySelector("[data-companion-world-book-remove-confirm]") !== null,
    })),
    save: { text: (save?.textContent ?? "").trim(), disabled: save?.disabled ?? null, box: rect(save) },
    add: { text: (add?.textContent ?? "").trim(), box: rect(add) },
    cancel: { text: (cancel?.textContent ?? "").trim(), box: rect(cancel) },
    notice: (document.querySelector('[data-companion-world-book-notice]')?.textContent ?? "").trim() || null,
  };
};

const removeArmedFacts = () => {
  const block = document.querySelector("[data-companion-world-book-remove-confirm]");
  if (block === null) return { present: false };
  const rect = (node) => {
    if (node === null) return null;
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const yes = block.querySelector("[data-companion-world-book-remove-yes]");
  const no = block.querySelector("[data-companion-world-book-remove-no]");
  return {
    present: true,
    prompt: (block.querySelector("[data-companion-world-book-remove-prompt]")?.textContent ?? "").trim(),
    box: rect(block),
    yes: { text: (yes?.textContent ?? "").trim(), box: rect(yes) },
    no: { text: (no?.textContent ?? "").trim(), box: rect(no) },
    controlsInThatRowWhileArmed: block.parentElement?.querySelectorAll("button").length ?? null,
  };
};

const currentCompanionHandle = async () => await fetch("/api/tavern/v1/companions").then(async (response) => {
  const body = await response.json();
  return body.companions.find((entry) => entry.isCurrent)?.handle ?? null;
});

const durableBook = async (handle) => {
  const response = await fetch(`/api/tavern/v1/companions/${handle}/worldbook`);
  if (!response.ok) return { ok: false, status: response.status };
  const body = await response.json();
  return {
    ok: true,
    revision: body.revision,
    entries: (body.entries ?? []).map((entry) => ({
      title: entry.title,
      keys: entry.keys,
      constant: entry.constant,
      content: entry.content,
      chars: (entry.content ?? "").length,
      head: (entry.content ?? "").slice(0, 40),
    })),
  };
};

const stimulusWrite = async ({ handle, token, expectedRevision, entries }) => {
  const response = await fetch(`/api/tavern/v1/companions/${handle}/worldbook`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-csrf-token": token },
    body: JSON.stringify({ apiVersion: 1, expectedRevision, entries }),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, revision: body?.revision ?? null, code: body?.code ?? null };
};

(async () => {
  const { browser, page } = await connect();
  const { say, flush } = reporter("q-companion-world-book.txt");

  // The page's own session token, learned from the requests the surface itself sends: nothing is
  // read from a file, a config or an environment variable, and the value is never printed.
  const observed = { token: null, lastStatus: null, lastRevision: null };
  page.on("request", (request) => {
    const token = request.headers()["x-csrf-token"];
    if (typeof token === "string" && token.length > 0) observed.token = token;
  });
  page.on("response", async (response) => {
    if (!response.url().includes("/worldbook")) return;
    observed.lastStatus = response.status();
    try {
      observed.lastRevision = (await response.json())?.revision ?? null;
    } catch {
      observed.lastRevision = null;
    }
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(`${PAGE_HELPERS};undefined`);
  await activateSurface(page, "角色");
  await page.waitForTimeout(2200);

  const handle = await page.evaluate(currentCompanionHandle);
  say(`the companion in play: handle present=${handle !== null}`);
  say("=== ITEM: her own world book, as the surface reads it ===");
  await page.evaluate(() => {
    const disclosure = document.querySelector("[data-companion-world-book-disclosure]");
    if (disclosure !== null && !disclosure.open) disclosure.querySelector("summary")?.click();
    for (const entry of document.querySelectorAll("[data-companion-world-book-entry-text]")) entry.open = true;
  });
  await page.waitForTimeout(700);
  const before = await page.evaluate(bookFacts);
  say(JSON.stringify(before, null, 1));
  const durableBefore = await page.evaluate(durableBook, handle);
  say(`durable book: revision=${durableBefore.revision} entries=${durableBefore.entries.length} -> ${JSON.stringify(durableBefore.entries.map((entry) => ({ title: entry.title, keys: entry.keys, constant: entry.constant })))}`);
  await shot(page, "88-companion-world-book-1440x900.png");

  // ---- change one entry's body and its trigger words ----
  say("=== ITEM: a body and a trigger word changed ===");
  await page.locator("[data-companion-world-book-edit]").first().click();
  await page.waitForTimeout(1000);
  const draftOpen = await page.evaluate(draftFacts);
  say(JSON.stringify(draftOpen, null, 1));
  const target = 1;
  const originalBody = draftOpen.rows[target]?.body ?? "";
  const originalKeys = draftOpen.rows[target]?.keys ?? "";
  const newKeys = "雨天, 雨声";
  const newBody = `${originalBody}（这一句是玩家改的。）`;
  await page.locator(`#companion-world-book-entry-${target}-keys`).fill(newKeys);
  await page.locator(`#companion-world-book-entry-${target}-body`).fill(newBody);
  await page.waitForTimeout(500);
  const edited = await page.evaluate(draftFacts);
  say(`row ${target}: keys ${JSON.stringify(originalKeys)} -> ${JSON.stringify(edited.rows[target]?.keys)}; body chars ${originalBody.length} -> ${edited.rows[target]?.bodyChars}`);
  say(`save offered: disabled=${edited.save.disabled}`);
  await shot(page, "88-world-book-editor-open-1440x900.png");
  await page.locator("[data-companion-world-book-save]").first().click();
  await page.waitForTimeout(2600);
  const afterEdit = await page.evaluate(bookFacts);
  const durableAfterEdit = await page.evaluate(durableBook, handle);
  const editedEntry = durableAfterEdit.entries[target] ?? null;
  say(`notice: ${JSON.stringify(afterEdit.notice?.text ?? null)}`);
  say(`durable revision ${durableBefore.revision} -> ${durableAfterEdit.revision}`);
  say(`durable entry ${target}: keys=${JSON.stringify(editedEntry?.keys)} constant=${editedEntry?.constant} chars=${editedEntry?.chars}`);
  say(`the body kept the rewritten sentence: ${(editedEntry?.head ?? "").includes("这一句是玩家改的")}`);
  say(`the entry as the surface now renders it: ${JSON.stringify(afterEdit.entries[target])}`);
  await shot(page, "88-world-book-edited-1440x900.png");

  // ---- add an entry ----
  say("=== ITEM: an entry added ===");
  await page.locator("[data-companion-world-book-edit]").first().click();
  await page.waitForTimeout(1000);
  await page.locator("[data-companion-world-book-add]").first().click();
  await page.waitForTimeout(600);
  const addedIndex = (await page.evaluate(draftFacts)).rowCount - 1;
  await page.locator(`#companion-world-book-entry-${addedIndex}-title`).fill("演示条目");
  await page.locator(`#companion-world-book-entry-${addedIndex}-keys`).fill("演示, 测试");
  await page.locator(`#companion-world-book-entry-${addedIndex}-body`).fill("这条是这一轮加上去的。");
  await page.waitForTimeout(500);
  const draftWithNew = await page.evaluate(draftFacts);
  say(`draft rows ${draftOpen.rowCount} -> ${draftWithNew.rowCount}; the added row reads ${JSON.stringify(draftWithNew.rows[addedIndex])}`);
  await page.locator("[data-companion-world-book-save]").first().click();
  await page.waitForTimeout(2600);
  const afterAdd = await page.evaluate(bookFacts);
  const durableAfterAdd = await page.evaluate(durableBook, handle);
  say(`notice: ${JSON.stringify(afterAdd.notice?.text ?? null)}`);
  say(`the surface's own count line: ${JSON.stringify(afterAdd.countText)}`);
  say(`durable entries ${durableAfterEdit.entries.length} -> ${durableAfterAdd.entries.length}; revision ${durableAfterAdd.revision}`);
  say(`durable titles: ${JSON.stringify(durableAfterAdd.entries.map((entry) => entry.title))}`);
  await shot(page, "88-world-book-entry-added-1440x900.png");

  // ---- remove one through the arm-then-confirm ----
  say("=== ITEM: an entry removed through the arm-then-confirm ===");
  await page.locator("[data-companion-world-book-edit]").first().click();
  await page.waitForTimeout(1000);
  const draftRows = await page.evaluate(draftFacts);
  const removeIndex = draftRows.rowCount - 1;
  const removeRow = page.locator("[data-companion-world-book-entry-draft]").nth(removeIndex);
  await removeRow.locator("[data-companion-world-book-remove]").click();
  await page.waitForTimeout(700);
  const armed = await page.evaluate(removeArmedFacts);
  say(JSON.stringify(armed, null, 1));
  await shot(page, "88-world-book-remove-armed-1440x900.png");
  await removeRow.locator("[data-companion-world-book-remove-no]").click();
  await page.waitForTimeout(600);
  const disarmed = await page.evaluate(removeArmedFacts);
  const afterDisarm = await page.evaluate(draftFacts);
  say(`cancelling the arm: confirm gone=${disarmed.present === false}; draft rows still ${afterDisarm.rowCount}`);
  await removeRow.locator("[data-companion-world-book-remove]").click();
  await page.waitForTimeout(600);
  await removeRow.locator("[data-companion-world-book-remove-yes]").click();
  await page.waitForTimeout(700);
  const afterLocalRemove = await page.evaluate(draftFacts);
  say(`the row left the draft locally (nothing saved yet): rows ${draftRows.rowCount} -> ${afterLocalRemove.rowCount}`);
  await page.locator("[data-companion-world-book-save]").first().click();
  await page.waitForTimeout(2600);
  const afterRemove = await page.evaluate(bookFacts);
  const durableAfterRemove = await page.evaluate(durableBook, handle);
  say(`notice: ${JSON.stringify(afterRemove.notice?.text ?? null)}`);
  say(`the surface's own count line: ${JSON.stringify(afterRemove.countText)}`);
  say(`durable entries ${durableAfterAdd.entries.length} -> ${durableAfterRemove.entries.length}; revision ${durableAfterRemove.revision}`);
  say(`durable titles: ${JSON.stringify(durableAfterRemove.entries.map((entry) => entry.title))}`);
  say(`the removed entry's title is gone from the Host's own rows: ${durableAfterRemove.entries.every((entry) => entry.title !== "演示条目")}`);
  await shot(page, "88-world-book-entry-removed-1440x900.png");
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(1200);
  await shot(page, "88-world-book-400x800.png");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(900);

  // ---- the refusal: a revision that moved while the editor was open ----
  say("=== ITEM: the refusal — the book changed after the editor was opened ===");
  if (observed.token === null || observed.lastRevision === null) {
    say("SKIPPED:no_page_owned_write_was_observed_so_a_stale_revision_could_not_be_produced");
  } else {
    await page.locator("[data-companion-world-book-edit]").first().click();
    await page.waitForTimeout(1200);
    const openDraft = await page.evaluate(draftFacts);
    await page.locator("#companion-world-book-entry-0-body").fill(`${openDraft.rows[0]?.body ?? ""}（编辑器开着时写的。）`);
    await page.waitForTimeout(400);
    const beforeStimulus = await page.evaluate(durableBook, handle);
    const entriesForStimulus = beforeStimulus.entries.map((entry, index) => ({
      title: entry.title,
      keys: entry.keys,
      constant: entry.constant,
      content: index === 0 ? `${entry.content}另一个窗口改了这段。` : entry.content,
    }));
    const stimulus = await page.evaluate(stimulusWrite, {
      handle,
      token: observed.token,
      expectedRevision: beforeStimulus.revision,
      entries: entriesForStimulus,
    });
    say(`the second writer (the page's own route, its own token) answered: ${JSON.stringify(stimulus)}`);
    const durableAfterStimulus = await page.evaluate(durableBook, handle);
    say(`the book on the server is now revision ${durableAfterStimulus.revision} while the open editor still pins ${beforeStimulus.revision}`);
    say(`pressing the save the editor still offers: ${JSON.stringify(await page.locator("[data-companion-world-book-save]").first().isEnabled())}`);
    await page.locator("[data-companion-world-book-save]").first().click();
    await page.waitForTimeout(3000);
    const refused = await page.evaluate(bookFacts);
    say(`the observed HTTP status of the refused save: ${observed.lastStatus}`);
    say(`the sentence the surface shows: ${JSON.stringify(refused.notice?.text ?? null)}`);
    say(`the editor is STILL open on its own revision (nothing silently rebased): ${refused.editorOpen}`);
    await shot(page, "88-world-book-refusal-stale-revision-1440x900.png");
    // The same editor, reopened on the book that is there now, saves the same change: the refusal
    // was about the revision and nothing else.
    await page.locator("[data-companion-world-book-cancel]").first().click();
    await page.waitForTimeout(800);
    await page.locator("[data-companion-world-book-edit]").first().click();
    await page.waitForTimeout(1200);
    await page.locator("#companion-world-book-entry-0-body").fill("重开之后写下的这一段。");
    await page.waitForTimeout(400);
    await page.locator("[data-companion-world-book-save]").first().click();
    await page.waitForTimeout(2600);
    const recovered = await page.evaluate(bookFacts);
    say(`reopened and saved: notice ${JSON.stringify(recovered.notice?.text ?? null)}; editor open=${recovered.editorOpen}`);
    say(`the recovered save's status: ${observed.lastStatus}; entry 0 body now reads ${JSON.stringify(recovered.entries[0]?.body)}`);
  }

  flush();
  await browser.close().catch(() => undefined);
  say("DONE-Q");
})().catch((error) => {
  console.log("DRIVER Q FAILED:", String(error).slice(0, 900));
  process.exit(1);
});
