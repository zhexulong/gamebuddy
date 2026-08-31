import { createSignal, For, Show } from "solid-js";
import type { ProjectCard, ProjectTab } from "../../lib/types";
import DreamerPanel from "../DreamerPanel/DreamerPanel";
import HarnessBadge from "../HarnessBadge";
import MemoryBrowser from "../MemoryBrowser/MemoryBrowser";
import Primers from "../Primers/Primers";
import SessionViewer from "../SessionViewer/SessionViewer";

interface Props {
  project: ProjectCard;
  onBack: () => void;
}

const TABS: { id: ProjectTab; label: string }[] = [
  { id: "sessions", label: "Sessions" },
  { id: "memories", label: "Memories" },
  { id: "dreamer", label: "Dreamer" },
  { id: "primers", label: "Primers" },
];

/** A project's detail view: a breadcrumb header + tab bar, with each tab the
 *  existing top-level component locked to this project. */
export default function ProjectDetail(props: Props) {
  const [tab, setTab] = createSignal<ProjectTab>("sessions");
  // When a session is open inside the Sessions tab, hide this shell's
  // breadcrumb+tabs so the session view takes the whole page (it brings its own
  // back button + title — otherwise there are two headers and two back buttons).
  const [sessionActive, setSessionActive] = createSignal(false);
  const lockedProject = () => ({
    identity: props.project.identity,
    label: props.project.display_name,
  });

  return (
    <>
      <Show when={!sessionActive()}>
        <div class="project-detail-bar">
          <button type="button" class="btn sm" onClick={props.onBack} title="Back to projects">
            ←
          </button>
          <span
            class="project-detail-title"
            title={props.project.primary_path || props.project.identity}
          >
            {props.project.display_name}
          </span>
          <For each={props.project.harnesses}>{(h) => <HarnessBadge harness={h} />}</For>
          <Show when={props.project.workspace_name}>
            <span class="pill indigo" title="workspace">
              🗂 {props.project.workspace_name}
            </span>
          </Show>
          <div class="project-detail-tabs">
            <For each={TABS}>
              {(t) => (
                <button
                  type="button"
                  class={`project-tab ${tab() === t.id ? "active" : ""}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>

      <div class="project-detail-body">
        <Show when={tab() === "sessions"}>
          <SessionViewer project={lockedProject()} onSessionActiveChange={setSessionActive} />
        </Show>
        <Show when={tab() === "memories"}>
          <MemoryBrowser project={lockedProject()} />
        </Show>
        <Show when={tab() === "dreamer"}>
          <DreamerPanel project={lockedProject()} />
        </Show>
        <Show when={tab() === "primers"}>
          <Primers project={lockedProject()} />
        </Show>
      </div>
    </>
  );
}
