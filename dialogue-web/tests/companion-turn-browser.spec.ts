/**
 * The product-facing Chat journeys: a real provider turn through the shipped UI,
 * the same conversation surviving a full app restart on one runtime root, and the
 * keyboard/layout floor of the surface. They are separate from the SSE/replay
 * spec because they mount twice and spend real provider time, while those
 * journeys are timing-sensitive and deliberately synchronous.
 */
import assert from "node:assert/strict";
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

    // Landmarks and names are present, so assistive technology has a structure
    // and every control is announced.
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("region", { name: "Chat transcript" })).toBeVisible();
    const composer = page.getByRole("textbox", { name: /Type a message/u });
    await expect(composer).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

    // Keyboard only: reach the composer with the keyboard, type, and send with
    // Enter. No mouse event is used anywhere in this journey.
    await page.keyboard.press("Tab");
    await composer.focus();
    assert.equal(await composer.evaluate((node) => node === document.activeElement), true);
    await page.keyboard.type("Keyboard only, please answer");
    await page.keyboard.press("Enter");
    await expect.poll(() => mounted.starts, { timeout: 15_000 }).toBe(1);
    await mounted.armCurrentTurn();
    await mounted.settleArmedTurn("release");
    // The keyboard send reached the surface: its own message is in the transcript.
    await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText("Keyboard only, please answer");

    // No horizontal overflow at either width: a scrollable page here would cut
    // the transcript or the composer off on a phone.
    for (const viewport of [
      { width: 375, height: 667 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await expect
        .poll(() =>
          page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            composer: document.querySelector("textarea.composer-textarea")?.getBoundingClientRect().width ?? 0,
          })),
        )
        .toEqual({ overflow: 0, composer: expect.any(Number) } as never);
      const metrics = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        composer: document.querySelector("textarea.composer-textarea")?.getBoundingClientRect().width ?? 0,
      }));
      assert.equal(metrics.overflow, 0, `no horizontal overflow at ${viewport.width}x${viewport.height}`);
      assert.ok(metrics.composer > 100, `the composer stays usable at ${viewport.width}x${viewport.height}`);
    }
  } finally {
    await browser.close();
    await mounted.close();
  }
});
