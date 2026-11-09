/**
 * The Preset peer surface: what the assembly actually does with the preset the player imported.
 *
 * Design (`design/architecture/tavern-preset-compatibility.md` §2.1, §2.5, §4) is that a preset is read-only -
 * imported once, edited by nobody - so this surface has no editor, no switch and no command. It answers the four
 * questions a player can otherwise only guess at, and it answers each one by NAME:
 *
 *  - how many entries there are, and which of them are switched off (a switched-off entry is listed, not hidden:
 *    the world book's own lesson - a switch the player cannot see is a switch that looks broken);
 *  - which markers have no content source (`unfilled`), because a blank region is not a fact and an omitted entry
 *    is a fact nobody can see at all;
 *  - which macros this product will not evaluate, each with the code that says so
 *    (`macro_not_implemented:<name>` / `macro_unknown:<name>`);
 *  - that depth injection exists at all: how many blocks, and at which depths;
 *  - what each sampler key will actually be sent as, and which layer decided it (`preset` / `model` /
 *    `thinking-level` / `unset`). This is the one fact the preset's own file cannot answer (§5): the model or the
 *    thinking level may override a value the preset wrote, so a panel that echoed the written value would be telling
 *    the player about a request nobody sends. Every key gets a row, `unset` ones included - an omitted row reads as
 *    "there is no such setting" rather than "nothing is sent".
 *
 * The read is one GET on mount. A failed read says so; it never renders an empty assembly, because "no preset was
 * imported" and "the assembly could not be read" are two different facts and a player acts differently on each.
 */
import { ScrollText } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import type { Messages } from "../i18n";
import {
  type PresetAssemblySurfaceV1,
  type PresetAssemblyReadV1,
  readPresetAssemblySurface,
} from "../preset-assembly-surface";
import { SurfaceView } from "./SurfaceView";

type PresetAssemblyView =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "ready"; read: PresetAssemblyReadV1 }>;

export function PresetAssemblySurface({ labels }: Readonly<{ labels: Messages }>): ReactElement {
  return (
    <SurfaceView title={labels.presetsPanel} testId="presets-surface" icon={ScrollText} className="surface-panel">
      <PresetAssemblyPanel labels={labels} />
    </SurfaceView>
  );
}

function PresetAssemblyPanel({ labels }: Readonly<{ labels: Messages }>): ReactElement {
  const [view, setView] = useState<PresetAssemblyView>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const read = await readPresetAssemblySurface();
        if (live) setView({ kind: "ready", read });
      } catch {
        if (live) setView({ kind: "failed" });
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  return (
    <div data-preset-readout>
      <p className="management-settings-hint">{labels.presetReadOnlyHint}</p>
      {view.kind === "loading" && <p>{labels.loading}</p>}
      {view.kind === "failed" && (
        <p role="status" className="error-banner" data-preset-read-failed>
          {labels.presetReadFailed}
        </p>
      )}
      {view.kind === "ready" && view.read.presets.length === 0 && <p data-preset-none>{labels.presetEmpty}</p>}
      {view.kind === "ready" &&
        view.read.presets.map((preset) => <PresetAssemblyRow key={preset.presetId} preset={preset} labels={labels} />)}
    </div>
  );
}

/** One imported preset, as the four facts plus the counts that frame them. */
function PresetAssemblyRow({
  preset,
  labels,
}: Readonly<{ preset: PresetAssemblySurfaceV1; labels: Messages }>): ReactElement {
  return (
    <section
      className="management-settings-section"
      aria-label={preset.name ?? preset.presetId}
      data-preset-assembly={preset.presetId}
    >
      <h3>{preset.name ?? preset.presetId}</h3>
      <p className="management-settings-hint" data-preset-entries>
        {labels.presetEntriesLine
          .replace("{{total}}", String(preset.entries.total))
          .replace("{{enabled}}", String(preset.entries.enabled))
          .replace("{{disabled}}", String(preset.entries.disabled))}
      </p>

      <h4>{labels.presetDisabledTitle}</h4>
      {preset.disabledEntries.length === 0 ? (
        <p className="management-settings-hint" data-preset-disabled-none>
          {labels.presetDisabledNone}
        </p>
      ) : (
        <ul data-preset-disabled>
          {preset.disabledEntries.map((identifier) => (
            <li key={identifier} data-preset-disabled-entry={identifier}>
              {identifier}
            </li>
          ))}
        </ul>
      )}

      <h4>{labels.presetUnfilledTitle}</h4>
      {preset.unfilledMarkers.length === 0 ? (
        <p className="management-settings-hint" data-preset-unfilled-none>
          {labels.presetUnfilledNone}
        </p>
      ) : (
        <ul data-preset-unfilled>
          {preset.unfilledMarkers.map((marker) => (
            <li key={marker} data-preset-marker={marker}>
              {marker}
            </li>
          ))}
        </ul>
      )}

      <h4>{labels.presetMacrosTitle}</h4>
      {preset.macros.length === 0 ? (
        <p className="management-settings-hint" data-preset-macros-none>
          {labels.presetMacrosNone}
        </p>
      ) : (
        <ul data-preset-macros>
          {preset.macros.map((macro) => (
            <li key={macro.code} data-preset-macro={macro.code}>
              <code>{macro.code}</code> <span>({macro.entries.join(", ")})</span>
            </li>
          ))}
        </ul>
      )}

      <h4>{labels.presetDepthTitle}</h4>
      {preset.depth.count === 0 ? (
        <p className="management-settings-hint" data-preset-depth-none>
          {labels.presetDepthNone}
        </p>
      ) : (
        <>
          <p className="management-settings-hint" data-preset-depth-line>
            {labels.presetDepthLine
              .replace("{{count}}", String(preset.depth.count))
              .replace("{{depths}}", preset.depth.depths.join(", "))}
          </p>
          <ul data-preset-depth-blocks>
            {preset.depth.blocks.map((block) => (
              <li key={block.identifier} data-preset-depth-block={block.identifier}>
                {block.identifier} · {block.depth}
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>{labels.presetSamplingTitle}</h4>
      <p className="management-settings-hint" data-preset-sampling-hint>
        {labels.presetSamplingHint}
      </p>
      {"unavailable" in preset.sampling ? (
        <p className="management-settings-hint" data-preset-sampling-unavailable={preset.sampling.unavailable}>
          {labels.presetSamplingUnavailable}
        </p>
      ) : (
        <ul data-preset-sampling>
          {preset.sampling.map((row) => (
            <li key={row.key} data-preset-sampling-row={row.key}>
              <code>{row.key}</code> = {row.value === null ? "\u2014" : String(row.value)} ({row.source})
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
