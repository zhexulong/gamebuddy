import { type JSX, Show } from "solid-js";

/**
 * One dreamer task rendered as a card: an icon, the friendly label + schedule,
 * a last-run traffic light, an on/off toggle, and an inline status container.
 * Presentational — the parent owns config read/write and passes `onToggle` +
 * `busy` + `canToggle`.
 */

export type TaskLight = "green" | "amber" | "red" | "gray";

interface DreamerTaskCardProps {
  taskName: string;
  label: string;
  description: string;
  scheduleText: string;
  nextDueText: string | null;
  enabled: boolean;
  /** Icon tint = "is this task active?" — green when enabled, red for a hard
   *  failure, and gray when disabled. A resumable broad-verification cycle stays
   *  green because it is still making progress. Distinct from `light` (the
   *  status dot's finer last-run health), so an enabled-but-not-yet-run task
   *  still reads as on. */
  iconTint: "green" | "red" | "gray";
  light: TaskLight;
  lastError: string | null;
  /** True when verify-broad has banked progress and will continue on a later run. */
  resumable?: boolean;
  /** False when the project has no resolvable worktree to write config to. */
  canToggle: boolean;
  busy: boolean;
  onToggle: (enable: boolean) => void;
}

// Inline lucide-style icon per task (no icon dependency in the dashboard). Each
// returns a 20x20 stroke icon inheriting currentColor.
function taskIcon(taskName: string): JSX.Element {
  const wrap = (children: JSX.Element) => (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
  switch (taskName) {
    case "map-memories":
      return wrap(
        <>
          <path d="M9 18l-6 3V6l6-3 6 3 6-3v15l-6 3-6-3z" />
          <path d="M9 3v15M15 6v15" />
        </>,
      );
    case "verify":
      return wrap(
        <>
          <path d="M9 12l2 2 4-4" />
          <path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3z" />
        </>,
      );
    case "verify-broad":
      return wrap(
        <>
          <path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3z" />
          <path d="M8.5 12.5l2 2 4-4" />
        </>,
      );
    case "curate":
      return wrap(<path d="M3 6h18M7 12h10M10 18h4" />);
    case "compress-cues":
      return wrap(
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="m3 16 5-5 4 4 3-3 6 6" />
          <circle cx="16.5" cy="8" r="1.5" />
        </>,
      );
    case "classify-memories":
      return wrap(
        <>
          <path d="M12 2 2 7l10 5 10-5-10-5z" />
          <path d="m2 17 10 5 10-5M2 12l10 5 10-5" />
        </>,
      );
    case "retrospective":
      return wrap(
        <>
          <path d="M21 11.5a8.5 8.5 0 1 1-3.5-6.9" />
          <path d="M21 3v5h-5" />
        </>,
      );
    case "maintain-docs":
      return wrap(
        <>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6M8 13h8M8 17h6" />
        </>,
      );
    case "evaluate-smart-notes":
      return wrap(
        <>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9z" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </>,
      );
    case "review-user-memories":
      return wrap(
        <>
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </>,
      );
    case "promote-primers":
      return wrap(
        <>
          <path d="M9 18h6M10 22h4" />
          <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V18h6v-1.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" />
        </>,
      );
    case "refresh-primers":
      return wrap(
        <>
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
          <path d="M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16" />
          <path d="M3 21v-5h5" />
        </>,
      );
    default:
      return wrap(<circle cx="12" cy="12" r="9" />);
  }
}

export default function DreamerTaskCard(props: DreamerTaskCardProps) {
  return (
    <div class={`dreamer-task-card ${props.enabled ? "on" : "off"}`}>
      <div class="dreamer-task-card-top">
        <span class={`dreamer-task-icon light-${props.iconTint}`}>{taskIcon(props.taskName)}</span>
        <div class="dreamer-task-card-titles">
          <div class="dreamer-task-card-label">
            {props.label}
            <span class={`status-dot ${props.light}`} title={props.lastError ?? undefined} />
          </div>
          <div class="dreamer-task-card-name mono">{props.taskName}</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={props.enabled}
          aria-label={`${props.enabled ? "Disable" : "Enable"} ${props.label}`}
          class={`dreamer-toggle ${props.enabled ? "on" : "off"}`}
          disabled={!props.canToggle || props.busy}
          title={
            !props.canToggle
              ? "No resolvable directory — can't write per-project config"
              : props.enabled
                ? "Disable this task for this project"
                : "Enable this task for this project"
          }
          onClick={() => props.onToggle(!props.enabled)}
        >
          <span class="dreamer-toggle-knob" />
        </button>
      </div>

      <div class="dreamer-task-card-desc">{props.description}</div>

      <div class="dreamer-task-card-foot">
        <Show
          when={props.enabled}
          fallback={<span class="dreamer-task-card-disabled">Disabled</span>}
        >
          <span class="dreamer-task-card-sched">{props.scheduleText}</span>
          <Show when={props.nextDueText}>
            <span class="dreamer-task-card-next">· {props.nextDueText}</span>
          </Show>
        </Show>
      </div>

      <Show when={props.resumable}>
        <div
          class="dreamer-task-card-error"
          style={{
            color: "var(--amber)",
            "border-color": "color-mix(in srgb, var(--amber) 35%, transparent)",
            background: "color-mix(in srgb, var(--amber) 10%, transparent)",
          }}
        >
          <span aria-hidden="true">↻</span>
          <span class="dreamer-task-card-error-text">
            Verification is in progress and will resume automatically.
          </span>
        </div>
      </Show>
      <Show when={props.lastError}>
        {(message) => (
          <div class="dreamer-task-card-error" title={message()}>
            <svg
              viewBox="0 0 24 24"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
              <path d="M12 9v4M12 17h.01" />
            </svg>
            <span class="dreamer-task-card-error-text">{message()}</span>
          </div>
        )}
      </Show>
    </div>
  );
}
