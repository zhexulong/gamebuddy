import { createResource, For, Show } from "solid-js";
import { getPrimerCandidates, getPrimers } from "../../lib/api";
import type { Primer, PrimerCandidate } from "../../lib/types";

function formatDate(ms: number | null): string {
  if (!ms) return "never";
  return new Date(ms).toLocaleDateString();
}

function truncateSessionId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function PrimerCandidateCard(props: { candidate: PrimerCandidate }) {
  return (
    <div class="card memory-card" style={{ "text-align": "left" }}>
      <div class="memory-card-body">
        <div class="card-title">{props.candidate.question}</div>
        <div class="card-meta">
          <span class="pill blue">candidate</span>
          <span class="pill" title="when this question was observed">
            seen {formatDate(props.candidate.source_message_time)}
          </span>
          <span title={props.candidate.session_id}>
            session: {truncateSessionId(props.candidate.session_id)}
          </span>
          <Show
            when={
              props.candidate.source_compartment_start && props.candidate.source_compartment_end
            }
          >
            <span style={{ color: "var(--text-muted)" }}>
              compartments: {props.candidate.source_compartment_start}–
              {props.candidate.source_compartment_end}
            </span>
          </Show>
        </div>
      </div>
    </div>
  );
}

function PrimerCard(props: { primer: Primer }) {
  return (
    <div class="card memory-card" style={{ "text-align": "left" }}>
      <div class="memory-card-body">
        <div class="card-title">{props.primer.question}</div>
        <div class="card-meta">
          <span class={`pill ${props.primer.status === "active" ? "green" : ""}`}>
            {props.primer.status}
          </span>
          <span class="pill">support {props.primer.total_support}</span>
          <span class="pill" title="last time this question recurred">
            seen {formatDate(props.primer.last_observed_at)}
          </span>
          <span class="pill" title="last answer refresh">
            refreshed {formatDate(props.primer.answer_refreshed_at)}
          </span>
        </div>
        <div
          style={{
            "margin-top": "10px",
            "white-space": "pre-wrap",
            color: "var(--text-secondary)",
            "font-size": "13px",
          }}
        >
          {props.primer.answer || "Answer not synthesized yet."}
        </div>
      </div>
    </div>
  );
}

interface PrimersProps {
  /** When set, list only this project's primers and let the ProjectDetail shell
   *  own the header (we render just the count + body). */
  project?: { identity: string; label: string };
}

export default function Primers(props: PrimersProps = {}) {
  const embedded = () => props.project != null;
  // Single-arg fetcher reads props.project reactively: re-runs if the locked
  // project changes, and works for the standalone (all-primers) case too.
  const [primers] = createResource(() => getPrimers(props.project?.identity));
  const [candidates] = createResource(() => getPrimerCandidates(props.project?.identity));

  return (
    <>
      <Show when={!embedded()}>
        <div class="section-header">
          <h1 class="section-title">Primers</h1>
          <div class="section-actions">
            <Show when={primers()}>
              <span style={{ "font-size": "12px", color: "var(--text-secondary)" }}>
                {(primers() ?? []).length} promoted
              </span>
            </Show>
          </div>
        </div>
      </Show>

      <div class="scroll-area">
        {/* Promoted primers */}
        <div class="list-gap">
          <div class="category-header">
            Promoted
            <span class="category-count">({(primers() ?? []).length})</span>
          </div>
          <Show when={!primers.loading} fallback={<div class="empty-state">Loading primers…</div>}>
            <Show
              when={(primers() ?? []).length > 0}
              fallback={
                <div class="empty-state">
                  <span class="empty-state-icon">❓</span>
                  <span>No primers promoted yet.</span>
                  <span style={{ "font-size": "12px", "margin-top": "4px" }}>
                    Durable standing questions about how this project works, surfaced as they recur
                    across days.
                  </span>
                </div>
              }
            >
              <For each={primers() ?? []}>{(primer) => <PrimerCard primer={primer} />}</For>
            </Show>
          </Show>
        </div>

        {/* Candidates: questions awaiting recurrence before promotion (read-only) */}
        <div class="list-gap">
          <div class="category-header">
            Candidates
            <span class="category-count">({(candidates() ?? []).length})</span>
          </div>
          <Show
            when={!candidates.loading}
            fallback={<div class="empty-state">Loading candidates…</div>}
          >
            <Show
              when={(candidates() ?? []).length > 0}
              fallback={
                <div class="empty-state">
                  <span class="empty-state-icon">📝</span>
                  <span>No pending candidates.</span>
                  <span style={{ "font-size": "12px", "margin-top": "4px" }}>
                    The historian records standing questions here; one is promoted to a primer once
                    it recurs on a later day.
                  </span>
                </div>
              }
            >
              <For each={candidates() ?? []}>
                {(candidate) => <PrimerCandidateCard candidate={candidate} />}
              </For>
            </Show>
          </Show>
        </div>
      </div>
    </>
  );
}
