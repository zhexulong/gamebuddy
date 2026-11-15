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
 *    "there is no such setting" rather than "nothing is sent";
 *  - which fields the preset states that this product recognises and does NOT send, each with the class of reason. The
 *    sampler rows above are not everything a preset can say: a `seed`, an `n` or a context budget is silently inert,
 *    and a readout that stays silent about them makes this panel an incomplete answer to "did my file take effect".
 *
 * The read is one GET on mount. A read that fails says which of the two things went wrong, and never renders an empty
 * assembly: "no preset was imported", "the Host would not serve the read" and "the Host served something this build
 * cannot read" are three different facts and a player acts differently on each.
 */
import { ArrowLeft, ScrollText } from "lucide-react";
import { type ReactElement, type RefObject, useEffect, useState } from "react";
import { assertNever } from "../assert-never";
import type { Messages } from "../i18n";
import {
  type PresetActiveBindingV1,
  type PresetAssemblySurfaceV1,
  type PresetAssemblyReadV1,
  type PresetNotAppliedV1,
  PresetAssemblyProtocolError,
  readPresetAssemblySurface,
} from "../preset-assembly-surface";
import { SurfaceView } from "./SurfaceView";

type PresetAssemblyView =
  | Readonly<{ kind: "loading" }>
  /** The Host did not serve the read: a status that is not `200`, or a transport that never reached it. */
  | Readonly<{ kind: "failed" }>
  /** It did answer, and the body is not the readout this build can show: a reply the mirror refuses. */
  | Readonly<{ kind: "unreadable" }>
  | Readonly<{ kind: "ready"; read: PresetAssemblyReadV1 }>;

/**
 * Which preset is in force, as this panel can know it: the contract's three states, plus `unreported` for a body that
 * does not carry the fact (the contract marks it `Type.Optional`).
 */
type PresetBindingShown = PresetActiveBindingV1 | Readonly<{ state: "unreported" }>;

/**
 * Which of the two failure states a read that produced no readout is.
 *
 * `PresetAssemblyProtocolError` is the mirror's one "the reply is not the published readout" fact: a 200 whose body
 * does not validate, a body that is not JSON at all. Everything else - a status the Host refused, a transport that
 * never reached it - is a read that was not served. The two ask for opposite things, so the panel may not call the
 * second fact by the first one's name: a refused read is answered by reading again, and a reply this build cannot
 * read is answered by a build that knows what the Host now says, where retrying changes nothing.
 */
function presetAssemblyReadFailure(error: unknown): "failed" | "unreadable" {
  return error instanceof PresetAssemblyProtocolError ? "unreadable" : "failed";
}

export function PresetAssemblySurface({
  labels,
  onBack,
  restoreFocusTo,
}: Readonly<{
  labels: Messages;
  /**
   * Where the readout returns to: the Settings surface that opened it. The shell owns the route, so
   * this surface is handed the move rather than deciding where the player goes next.
   */
  onBack: () => void;
  /** The disclosure's own button, which is the control this surface was opened from. */
  restoreFocusTo: RefObject<HTMLElement | null>;
}>): ReactElement {
  return (
    <SurfaceView
      title={labels.presetsPanel}
      testId="presets-surface"
      icon={ScrollText}
      className="surface-panel"
      restoreFocusTo={restoreFocusTo}
    >
      {/* The readout's way out. It is a full-region page reached from a disclosure inside Settings,
          so leaving it is a step BACK to the surface that opened it - not a jump to the
          conversation, which would skip the page the player was working in. It sits above the
          panel's own prose and is the first thing in the tab order, so a keyboard player lands on
          it before the read-only facts. */}
      <button type="button" className="small-button" data-testid="presets-back" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden="true" />
        {labels.presetBackToSettings}
      </button>
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
      } catch (error) {
        if (live) setView({ kind: presetAssemblyReadFailure(error) });
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
      {view.kind === "unreadable" && (
        <p role="status" className="error-banner" data-preset-reply-unreadable>
          {labels.presetReplyUnreadable}
        </p>
      )}
      {view.kind === "ready" && <ActivePresetLine binding={view.read.activePreset} labels={labels} />}
      {view.kind === "ready" && view.read.presets.length === 0 && <p data-preset-none>{labels.presetEmpty}</p>}
      {view.kind === "ready" &&
        view.read.presets.map((preset) => <PresetAssemblyRow key={preset.presetId} preset={preset} labels={labels} />)}
    </div>
  );
}

/**
 * Which preset is in force, always drawn - the contract's three states plus the one only this panel can see.
 *
 * `unreported` is that fourth one, and it is not a state the contract has: `activePreset` is `Type.Optional` on the
 * Host's body, so a Host that predates the fact still reads. Rendering nothing for the absent fact made "no preset is
 * bound" (the contract's own `none`) and "this build was never told" indistinguishable, and both looked exactly like
 * a panel that never loaded. One line, one attribute, one vocabulary: the state is the attribute's value, taken from
 * the contract's union where the contract has the state and named `unreported` where it does not.
 */
function ActivePresetLine({
  binding,
  labels,
}: Readonly<{ binding: PresetActiveBindingV1 | undefined; labels: Messages }>): ReactElement {
  const shown: PresetBindingShown = binding ?? { state: "unreported" };
  return (
    <p
      className="management-settings-hint"
      data-preset-active={shown.state}
      data-preset-active-preset={"presetId" in shown ? shown.presetId : undefined}
    >
      {activePresetLine(shown, labels)}
    </p>
  );
}

/**
 * Which preset is in force, in the surface's own words.
 *
 * Every state is rendered, because each asks the player something different: `none` is a choice nobody made yet,
 * `bound` says which preset assembles the requests, `missing` is a binding whose preset is gone - the one case where
 * doing nothing leaves the player with an assembly they did not choose - and `unreported` is a Host that sent no
 * binding fact at all, which is a fact about the panel and never a claim that nothing is bound. The switch is
 * exhaustive over the union, so a state added later is a compile error rather than another silent "none".
 */
function activePresetLine(binding: PresetBindingShown, labels: Messages): string {
  switch (binding.state) {
    case "bound":
      return labels.presetActiveBound.replace("{{preset}}", binding.presetId);
    case "missing":
      return labels.presetActiveMissing.replace("{{preset}}", binding.presetId);
    case "unreported":
      return labels.presetActiveUnreported;
    case "none":
      return labels.presetActiveNone;
    default:
      return assertNever(binding);
  }
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

      <h4>{labels.presetNotAppliedTitle}</h4>
      {preset.notApplied.length === 0 ? (
        <p className="management-settings-hint" data-preset-not-applied-none>
          {labels.presetNotAppliedNone}
        </p>
      ) : (
        <ul data-preset-not-applied>
          {preset.notApplied.map((row) => (
            <li key={row.field} data-preset-not-applied-field={row.field} data-preset-not-applied-code={row.code}>
              <code>{row.field}</code> {notAppliedReason(row, labels)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The sentence for one recognised-and-not-sent field, keyed by the reason class the Host published.
 *
 * The class and not the Host's own prose: this panel speaks the interface language, and a sentence authored for a
 * reader of the Host would arrive here untranslated. The union is closed on both sides, so a class this build has no
 * line for cannot reach here - the validator refuses that body first.
 */
function notAppliedReason(row: PresetNotAppliedV1, labels: Messages): string {
  switch (row.code) {
    case "model_owned_setting":
      return labels.presetNotAppliedReasonModelOwnedSetting;
    case "host_owned_transport":
      return labels.presetNotAppliedReasonHostOwnedTransport;
    case "no_value_to_send":
      return labels.presetNotAppliedReasonNoValueToSend;
    case "one_completion_per_call":
      return labels.presetNotAppliedReasonOneCompletionPerCall;
    default:
      return assertNever(row.code);
  }
}
