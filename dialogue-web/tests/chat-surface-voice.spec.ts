import { expect, test, type Page } from "@playwright/test";
import { messages } from "../src/i18n";

/**
 * The voice surface is a projection of the Host's own narrow union
 * (`unavailable | ready | speaking`, `tavern_browser_api/v1`). There is no
 * recording/capturing/consent state on this wire - consent and device choice
 * live on the separate management voice-preference route - so the client cannot
 * and must not invent one.
 *
 * The failure this catches: the projection was only a coloured dot whose
 * meaning lived in a `title`, so a sighted player who does not hover could not
 * tell "ready" from "unavailable" at a glance and had no readable state at all.
 */
type ChatProbe = {
  setVoice(state: { state: "unavailable" | "ready" | "speaking" } | null): void;
  voiceState(): string | null;
  voiceLabel(): string | null;
};

declare global {
  interface Window {
    chatProbe: ChatProbe;
  }
}

async function openProbe(page: Page): Promise<void> {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
}

test("every voice state the Host publishes reaches the player as a readable label", async ({ page }) => {
  await openProbe(page);
  const labels = messages("en");
  const expected = [
    ["unavailable", labels.voiceUnavailable],
    ["ready", labels.voiceReady],
    ["speaking", labels.voiceSpeaking],
  ] as const;

  for (const [state, label] of expected) {
    await page.evaluate((value) => window.chatProbe.setVoice({ state: value }), state);
    await expect(page.locator("[data-voice-state]")).toHaveAttribute("data-voice-state", state);
    const visible = await page.evaluate(() => window.chatProbe.voiceLabel());
    expect(visible).toBe(label);
    expect(visible).not.toBe(state);
    await expect(page.locator(".voice-status-label")).toBeVisible();
  }

  // No surface is projected when the snapshot carries no voice field at all.
  await page.evaluate(() => window.chatProbe.setVoice(null));
  await expect(page.locator("[data-voice-state]")).toHaveCount(0);
});
