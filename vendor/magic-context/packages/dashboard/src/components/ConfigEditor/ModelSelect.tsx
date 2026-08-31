import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";

interface ModelSelectProps {
  models: string[];
  value: string | undefined;
  onChange: (value: string) => void;
  placeholder?: string;
}

const INVALID_MODEL_ID_HINT = "Enter a model id in provider/model form";

export function getTypedModelSelection(
  input: string,
  availableModels: readonly string[],
): { model: string | null; hint: string | null; isListed: boolean } {
  const model = input.trim();
  if (!model) return { model: null, hint: null, isListed: false };

  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    return { model: null, hint: INVALID_MODEL_ID_HINT, isListed: false };
  }

  // Discovery lists are never exhaustive, so a valid provider/model ID must
  // remain selectable even when it is not one of the discovered models.
  return {
    model,
    hint: null,
    isListed: availableModels.includes(model),
  };
}

export function commitTypedModelValue(
  input: string,
  availableModels: readonly string[],
  onChange: (model: string) => void,
): { model: string | null; hint: string | null; isListed: boolean } {
  const selection = getTypedModelSelection(input, availableModels);
  if (selection.model) onChange(selection.model);
  return selection;
}

export default function ModelSelect(props: ModelSelectProps) {
  const [open, setOpen] = createSignal(false);
  const [search, setSearch] = createSignal("");
  let containerRef: HTMLDivElement | undefined;
  let inputRef: HTMLInputElement | undefined;

  // Close on outside click
  const handleClickOutside = (e: MouseEvent) => {
    if (containerRef && !containerRef.contains(e.target as Node)) {
      setOpen(false);
    }
  };

  // Register/cleanup listener
  const startListening = () => document.addEventListener("mousedown", handleClickOutside);
  const stopListening = () => document.removeEventListener("mousedown", handleClickOutside);
  onCleanup(stopListening);

  // Group models by provider
  const grouped = createMemo(() => {
    const q = search().toLowerCase();
    const filtered = q ? props.models.filter((m) => m.toLowerCase().includes(q)) : props.models;

    const groups: Record<string, string[]> = {};
    for (const m of filtered) {
      const slash = m.indexOf("/");
      const provider = slash >= 0 ? m.substring(0, slash) : "other";
      if (!groups[provider]) groups[provider] = [];
      groups[provider].push(m);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  });

  const typedSelection = createMemo(() => getTypedModelSelection(search(), props.models));
  const typedModel = () => typedSelection().model;
  const showTypedModelOption = () => {
    const selection = typedSelection();
    return selection.model !== null && !selection.isListed;
  };

  const openDropdown = () => {
    setOpen(true);
    setSearch("");
    startListening();
    requestAnimationFrame(() => inputRef?.focus());
  };

  const selectModel = (model: string) => {
    props.onChange(model);
    setOpen(false);
    stopListening();
  };

  const clearSelection = (e: MouseEvent) => {
    e.stopPropagation();
    props.onChange("");
    setOpen(false);
    stopListening();
  };

  const commitTypedModel = () => commitTypedModelValue(search(), props.models, selectModel);

  // Normalize values at the component boundary because asynchronous form-state
  // refreshes can briefly provide a non-string value before the next render.
  const valueStr = createMemo(() => (typeof props.value === "string" ? props.value : ""));

  const displayValue = () => {
    const v = valueStr();
    if (!v) return props.placeholder ?? "— Use fallback chain —";
    return v;
  };

  const providerOf = (model: string) => {
    const slash = model.indexOf("/");
    return slash >= 0 ? model.substring(0, slash) : "";
  };

  const modelName = (model: string) => {
    const slash = model.indexOf("/");
    return slash >= 0 ? model.substring(slash + 1) : model;
  };

  return (
    <div class="model-select" ref={containerRef}>
      {/* Trigger button */}
      <button class="model-select-trigger" onClick={openDropdown} type="button">
        <span class={`model-select-value ${!valueStr() ? "placeholder" : ""}`}>
          {valueStr() ? (
            <>
              <Show when={providerOf(valueStr())}>
                {(provider) => <span class="model-select-provider">{provider()}/</span>}
              </Show>
              {modelName(valueStr())}
            </>
          ) : (
            displayValue()
          )}
        </span>
        <span class="model-select-actions">
          <Show when={props.value}>
            <button
              type="button"
              class="model-select-clear"
              onClick={clearSelection}
              title="Clear selection"
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
            >
              ✕
            </button>
          </Show>
          <span class="model-select-chevron">▾</span>
        </span>
      </button>

      {/* Dropdown */}
      <Show when={open()}>
        <div class="model-select-dropdown">
          <div class="model-select-search-wrap">
            <input
              ref={inputRef}
              class="model-select-search"
              type="text"
              placeholder="Search or type provider/model..."
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setOpen(false);
                  stopListening();
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  commitTypedModel();
                }
              }}
            />
          </div>
          <div class="model-select-options">
            <For each={grouped()}>
              {([provider, models]) => (
                <div class="model-select-group">
                  <div class="model-select-group-label">{provider}</div>
                  <For each={models}>
                    {(model) => (
                      <button
                        class={`model-select-option ${props.value === model ? "active" : ""}`}
                        onClick={() => selectModel(model)}
                        type="button"
                      >
                        {modelName(model)}
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
            <Show when={showTypedModelOption()}>
              <button
                class="model-select-option"
                onClick={() => {
                  const model = typedModel();
                  if (model) selectModel(model);
                }}
                type="button"
              >
                Use "{typedModel()}"
              </button>
            </Show>
            <Show when={typedSelection().hint}>
              {(hint) => <div class="model-select-empty">{hint()}</div>}
            </Show>
            <Show when={grouped().length === 0 && !typedModel() && !typedSelection().hint}>
              <div class="model-select-empty">Search models or type a model id</div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
