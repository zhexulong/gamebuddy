import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { formatDateTime, formatRelativeTime, getProjectCards } from "../../lib/api";
import type { ProjectCard } from "../../lib/types";
import HarnessBadge from "../HarnessBadge";

interface Props {
  onSelect: (project: ProjectCard) => void;
}

/** Top-level Projects view: a searchable card grid sorted by last activity. Each
 *  card drills into the project's detail (sessions / memories / dreamer / primers). */
export default function ProjectsGrid(props: Props) {
  const [cards, { refetch }] = createResource(getProjectCards);
  const [search, setSearch] = createSignal("");

  const filtered = createMemo<ProjectCard[]>(() => {
    const all = cards() ?? [];
    const q = search().trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (c) =>
        c.display_name.toLowerCase().includes(q) ||
        c.primary_path.toLowerCase().includes(q) ||
        c.identity.toLowerCase().includes(q) ||
        (c.workspace_name ?? "").toLowerCase().includes(q),
    );
  });

  return (
    <>
      <div class="section-header">
        <h1 class="section-title">Projects</h1>
        <div class="section-actions">
          <Show when={cards()}>
            <span style={{ "font-size": "12px", color: "var(--text-secondary)" }}>
              {(cards() ?? []).length} tracked
            </span>
          </Show>
          <button type="button" class="btn sm" onClick={() => refetch()}>
            ↻ Refresh
          </button>
        </div>
      </div>

      <div style={{ padding: "0 20px 12px" }}>
        <input
          class="search-input"
          type="text"
          placeholder="Search projects…"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
          style={{ width: "100%" }}
        />
      </div>

      <div class="scroll-area">
        <Show when={!cards.loading} fallback={<div class="empty-state">Loading projects…</div>}>
          <Show
            when={filtered().length > 0}
            fallback={
              <div class="empty-state">
                <span class="empty-state-icon">📁</span>
                <span>{search() ? "No projects match your search." : "No projects yet."}</span>
              </div>
            }
          >
            <div class="project-card-grid">
              <For each={filtered()}>
                {(card) => (
                  <button
                    type="button"
                    class="card project-card"
                    onClick={() => props.onSelect(card)}
                  >
                    <div class="project-card-head">
                      <span class="project-card-name" title={card.primary_path || card.identity}>
                        {card.display_name}
                      </span>
                      <Show when={card.harnesses.length > 0}>
                        <span class="project-card-harnesses">
                          <For each={card.harnesses}>{(h) => <HarnessBadge harness={h} />}</For>
                        </span>
                      </Show>
                    </div>

                    <Show when={card.workspace_name}>
                      <div class="project-card-workspace">
                        <span class="pill indigo" title="workspace">
                          🗂 {card.workspace_name}
                        </span>
                      </div>
                    </Show>

                    <div class="project-card-stats">
                      <span class="project-card-stat">
                        <strong>{card.session_count}</strong> session
                        {card.session_count === 1 ? "" : "s"}
                      </span>
                      <span class="project-card-stat">
                        <strong>{card.memory_count}</strong> memor
                        {card.memory_count === 1 ? "y" : "ies"}
                      </span>
                    </div>

                    <div
                      class="project-card-active"
                      title={card.last_activity_ms ? formatDateTime(card.last_activity_ms) : ""}
                    >
                      {card.last_activity_ms
                        ? `active ${formatRelativeTime(card.last_activity_ms)}`
                        : "no activity"}
                    </div>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </>
  );
}
