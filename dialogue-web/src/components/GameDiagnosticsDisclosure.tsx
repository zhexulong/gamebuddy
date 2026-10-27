import { ChevronRight } from "lucide-react";
import type { GameBrowserStateV1 } from "../composed-reference-game-browser-api";
import type { Messages } from "../i18n";

/**
 * The read-only Game data disclosure: a collapsed-by-default dump of what the
 * Host actually publishes about the game instance.
 *
 * Reachability is the first question here, and the answer decides what this
 * panel may show: the composed shell serves exactly one game read,
 * `GET /api/composed-reference-game/v1/game` (and the same projection inside
 * `…/state`), backed by `game.state.read`. That projection is the Host's
 * instance and session truth, it is the whole of what a browser can obtain, and
 * it is what this dump renders.
 *
 * So: real Host data, rendered read-only; no chart library, no new dependency;
 * the frozen Game-surface anchors are untouched (this sits beside the
 * `game-state-panel` region, never inside it - the region's own text is asserted
 * as localized player outcomes, and a raw projection carries the Host's enum
 * spellings). When the Host publishes nothing for this profile there is no dump
 * to show, and the panel says that plainly rather than rendering an empty box.
 */
export function GameDiagnosticsDisclosure({
  game,
  labels,
}: Readonly<{ game: GameBrowserStateV1 | null; labels: Messages }>) {
  return (
    <details className="game-diagnostics custom-disclosure" data-testid="game-diagnostics-disclosure">
      <summary className="game-diagnostics-summary">
        <ChevronRight className="game-diagnostics-chevron" size={16} aria-hidden="true" />
        {labels.gameDiagnostics}
      </summary>
      {game === null ? (
        <p className="game-diagnostics-note">{labels.gameDiagnosticsUnavailable}</p>
      ) : (
        <>
          <p className="game-diagnostics-note">{labels.gameDiagnosticsPublished}</p>
          {/* The session's CSRF token and expiry are deliberately not part of the
              dump: only the nested game projection crosses, so no credential or
              session secret is renderable here. `tabIndex` because a scrollable
              region that cannot take focus is unreachable for a keyboard-only
              player (axe: scrollable-region-focusable). */}
          <pre
            className="game-diagnostics-json"
            data-testid="game-diagnostics-json"
            aria-label={labels.gameDiagnosticsJson}
            tabIndex={0}
          >
            <code>{JSON.stringify(game.game, null, 2)}</code>
          </pre>
        </>
      )}
    </details>
  );
}
