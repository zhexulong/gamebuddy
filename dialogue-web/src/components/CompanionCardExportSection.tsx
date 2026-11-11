import { type ReactElement, useEffect, useState } from "react";
import { problemTextWithCode } from "../composed-problem-view";
import { type Locale, type Messages, messages } from "../i18n";
import { type ManagementPipelineApi, TavernProblemError } from "../management-pipeline-api";
import type { InspectedCompanion } from "./CompanionInspectorDrawer";
import { type CharacterLabels, characterLabels } from "./character-domain-labels";
import { downloadFile } from "./download-file";

/**
 * The character-card export: two controls that save the companion in play as a
 * standard Tavern V3 card, one per form.
 *
 * The card is produced by the Host (`companion.card.export`) and delivered as the
 * bytes it returned - the browser is the download surface, so this control hands
 * the Host's own payload to a `Blob` and lets the browser save it under the
 * filename the Host minted. Nothing is rebuilt on this side: the JSON form is the
 * Host's own card text, and the PNG form is the Host's own card file (her picture
 * with the card inside it), so what lands is exactly the card the Host built and
 * the import route accepts.
 *
 * The two forms are named controls, not one control with a choice hidden behind a
 * filename: a player asks for the JSON card or the PNG card and the request says
 * which. The PNG card contains her own picture, so a companion without one gets her
 * own refusal rather than a silently blank or invented image.
 *
 * The companion addressed is the one the player is looking at: the roster row whose
 * inspector she opened, which the drawer named and the surface remembered. Only when
 * the player has named no companion at all - nothing inspected since the surface
 * mounted - is her card the one in play. Both are the roster's own opaque handle -
 * the same handle every other companion read is addressed by - and the route resolves
 * any listed companion.
 *
 * The selection outlives the drawer because the drawer is modal: while it is open the
 * backdrop stands between the player and this control, so the export she asks for is
 * the one she presses after reading her. The control therefore follows what she was
 * reading rather than reverting to the companion in play - reverting is what made
 * saving an archived companion's card silently save the active one's.
 *
 * Every way the Host can refuse has its own sentence: there is no
 * companion to export, her records could not be read, they will not fit a card our
 * import accepts, or she has no picture for the PNG form.
 */
export function CompanionCardExportSection({
  api,
  locale,
  inspected,
}: {
  api: ManagementPipelineApi;
  locale: Locale;
  inspected: InspectedCompanion | null;
}): ReactElement | null {
  const labels = characterLabels(locale);
  const [inPlay, setInPlay] = useState<
    Readonly<{ handle: string; name: string }> | "loading" | "absent" | "unavailable"
  >("loading");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Readonly<{ ok: boolean; text: string }> | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const list = await api.listCompanions();
        if (!active) return;
        const current = list.companions.find((entry) => entry.isCurrent);
        setInPlay(current === undefined ? "absent" : { handle: current.handle, name: current.name });
      } catch {
        // A read that fails renders nothing rather than fabricating a capability.
        if (active) setInPlay("unavailable");
      }
    })();
    return () => {
      active = false;
    };
    // The client is the mount's own authority and is stable for the life of the surface.
  }, [api]);

  /**
   * The companion this control saves.
   *
   * The companion the player is looking at wins; the one in play is only the
   * fallback for a surface where nothing has been named yet. A roster read still in
   * flight - or one that failed - names nothing, so the control is not offered on
   * the strength of a companion it has not read; an inspection the drawer already
   * named needs no roster read at all.
   */
  const target: Readonly<{ handle: string; name: string }> | "absent" | null =
    inspected !== null ? inspected : inPlay === "loading" || inPlay === "unavailable" ? null : inPlay;

  if (target === null) return null;

  const exportCard = (format: "json" | "png"): void => {
    if (target === "absent" || busy) return;
    const handle = target.handle;
    setBusy(true);
    setNotice(null);
    void (async () => {
      let next: Readonly<{ ok: boolean; text: string }>;
      try {
        const card = await api.exportCompanionCard(handle, format);
        // The Host's own bytes, in the Host's own file kind: the JSON card is its
        // text, the PNG card is the whole file the Host built.
        if (card.format === "png")
          downloadFile(card.fileName, new Blob([base64Bytes(card.cardFileBase64)], { type: "image/png" }));
        else downloadFile(card.fileName, new Blob([card.card], { type: "application/json" }));
        next = { ok: true, text: labels.exportSaved.replace("{{file}}", card.fileName) };
      } catch (error) {
        next = { ok: false, text: exportRefusal(labels, error, messages(locale)) };
      }
      setBusy(false);
      setNotice(next);
    })();
  };

  return (
    <section className="management-settings-section" aria-label={labels.exportTitle} data-companion-card-export-section>
      <h3>{labels.exportTitle}</h3>
      <p className="management-settings-hint">{labels.exportHint}</p>
      {target === "absent" ? (
        <p data-companion-card-export-nothing>{labels.exportNothing}</p>
      ) : (
        // Two controls, each named for the form it saves. Their 44 px hit targets
        // are the shared button's own floor (`--touch-target-min`), so they match
        // every other control on this surface rather than a size invented here.
        <div className="composer-actions">
          <button
            type="button"
            className="small-button"
            data-companion-card-export-json
            aria-label={`${labels.exportJsonCard}: ${target.name}`}
            disabled={busy}
            onClick={() => exportCard("json")}
          >
            {busy ? labels.exportBusy : labels.exportJsonCard}
          </button>
          <button
            type="button"
            className="small-button"
            data-companion-card-export-png
            aria-label={`${labels.exportPngCard}: ${target.name}`}
            disabled={busy}
            onClick={() => exportCard("png")}
          >
            {busy ? labels.exportBusy : labels.exportPngCard}
          </button>
        </div>
      )}
      {notice !== null && (
        <p role="status" data-companion-card-export-notice className={notice.ok ? "success-banner" : "error-banner"}>
          {notice.text}
        </p>
      )}
    </section>
  );
}

/**
 * The bytes a base64 payload names, decoded in this browser.
 *
 * `atob` is fed the whole string at once - the PNG card is a file, and it is the
 * same size the player will save - and the per-character copy is the only loop.
 */
function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The player's sentence for one refused export. Each way the Host refuses is a
 * different fact - there is no companion, her records could not be read, they will
 * not fit a card, or she has no picture for the PNG form - and one "could not
 * export" would send her looking for the wrong fault. A code this table does not
 * know keeps the base sentence with the code appended.
 */
function exportRefusal(labels: CharacterLabels, error: unknown, problemLabels: Messages): string {
  const code = error instanceof TavernProblemError ? error.code : null;
  switch (code) {
    case "companion_not_found":
      return labels.exportNothing;
    case "companion_record_unreadable":
      return labels.exportUnreadable;
    case "companion_card_too_large":
      return labels.exportTooLarge;
    case "companion_card_image_absent":
      return labels.exportImageAbsent;
    default:
      return problemTextWithCode(labels.exportFailed, error, problemLabels);
  }
}
