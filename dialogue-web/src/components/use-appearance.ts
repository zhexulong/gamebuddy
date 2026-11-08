import { useCallback, useEffect, useState } from "react";
import {
  type AppearanceChoice,
  applyAppearance,
  resolveAppearance,
  systemPrefersLight,
  watchSystemAppearance,
} from "../appearance";
import type { ManagementPipelineApi } from "../management-pipeline-api";

/**
 * The appearance the shell paints itself in, and the choice it paints from.
 *
 * The Host's preference record is the authority for the CHOICE - it survives a reload and a relaunch,
 * which the browser's own storage does not (the Desktop serves this shell from an ephemeral loopback
 * origin, so every launch is a fresh origin and a fresh store). The choice is read once at mount,
 * beside the display locale, because the appearance belongs to the page rather than to one panel:
 * reading it when the Settings panel opened would paint the wrong appearance for as long as nobody
 * opened it.
 *
 * An unreadable preference leaves `system` in force instead of failing the surface. That is not a
 * silent fallback: `system` is a real choice, the record still holds whatever the player chose, and a
 * cosmetic read that the Host refuses must never stop the conversation.
 */
export function useAppearance(api: ManagementPipelineApi): Readonly<{
  choice: AppearanceChoice;
  choose: (choice: AppearanceChoice) => void;
}> {
  const [choice, setChoice] = useState<AppearanceChoice>("system");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const record = await api.readAppearancePreference();
        if (active) setChoice(record.appearance);
      } catch {
        // The OS answer stands in until the Host can answer; the stored choice is untouched.
      }
    })();
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    const paint = (): void => {
      applyAppearance(resolveAppearance(choice, systemPrefersLight(window)), document);
    };
    paint();
    // Only a `system` choice follows the OS; a fixed appearance stops watching, so a change of the
    // OS answer cannot override a choice the player made on purpose.
    return choice === "system" ? watchSystemAppearance(window, paint) : undefined;
  }, [choice]);

  const choose = useCallback((next: AppearanceChoice): void => setChoice(next), []);
  return { choice, choose };
}
