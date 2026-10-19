import { useEffect, useRef, useState } from "react";

/**
 * The single contextual panel this profile can open (design/26 §4.2). The open
 * panel is part of the URL, so a refresh restores it and Browser Back closes it
 * before it leaves the chat (design/26 §7.2, design/104 §2).
 */
export const PANEL_PARAM = "panel";
export const CHAT_PANEL = "chat" as const;
export const GAME_PANEL = "game" as const;
export const CHATS_PANEL = "chats" as const;
export const CHARACTERS_PANEL = "characters" as const;
export const SETTINGS_PANEL = "settings" as const;
export const MEMORY_PANEL = "memory" as const;

/** The panel the URL currently names, or null for the conversation itself. */
function readPanelFromUrl(): string | null {
  return new URLSearchParams(window.location.hash.slice(1)).get(PANEL_PARAM);
}

/**
 * The selected surface is a URL history entry rather than hidden state, so Back
 * moves between surfaces, Escape returns to the conversation, and a refresh comes
 * back with the same surface open (design/26 §7.2, design/104 §2). The shell owns
 * this one behaviour for every surface; the entries themselves are its surface
 * switcher.
 */
export function useSurfaceRoute(): Readonly<{
  shownSurface: string;
  openPanelOf: (panel: string, entryRef: React.RefObject<HTMLButtonElement | null>) => () => void;
}> {
  // The open contextual panel, as the URL states it. A refresh with
  // `#…&panel=game` comes back with the drawer already open.
  const [openPanel, setOpenPanel] = useState<string | null>(() => readPanelFromUrl());
  // The surface occupying the main region. Chat is the default surface, not a
  // privileged one: every surface takes the same region, and the URL names the
  // selected one so Back returns to the previous surface.
  const shownSurface = openPanel ?? CHAT_PANEL;

  // Browser Back moves between surfaces, because the selected surface is a
  // history entry rather than hidden state (design/26 §7.2). Escape returns to
  // the conversation from any other surface.
  useEffect(() => {
    const syncPanelWithHistory = (): void => setOpenPanel(readPanelFromUrl());
    window.addEventListener("popstate", syncPanelWithHistory);
    return () => window.removeEventListener("popstate", syncPanelWithHistory);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (shownSurface === CHAT_PANEL) return;
      // Stepping the history back removes the entry that selected this surface,
      // so a later refresh cannot resurrect it; a surface restored from a URL
      // this session never pushed returns to the conversation in place instead.
      if (window.history.state?.gbPanel !== undefined) {
        window.history.back();
        return;
      }
      const url = new URL(window.location.href);
      const params = new URLSearchParams(url.hash.slice(1));
      params.delete(PANEL_PARAM);
      url.hash = params.toString();
      window.history.replaceState(null, "", url.toString());
      setOpenPanel(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shownSurface]);

  // Returning to the conversation puts the player back where they type. A
  // surface's own landing place is its heading (`SurfaceView`), which is right
  // for a peer surface a keyboard user is stepping into; the conversation's
  // landing place is the composer's field, and `Composer` owns that field, so the
  // shell reaches it by the class the composer renders - the same handle the
  // mounted gates use. Only a return moves focus; the first paint does not.
  const previousSurfaceRef = useRef<string>(shownSurface);
  useEffect(() => {
    const returned = shownSurface === CHAT_PANEL && previousSurfaceRef.current !== CHAT_PANEL;
    previousSurfaceRef.current = shownSurface;
    if (returned) document.querySelector<HTMLTextAreaElement>(".composer-textarea")?.focus();
  }, [shownSurface]);

  // Selecting a surface is one history entry (design/104 §2). The entries are the
  // shell's surface switcher, so all of them share this one behaviour.
  const openPanelOf =
    (panel: string, entryRef: React.RefObject<HTMLButtonElement | null>): (() => void) =>
    (): void => {
      void entryRef;
      if (openPanel !== panel) {
        const url = new URL(window.location.href);
        const params = new URLSearchParams(url.hash.slice(1));
        params.set(PANEL_PARAM, panel);
        url.hash = params.toString();
        window.history.pushState({ gbPanel: panel }, "", url.toString());
      }
      setOpenPanel(panel);
    };

  return { shownSurface, openPanelOf };
}
