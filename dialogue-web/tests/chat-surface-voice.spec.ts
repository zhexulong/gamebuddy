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
  voicePulse(): { animationName: string; animationDuration: string; transform: string } | null;
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

/**
 * The mic's recording-state question, answered honestly.
 *
 * The brief asked for a "recording in progress" pulse. This wire has no
 * recording reading to key one to: the Host's own union is closed to
 * `unavailable | ready | speaking`, and its one producer only ever emits `ready`
 * or `speaking`. So the pulse is keyed to `speaking` - the single active-audio
 * state the Host actually reports - and the missing recording state is reported
 * to the owner as a Host gap rather than invented in the browser.
 *
 * The failure this catches: a halo driven by the browser's own MediaRecorder or
 * by a client-side "recording" flag, which would show a player a state the Host
 * never confirmed; and an animation that ignores `prefers-reduced-motion`, which
 * leaves a strobe running for a player who asked for no motion.
 */
test("the mic halo is keyed to the Host's speaking state alone and stops under reduced motion", async ({ page }) => {
  await openProbe(page);

  // A state the Host does report but which is not active audio carries no halo:
  // `ready` means the microphone is available, not that anything is running.
  await page.evaluate(() => window.chatProbe.setVoice({ state: "ready" }));
  await expect(page.locator("[data-voice-state]")).toHaveAttribute("data-voice-state", "ready");
  expect(await page.locator("[data-voice-pulse]").count()).toBe(0);
  expect(await page.evaluate(() => window.chatProbe.voicePulse())).toBeNull();

  await page.evaluate(() => window.chatProbe.setVoice({ state: "unavailable" }));
  expect(await page.locator("[data-voice-pulse]").count()).toBe(0);

  // The Host's one active-audio reading is the halo's only trigger, and the
  // motion is a real computed animation rather than a class name.
  await page.evaluate(() => window.chatProbe.setVoice({ state: "speaking" }));
  await expect(page.locator("[data-voice-state]")).toHaveAttribute("data-voice-state", "speaking");
  await expect(page.locator("[data-voice-pulse]")).toHaveCount(1);
  const pulse = await page.evaluate(() => window.chatProbe.voicePulse());
  expect(pulse?.animationName).toBe("voice-pulse-ring");
  expect(pulse?.animationDuration).toBe("1.6s");
  expect(pulse?.transform).not.toBe("none");

  // prefers-reduced-motion removes the motion entirely; the state and its label
  // are not the motion, so they stay.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await page.evaluate(() => window.chatProbe.voicePulse());
  expect(reduced?.animationName).toBe("none");
  await expect(page.locator("[data-voice-pulse]")).toHaveCount(1);
  expect(await page.evaluate(() => window.chatProbe.voiceLabel())).toBe(messages("en").voiceSpeaking);
});
