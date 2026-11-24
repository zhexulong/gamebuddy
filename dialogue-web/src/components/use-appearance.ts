import { useCallback, useEffect, useState } from "react";
import {
  type AppearanceChoice,
  applyAppearance,
  resolveAppearance,
  systemPrefersLight,
  watchSystemAppearance,
} from "../appearance";

/**
 * The appearance the shell paints itself in, and the choice it paints from.
 *
 * The Host's preference record is the authority for the CHOICE - it survives a reload and a relaunch,
 * which the browser's own storage does not (the Desktop serves this shell from an ephemeral loopback
 * origin, so every launch is a fresh origin and a fresh store). That choice arrives with the mount's
 * platform member, beside the session and the interface language, because it belongs to the page rather
 * than to one panel or to one surface: reading it when the Settings panel opened would paint the wrong
 * appearance for as long as nobody opened it.
 *
 * `hostChoice` is therefore an INPUT, not something this hook fetches: `null` while the mount is still
 * loading (the OS answer stands in for those first frames), and the record's own choice from the moment
 * the root is here. A panel that writes a new choice hands the confirmed value back through `choose`, so
 * the page repaints in what the store ANSWERED with rather than in what the select just showed.
 */
export function useAppearance(hostChoice: AppearanceChoice | null): Readonly<{
  choice: AppearanceChoice;
  choose: (choice: AppearanceChoice) => void;
}> {
  const [choice, setChoice] = useState<AppearanceChoice>(hostChoice ?? "system");

  useEffect(() => {
    if (hostChoice !== null) setChoice(hostChoice);
  }, [hostChoice]);

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
