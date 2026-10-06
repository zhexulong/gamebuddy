/**
 * The product-facing Chat journeys: a real provider turn through the shipped UI,
 * the same conversation surviving a full app restart on one runtime root, and the
 * keyboard/layout floor of the surface. They are separate from the SSE/replay
 * spec because they mount twice and spend real provider time, while those
 * journeys are timing-sensitive and deliberately synchronous.
 */
import assert from "node:assert/strict";
import {
  assertAccessibilityBaseline,
  assertCriteriaCoverage,
  assertKeyboardReachable,
  assertLayoutFloor,
  assertQuiet,
  resetCriteriaLedger,
  watchSurface,
} from "./frontend-criteria.js";

/** The obligations the contract declares for the Chat surface. */
const CHAT_CRITERIA_OBLIGATIONS = [
  "frontend-accessibility-baseline",
  "frontend-keyboard-reach",
  "frontend-layout-floor",
  "frontend-quiet-walk",
] as const;
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, expect, test } from "@playwright/test";
import { startMountedReferenceComposition } from "./mounted-reference-composition.ts";
/**
 * The one journey that runs a REAL provider turn through the shipped UI: the
 * composition is mounted with no start override, so the message the player types
 * travels the production path to the provider and the companion's answer streams
 * back into the surface. Every other journey in this file injects a synthetic
 * prompt gate and deliberately stops before terminalization, which is why this
 * one is separate - and why it skips (loudly, with a reason) rather than faking an
 * answer when the environment has no provider credential.
 */
test("reference browser sends a message to the real provider and keeps the answer across a reload", async () => {
  test.skip(process.platform !== "win32", "requires real Windows production coordinator mount");
  test.skip(
    process.env.CPA_OAI_API_KEY === undefined || process.env.CPA_OAI_API_KEY.length === 0,
    "requires the CPA_OAI_API_KEY provider credential; this journey claims a real turn, so it never substitutes one",
  );
  test.setTimeout(180_000);
  const mounted = await startMountedReferenceComposition(64, { realProvider: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    const submitted: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/tavern/v1/messages") submitted.push(`${request.method()} ${path}`);
    });

    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded" });
    const composer = page.locator("textarea.composer-textarea");
    const prompt = "In one short sentence: what is your favourite thing about the valley?";
    await composer.fill(prompt);
    await page.getByRole("button", { name: /send/i }).click();
    // The turn reached the surface as a real submission, on the production path.
    await expect.poll(() => submitted.length, { timeout: 15_000 }).toBe(1);
    assert.equal(submitted[0], "POST /api/tavern/v1/messages");

    // The transcript renders the player's own words first (durable-before-
    // provider), then the companion's answer arrives from the real provider.
    const transcript = page.getByRole("region", { name: "Chat transcript" });
    await expect(transcript).toContainText(prompt, { timeout: 15_000 });
    const entries = transcript.getByRole("listitem");
    await expect.poll(() => entries.count(), { timeout: 120_000 }).toBe(2);

    // The companion's own words: the entry also carries the speaker label and the
    // regenerate control, so take the message line itself.
    const answerBlock = (await entries.nth(1).innerText()).replace(/🔄[\s\S]*$/u, "").trim();
    // The entry carries the speaker label, possibly an action segment in
    // asterisks, and the spoken text. Take the longest run of real text so the
    // assertion tracks the companion's words rather than the markup around them
    // (presentation dehydrates action segments, so those are not stable).
    const spoken = (answerBlock.replace(/\*[^*]*\*/gu, " ").match(/[\u4e00-\u9fff\u3040-\u30ffA-Za-z][\u4e00-\u9fff\u3040-\u30ffA-Za-z0-9'’,.!?\u3001\u3002\uff0c\uff01\uff1f\u2014\u2026 -]{7,}/gu) ?? []).sort(
      (a, b) => b.length - a.length,
    )[0] ?? "";
    const message = spoken.trim();
    assert.ok(
      message.length >= 8,
      `the companion answered with its own text: ${JSON.stringify(answerBlock)}`,
    );
    assert.ok(!message.includes(prompt), "the answer is not an echo of the prompt");
    assert.ok(
      !/provider|unavailable|failed|error|重试/i.test(message),
      `the answer is companion text, not a failure notice: ${message}`,
    );

    // Durable, not a stream artifact: both messages survive a reload.
    await page.reload({ waitUntil: "domcontentloaded" });
    const reloaded = page.getByRole("region", { name: "Chat transcript" });
    await expect(reloaded.getByRole("listitem")).toHaveCount(2, { timeout: 15_000 });
    await expect(reloaded).toContainText(prompt);
    await expect(reloaded).toContainText(message.slice(0, 8));  } finally {
    await browser.close();
    await mounted.close();
  }
});

/**
 * Restart / reopen: the surface is torn down completely (listener, lease,
 * facade) and mounted again over the SAME runtime root, which is what an app
 * restart is for durable state. The conversation must come back from the store,
 * not from anything the first mount kept in memory - so this journey never
 * reuses a process, only the root.
 */
test("reference browser keeps the conversation across an app restart on the same root", async () => {
  test.skip(process.platform !== "win32", "requires real Windows production coordinator mount");
  test.skip(
    process.env.CPA_OAI_API_KEY === undefined || process.env.CPA_OAI_API_KEY.length === 0,
    "requires the CPA_OAI_API_KEY provider credential; the restart claim is about a REAL committed turn",
  );
  test.setTimeout(240_000);
  const root = resolve(tmpdir(), `gamebuddy-reference-restart-${process.pid}-${Date.now()}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const prompt = "In one short sentence: what do you like about rainy days?";
  let answer = "";
  const first = await startMountedReferenceComposition(64, { realProvider: true, root });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    await page.goto(first.server.launchUrl, { waitUntil: "domcontentloaded" });
    await page.locator("textarea.composer-textarea").fill(prompt);
    await page.getByRole("button", { name: /send/i }).click();
    const transcript = page.getByRole("region", { name: "Chat transcript" });
    const entries = transcript.getByRole("listitem");
    await expect.poll(() => entries.count(), { timeout: 150_000 }).toBe(2);
    const block = (await entries.nth(1).innerText()).replace(/🔄[\s\S]*$/u, "").trim();
    answer =
      (block.replace(/\*[^*]*\*/gu, " ").match(/[\u4e00-\u9fff][\u4e00-\u9fff\u3001\u3002\uff0c\uff01\uff1f\u2014\u2026]{7,}/gu) ?? []).sort(
        (a, b) => b.length - a.length,
      )[0] ?? "";
    assert.ok(answer.length >= 8, `the companion answered: ${JSON.stringify(block)}`);
  } finally {
    await browser.close();
    // Full teardown of the first app instance: listener, management services,
    // lease, facade. Nothing survives except the runtime root on disk.
    await first.close({ keepRoot: true });
  }

  // A fresh mount on the same root, with a fresh browser: the conversation is
  // read back from the store.
  const second = await startMountedReferenceComposition(64, { realProvider: true, root, reopen: true });
  const reopened = await chromium.launch({ headless: true });
  try {
    const page = await reopened.newPage({ locale: "en-US" });
    await page.goto(second.server.launchUrl, { waitUntil: "domcontentloaded" });
    const transcript = page.getByRole("region", { name: "Chat transcript" });
    await expect(transcript.getByRole("listitem")).toHaveCount(2, { timeout: 20_000 });
    await expect(transcript).toContainText(prompt);
    await expect(transcript).toContainText(answer.slice(0, 8));
  } finally {
    await reopened.close();
    await second.close();
  }
});

/**
 * Keyboard-only and layout floor: the Chat surface is operable without a mouse,
 * its landmarks and controls carry their own names, and the layout does not
 * overflow horizontally at a phone or a desktop width. The turn is the synthetic
 * gate here (the claim is operability, not the provider), so this journey needs
 * no credential.
 */
test("reference browser is keyboard operable and does not overflow at phone or desktop width", async () => {
  test.skip(process.platform !== "win32", "requires real Windows production coordinator mount");
  test.setTimeout(120_000);
  const mounted = await startMountedReferenceComposition();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 1280, height: 800 } });
    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded" });

    // Structure and names: the named controls a player uses are announced, and
    // the two landmarks exist. The landmarks themselves carry no accessible name
    // (the app bar and main are bare), which is recorded as open rather than
    // claimed here.
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    const transcript = page.getByRole("region", { name: "Chat transcript" });
    await expect(transcript).toBeVisible();
    const composer = page.getByRole("textbox", { name: /Type a message/u });
    await expect(composer).toBeVisible();
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toBeVisible();

    // Keyboard alone, starting from the document: Tab until the composer takes
    // focus - no programmatic focus(), no mouse event anywhere in this journey.
    let reachedByTab = false;
    for (let press = 0; press < 24 && !reachedByTab; press += 1) {
      await page.keyboard.press("Tab");
      reachedByTab = await composer.evaluate((node) => node === document.activeElement);
    }
    assert.equal(reachedByTab, true, "the composer is reachable with Tab alone");

    // Typing enables the naming control (an empty draft leaves it disabled, so
    // its visibility alone would prove nothing).
    await page.keyboard.type("Keyboard only, please answer");
    await expect(send).toBeEnabled({ timeout: 10_000 });
    await page.keyboard.press("Enter");
    await expect.poll(() => mounted.starts, { timeout: 15_000 }).toBe(1);
    await mounted.armCurrentTurn();
    await mounted.settleArmedTurn("release");
    await expect(transcript).toContainText("Keyboard only, please answer");

    // Layout at both widths. The document must not scroll horizontally, AND the
    // transcript must not clip its own content: the app hides overflow on its
    // containers, so a document-level measurement alone would report 0 while
    // text was being cut off inside.
    for (const viewport of [
      { width: 375, height: 667 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      const metrics = await page.evaluate(() => {
        const transcriptNode = document.querySelector("section[aria-label=\"Chat transcript\"], [role=\"region\"]");
        const composerNode = document.querySelector("textarea.composer-textarea");
        const rect = composerNode?.getBoundingClientRect();
        return {
          documentOverflow:
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
          transcriptClipped:
            transcriptNode === null
              ? null
              : transcriptNode.scrollWidth - transcriptNode.clientWidth,
          composerWidth: rect?.width ?? 0,
          composerLeft: rect?.left ?? Number.NaN,
          composerRight: rect?.right ?? Number.NaN,
          viewportWidth: window.innerWidth,
        };
      });
      const at = `${viewport.width}x${viewport.height}`;
      assert.equal(metrics.documentOverflow, 0, `the document does not scroll horizontally at ${at}`);
      assert.ok(
        metrics.composerWidth > 100,
        `the composer keeps a usable width at ${at} (${metrics.composerWidth})`,
      );
      assert.ok(
        metrics.composerLeft >= -1 && metrics.composerRight <= metrics.viewportWidth + 1,
        `the composer stays inside the viewport at ${at} (${metrics.composerLeft}..${metrics.composerRight} of ${metrics.viewportWidth})`,
      );
      assert.ok(
        metrics.transcriptClipped !== null && metrics.transcriptClipped <= 1,
        `the transcript clips no content at ${at} (${String(metrics.transcriptClipped)})`,
      );
      // Visibility is re-asserted at this width: a control can be laid out and
      // still be hidden, and this loop changes the viewport it was checked at.
      // The composer is disabled while this journey's synthetic turn is still
      // held open, which is why the enabled-send claim is made above, before
      // the turn starts, rather than here.
      await expect(composer).toBeVisible();
      await expect(transcript).toBeVisible();
    }
  } finally {
    await browser.close();
    await mounted.close();
  }
});

test("conformance: chat surface meets the frontend criteria", async () => {
  test.skip(process.platform !== "win32", "requires real Windows production coordinator mount");
  test.setTimeout(120_000);
  const mounted = await startMountedReferenceComposition();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
  });
  try {
    const page = await context.newPage();
    const noise = watchSurface(page);
    await page.goto(mounted.server.launchUrl, { waitUntil: "domcontentloaded" });
    const composer = page.getByRole("textbox", { name: /Type a message/u });
    await expect(composer).toBeVisible({ timeout: 15_000 });

    // Keyboard reach is measured from the document as loaded: no programmatic
    // focus, no pointer event, and before anything has been typed into the
    // composer (typing would leave focus there and Tab would walk away from it).
    resetCriteriaLedger();
    await assertKeyboardReachable(page, composer, "the chat composer");

    // Real content first: an empty transcript never overflows, so a scrollable
    // region that cannot take focus (axe: scrollable-region-focusable) and a
    // clipped column would both go unnoticed. One committed message makes the
    // surface the shape the criteria are about.
    await composer.fill("A message that gives the transcript real content");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => mounted.starts, { timeout: 15_000 }).toBe(1);
    await mounted.armCurrentTurn();
    await mounted.settleArmedTurn("release");
    await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText(
      "A message that gives the transcript real content",
    );

    // The criteria, in the order the document lists them. A future Chat screen
    // that forgets one of these fails here even if no journey covers it.
    await assertAccessibilityBaseline(page, "chat");
    await assertLayoutFloor(page);
    assertQuiet(noise, "chat");
    // And the surface was judged by every criterion it declares: dropping one of
    // the calls above stops being invisible here.
    assertCriteriaCoverage("chat", CHAT_CRITERIA_OBLIGATIONS);
  } finally {
    await context.close();
    await browser.close();
    await mounted.close();
  }
});
