import { type RefObject, useEffect, useRef, useState } from "react";
import { type Locale, messages } from "../i18n";
import { composedProblemView as problemView } from "../composed-problem-view";
import type { ComposedReferenceGameBrowserApi } from "../composed-reference-game-browser-api";
import { CHAT_PANEL, GAME_PANEL } from "../composed-surface-route";
import type { ViewState } from "./composed-reference-game-view";

/**
 * The shell's arrival reread: the reads the shell takes when the player arrives at a surface.
 *
 * The conversation the shell has committed has to be re-read when the player comes back to it.
 * Every fact the conversation renders - the transcript, the mic control, the voice state the Host
 * projects - is the composed root's Chat half, and the Host can move it while another surface is
 * open. Granting the cloud-TTS consent in Settings is the case that reported it: coming back kept
 * the pre-consent `unavailable` mic, because nothing re-read the root and the stale projection
 * stood until a reload.
 *
 * The read is `rereadChat`, the mount's own authoritative path (the composed root plus the draft
 * that must still reconcile with it), taken once per arrival. The ref is what keeps the first
 * paint from paying for a second read: mount already read, so only a *change* of surface is an
 * arrival. The other surfaces read their own projections when they mount, so this one belongs to
 * the surface that renders the shell's committed projection; it is a read on an event, never a
 * timer. A read that fails commits the shell's problem view, so a conversation that cannot be
 * re-read says so instead of keeping the projection it had.
 *
 * The Game surface needs the same read, and it is taken here rather than in `GameSurface` because
 * the composed root is the shell's own projection: every fact the panel renders - the connection,
 * the instance, the world and save, the last result - is that root's Game half, and the Host moves
 * it while another surface is open (a resume converging, a farm loading, a world ending). Measured
 * 2026-10-31 before this read existed: the panel read `Connection No game connection / Last result
 * No activity yet` and, after the Host had moved to an attached session while the player was on
 * the conversation, still read exactly that on the way back - the whole journey paid one `/state`
 * read, none of them on arrival.
 *
 * It is deliberately NOT `GameSurface`'s own `rereadGame`: that is the authoritative path a Game
 * operation takes, and it ends by discarding the streaming preview. The discard is right for an
 * operation - it settles the turn the operation touched - and wrong for an arrival, which would
 * then erase a reply the player is watching on the conversation, measured as `previewAfter=0`
 * where the peer surfaces exist to preserve it. An arrival is a read and a commit; the preview is
 * left exactly where the stream put it.
 *
 * A failed arrival read keeps the projection the shell already holds and states the refusal
 * instead: the projection was valid when the player switched, so replacing the whole shell with a
 * problem page over a background refresh would throw away a conversation that is still the truth,
 * and the Game surface's own rule is the same (its operation handlers all "retain the current
 * authoritative projection"). Saying nothing would be that same defect pointing the other way - a
 * panel reading `Connected` after a read that never happened - so the sentence goes to the
 * surface, through the same catalogue sentence every other refusal on it uses.
 */
export function useArrivalReread({
  shownSurface,
  viewRef,
  composedApiRef,
  localeRef,
  commit,
  rereadChat,
}: {
  shownSurface: string;
  viewRef: RefObject<ViewState>;
  composedApiRef: RefObject<ComposedReferenceGameBrowserApi>;
  localeRef: RefObject<Locale>;
  commit: (next: ViewState) => void;
  rereadChat: () => Promise<void>;
}): string | null {
  // The ref is what keeps the first paint from paying for a second read: mount already read, so
  // only a *change* of surface is an arrival.
  const lastArrivedSurfaceRef = useRef<string>(shownSurface);
  /**
   * The last Game arrival refresh the shell could not make, in the refusal's own sentence.
   *
   * The panel keeps the projection it holds - a refresh that failed did not make it wrong - so this
   * is what stops the surface quietly reading `Connected` after a read that never happened. It is
   * spent by the next arrival refresh that succeeds, because past that point it describes a read
   * that no longer stands.
   */
  const [gameArrivalNotice, setGameArrivalNotice] = useState<string | null>(null);
  useEffect(() => {
    if (lastArrivedSurfaceRef.current === shownSurface) return;
    lastArrivedSurfaceRef.current = shownSurface;
    if (shownSurface === CHAT_PANEL) {
      void rereadChat().catch((error: unknown) => commit(problemView(error, messages(localeRef.current))));
      return;
    }
    if (shownSurface !== GAME_PANEL) return;
    void composedApiRef.current
      .readState()
      .then((root) => {
        const current = viewRef.current;
        if (current.kind !== "ready") return;
        setGameArrivalNotice(null);
        commit({ ...current, root, session: current.session.applySnapshot(root.chat) });
      })
      .catch((error: unknown) => setGameArrivalNotice(problemView(error, messages(localeRef.current)).detail));
  }, [shownSurface, commit]);
  return gameArrivalNotice;
}
