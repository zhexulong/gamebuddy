import { type RefObject, useEffect, useRef, useState } from "react";
import { type Locale, messages } from "../i18n";
import { type ChatModelRoute, readChatModelRoute } from "../chat-model-route";
import { composedProblemView as problemView } from "../composed-problem-view";
import type { ManagementPipelineApi } from "../management-pipeline-api";
import { CHAT_PANEL, GAME_PANEL } from "../composed-surface-route";
import type { ComposedBootstrap } from "./use-composed-bootstrap";

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
 * The read is `rereadChat`, the mount's own authoritative path (the composed root, with the draft it
 * carries), taken once per arrival. The ref is what keeps the first paint from paying for a second
 * read: mount already read, so only a *change* of surface is an arrival. The other surfaces read their
 * own projections when they mount, so this one belongs to the surface that renders the shell's
 * committed projection; it is a read on an event, never a timer.
 *
 * The conversation has a second arrival read: the route a message the player sends from here would
 * actually reach a model through. It is derived, never guessed - `readChatModelRoute` is the one
 * function that reads the two settings projections and applies the Host's own precedence (an active
 * connection, else the shipped Chat profile on this machine's operator gateway), and the
 * conversation words itself from that answer alone. A mount that publishes neither read, or answers
 * with something this client cannot read, keeps `unknown`: saying nothing is the only honest
 * sentence then. It is taken whenever the conversation is shown again, so activating a connection
 * in Settings clears the surface's own sentence without a reload.
 *
 * The Game surface needs the same reread, and it is taken here rather than in `GameSurface` because
 * the composed root is the shell's own projection: every fact the panel renders - the connection,
 * the instance, the world and save, the last result - is that root's Game half, and the Host moves
 * it while another surface is open (a resume converging, a farm loading, a world ending). Measured
 * 2026-10-31 before this read existed: the panel read `Connection No game connection / Last result
 * No activity yet` and, after the Host had moved to an attached session while the player was on
 * the conversation, still read exactly that on the way back - the whole journey paid one `/state`
 * read, none of them on arrival.
 *
 * It is deliberately NOT `GameSurface`'s own `rereadGame`: that is the authoritative path a Game
 * operation takes, and it is the operation's state machine the arrival must not touch - the surface
 * keeps a resume the player is watching in flight across the switch, and an arrival read that went
 * through its handlers could land in that attempt. The preview is not what separates them: both reads
 * keep a reply that is still streaming, because the preview belongs to the turn it was built from and
 * neither read may spend it while that turn runs. An arrival is a read and a commit; the preview is
 * left exactly where the stream put it.
 *
 * A failed arrival read keeps the projection the shell already holds and states the refusal
 * instead, on BOTH surfaces: the projection was valid when the player switched, so replacing the
 * whole shell with a problem page over a background refresh would throw away a conversation that is
 * still the truth - and would take the player's unsent draft with it - while the Game surface's own
 * operation handlers all "retain the current authoritative projection". Saying nothing would be
 * that same defect pointing the other way - a panel reading `Connected` after a read that never
 * happened - so each surface states the read it could not make, in its own line.
 *
 * Neither notice is a retry affordance: the read that failed is a refresh of what the screen already
 * shows, the next arrival takes it again, and a sentence asking the player to press something for a
 * micro race is a worse answer than the truth about which read stood.
 */
export function useArrivalReread(
  shownSurface: string,
  bootstrap: ComposedBootstrap,
  localeRef: RefObject<Locale>,
  rereadChat: () => Promise<void>,
  managementApiRef: RefObject<ManagementPipelineApi>,
): Readonly<{ gameArrivalNotice: string | null; chatArrivalNotice: string | null; chatModelRoute: ChatModelRoute }> {
  const { view, viewRef, composedApiRef, commit } = bootstrap;
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
  /**
   * The last Chat arrival refresh the shell could not make, in the same shape as the Game one: the
   * conversation on screen is the last projection the Host confirmed, so it stays, and this is what
   * stops the surface reading it as the Host's current answer. Spent by the next arrival refresh
   * that succeeds.
   */
  const [chatArrivalNotice, setChatArrivalNotice] = useState<string | null>(null);
  const [chatModelRoute, setChatModelRoute] = useState<ChatModelRoute>({ kind: "unknown" });
  const conversationShown = view.kind === "ready" && view.session.snapshot.chat !== null;
  useEffect(() => {
    if (lastArrivedSurfaceRef.current === shownSurface) return;
    lastArrivedSurfaceRef.current = shownSurface;
    if (shownSurface === CHAT_PANEL) {
      void rereadChat()
        .then(() => setChatArrivalNotice(null))
        .catch(() => setChatArrivalNotice(messages(localeRef.current).chatArrivalNotice));
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
  useEffect(() => {
    if (!conversationShown || shownSurface !== CHAT_PANEL) return;
    let active = true;
    void readChatModelRoute(managementApiRef.current).then((route) => {
      if (active) setChatModelRoute(route);
    });
    return () => {
      active = false;
    };
  }, [conversationShown, shownSurface]);
  return { gameArrivalNotice, chatArrivalNotice, chatModelRoute };
}
