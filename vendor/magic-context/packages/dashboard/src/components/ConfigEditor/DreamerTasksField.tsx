import { createSignal, Index, Show } from "solid-js";

import { describeCron, isValidCronShape } from "../../lib/cron";
import { type Harness, type ModelEntry, modelEntryWithModel, modelId } from "./HarnessModelFields";
import ModelSelect from "./ModelSelect";

export interface DreamTaskConfig {
  schedule?: string;
  promotion_threshold?: number;
  [key: string]: unknown;
}

export interface DreamTaskModelConfig {
  model?: ModelEntry;
  variant?: string;
  thinking_level?: string;
  [key: string]: unknown;
}

type TasksValue = Record<string, DreamTaskConfig> | undefined;
type ModelTasksValue = Record<string, DreamTaskModelConfig> | undefined;

export interface TaskMeta {
  name: string;
  label: string;
  description: string;
  defaultSchedule: string;
}

// Mirrors CANONICAL_DREAM_TASKS + DEFAULT_TASK_SCHEDULES in the plugin schema.
export const TASKS: TaskMeta[] = [
  {
    name: "map-memories",
    label: "Map memories",
    description: "Maps each memory to its backing files so verify knows what to re-check",
    defaultSchedule: "0 2 * * *",
  },
  {
    name: "verify",
    label: "Verify changed memories",
    description: "Checks changed-file memories against code and fixes/removes stale ones",
    defaultSchedule: "0 3 * * *",
  },
  {
    name: "verify-broad",
    label: "Verify all memories",
    description: "Periodic full re-check of the whole memory pool (catches drift)",
    defaultSchedule: "0 4 * * 0",
  },
  {
    name: "curate",
    label: "Curate memories",
    description: "Deduplicates, tightens, and prunes the memory pool",
    defaultSchedule: "0 4 * * 0",
  },
  {
    name: "compress-cues",
    label: "Compress mural cues",
    description:
      "Compresses each overflow memory into a mural cue (the mural image renders deterministically)",
    defaultSchedule: "0 4 * * *",
  },
  {
    name: "classify-memories",
    label: "Classify memories",
    description: "Scores memory importance, scope, and shareability",
    defaultSchedule: "0 6 * * *",
  },
  {
    name: "retrospective",
    label: "Retrospective",
    description: "Learns from moments you had to correct or re-explain, and records the lesson",
    defaultSchedule: "0 5 * * *",
  },
  {
    name: "maintain-docs",
    label: "Maintain docs",
    description: "Keep ARCHITECTURE.md / STRUCTURE.md in sync",
    defaultSchedule: "",
  },
  {
    name: "evaluate-smart-notes",
    label: "Evaluate smart notes",
    description: "Surface smart notes whose conditions are now met",
    defaultSchedule: "0 3 * * *",
  },
  {
    name: "review-user-memories",
    label: "Review user memories",
    description: "Promote recurring behaviors into your user profile",
    defaultSchedule: "0 3 * * *",
  },
  {
    name: "promote-primers",
    label: "Promote primers",
    description: "Promote recurring project questions into Primers",
    defaultSchedule: "0 3 * * *",
  },
  {
    name: "refresh-primers",
    label: "Refresh primers",
    description: "Refresh answers for active project Primers",
    defaultSchedule: "0 3 * * *",
  },
];

const PRESETS: { label: string; cron: string }[] = [
  { label: "Nightly (3am)", cron: "0 3 * * *" },
  { label: "Weekly (Sun 4am)", cron: "0 4 * * 0" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Disabled", cron: "" },
];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const CUSTOM = "__custom__";

function isPresetCron(cron: string): boolean {
  return PRESETS.some((p) => p.cron === cron);
}

function promotionThresholdDefault(taskName: string): number | undefined {
  if (taskName === "review-user-memories") return 3;
  if (taskName === "promote-primers") return 2;
  return undefined;
}

function promotionThresholdDescription(taskName: string): string {
  return taskName === "promote-primers"
    ? "Promotion threshold (2–20 recurring source days, default 2)"
    : "Promotion threshold (2–20 observations, default 3)";
}

interface DreamerTasksFieldProps {
  value: TasksValue;
  onChange: (tasks: Record<string, DreamTaskConfig>) => void;
  harness: Harness;
  modelTasks: ModelTasksValue;
  onModelTasksChange: (tasks: Record<string, DreamTaskModelConfig> | undefined) => void;
  models: string[];
}

export default function DreamerTasksField(props: DreamerTasksFieldProps) {
  const [customMode, setCustomMode] = createSignal<Set<string>>(
    new Set(
      TASKS.filter((meta) => {
        const schedule = props.value?.[meta.name]?.schedule ?? meta.defaultSchedule;
        return schedule.trim() !== "" && !isPresetCron(schedule);
      }).map((meta) => meta.name),
    ),
  );
  const inCustomMode = (name: string) => customMode().has(name);
  const setTaskCustom = (name: string, on: boolean) =>
    setCustomMode((previous) => {
      const next = new Set(previous);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  const taskCfg = (meta: TaskMeta): DreamTaskConfig => {
    const stored = props.value?.[meta.name];
    return {
      schedule: stored?.schedule ?? meta.defaultSchedule,
      promotion_threshold: stored?.promotion_threshold,
    };
  };
  const modelCfg = (name: string): DreamTaskModelConfig => props.modelTasks?.[name] ?? {};

  // Scheduling stays in dreamer.tasks, while model resolution lives under the
  // selected harness. Start from stored objects so advanced fields survive edits.
  const updateSchedule = (name: string, patch: Partial<DreamTaskConfig>): void => {
    const next: Record<string, DreamTaskConfig> = {};
    const canonicalNames = new Set(TASKS.map((task) => task.name));
    for (const [taskName, taskConfig] of Object.entries(props.value ?? {})) {
      if (!canonicalNames.has(taskName)) next[taskName] = { ...taskConfig };
    }
    for (const meta of TASKS) {
      const stored = props.value?.[meta.name];
      const entry: DreamTaskConfig = {
        ...(stored ?? {}),
        schedule: stored?.schedule ?? meta.defaultSchedule,
      };
      if (meta.name === name) Object.assign(entry, patch);
      entry.schedule = entry.schedule ?? "";
      for (const key of Object.keys(entry)) {
        if (entry[key] === undefined) delete entry[key];
      }
      next[meta.name] = entry;
    }
    props.onChange(next);
  };

  const updateModel = (name: string, patch: Partial<DreamTaskModelConfig>) => {
    const next: Record<string, DreamTaskModelConfig> = { ...(props.modelTasks ?? {}) };
    const entry = { ...(next[name] ?? {}), ...patch };
    for (const key of Object.keys(entry)) {
      if (entry[key] === undefined) delete entry[key];
    }
    if (Object.keys(entry).length === 0) delete next[name];
    else next[name] = entry;
    props.onModelTasksChange(Object.keys(next).length > 0 ? next : undefined);
  };

  const qualifierLabel = () => (props.harness === "opencode" ? "Variant" : "Thinking level");
  const qualifierKey = () => (props.harness === "opencode" ? "variant" : "thinking_level");

  return (
    <div class="dreamer-tasks" data-harness={props.harness}>
      <Index each={TASKS}>
        {(meta) => {
          const cfg = () => taskCfg(meta());
          const taskModel = () => modelCfg(meta().name);
          const schedule = () => cfg().schedule ?? "";
          const enabled = () => schedule().trim() !== "";
          const selectValue = () =>
            inCustomMode(meta().name) || (schedule().trim() !== "" && !isPresetCron(schedule()))
              ? CUSTOM
              : schedule();
          return (
            <div class="dreamer-task-row">
              <div class="dreamer-task-head">
                <span class="config-field-label">{meta().label}</span>
                <span class="config-field-desc">
                  <code>{meta().name}</code> — {meta().description}
                </span>
              </div>
              <div class="dreamer-task-controls">
                <div class="select-wrap">
                  <select
                    class="config-input config-select"
                    value={selectValue()}
                    onChange={(event) => {
                      const next = event.currentTarget.value;
                      if (next === CUSTOM) {
                        setTaskCustom(meta().name, true);
                        if (schedule().trim() === "") {
                          updateSchedule(meta().name, { schedule: "0 3 * * *" });
                        }
                      } else {
                        setTaskCustom(meta().name, false);
                        updateSchedule(meta().name, { schedule: next });
                      }
                    }}
                  >
                    <Index each={PRESETS}>
                      {(preset) => <option value={preset().cron}>{preset().label}</option>}
                    </Index>
                    <option value={CUSTOM}>Custom cron…</option>
                  </select>
                </div>
                <ModelSelect
                  models={props.models}
                  value={modelId(taskModel().model)}
                  onChange={(next) =>
                    updateModel(meta().name, {
                      model: modelEntryWithModel(
                        taskModel().model,
                        props.harness,
                        next || undefined,
                      ),
                    })
                  }
                  placeholder="— inherit harness model —"
                />
              </div>
              <div class="dreamer-task-param">
                <span class="config-field-desc">{qualifierLabel()}</span>
                <Show
                  when={props.harness === "opencode"}
                  fallback={
                    <select
                      class="config-input config-select"
                      value={String(taskModel()[qualifierKey()] ?? "")}
                      onChange={(event) =>
                        updateModel(meta().name, {
                          [qualifierKey()]: event.currentTarget.value || undefined,
                        })
                      }
                    >
                      <option value="">Use harness default</option>
                      <Index each={THINKING_LEVELS}>
                        {(level) => <option value={level()}>{level()}</option>}
                      </Index>
                    </select>
                  }
                >
                  <input
                    class="config-input"
                    type="text"
                    value={String(taskModel()[qualifierKey()] ?? "")}
                    placeholder="Use harness default"
                    onInput={(event) =>
                      updateModel(meta().name, {
                        [qualifierKey()]: event.currentTarget.value || undefined,
                      })
                    }
                  />
                </Show>
              </div>
              <Show when={selectValue() === CUSTOM}>
                <div class="dreamer-cron-custom">
                  <input
                    class="config-input"
                    classList={{ "config-input-invalid": !isValidCronShape(schedule()) }}
                    type="text"
                    value={schedule()}
                    placeholder="0 3 * * *  (min hour day month weekday)"
                    onInput={(event) =>
                      updateSchedule(meta().name, { schedule: event.currentTarget.value })
                    }
                  />
                  <span
                    class="dreamer-cron-human"
                    classList={{ invalid: !isValidCronShape(schedule()) }}
                  >
                    {isValidCronShape(schedule())
                      ? describeCron(schedule())
                      : "Invalid cron — need 5 fields: min hour day month weekday"}
                  </span>
                </div>
              </Show>
              <Show when={enabled() && promotionThresholdDefault(meta().name) !== undefined}>
                <div class="dreamer-task-param">
                  <span class="config-field-desc">
                    {promotionThresholdDescription(meta().name)}
                  </span>
                  <input
                    class="config-input"
                    type="number"
                    min={2}
                    max={20}
                    value={cfg().promotion_threshold ?? promotionThresholdDefault(meta().name) ?? 3}
                    onInput={(event) =>
                      updateSchedule(meta().name, {
                        promotion_threshold: Number(event.currentTarget.value),
                      })
                    }
                  />
                </div>
              </Show>
            </div>
          );
        }}
      </Index>
    </div>
  );
}
