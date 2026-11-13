/**
 * A mounted probe for the Memory panel's notebook card.
 *
 * The panel's states cannot all be reached through the shipped shell: `memory.read` either answers
 * (ready or empty) or refuses (unavailable, error), and the panel starts at `loading`, so the one
 * state that says "nobody has read the notebook" is unreachable from the page a player runs. That is
 * exactly the state a count of zero was being printed for, so it needs a mount of its own.
 *
 * This file is a test fixture, not product code: the Vite dev server serves it for the spec beside it,
 * and nothing in the shell imports it.
 */
import { useEffect, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryPanel, type MemoryView } from "../src/components/management-panels";
import { SurfaceDrafts } from "../src/components/surface-drafts";
import { messages } from "../src/i18n";
import type { MemoryItemV1 } from "../src/management-pipeline-api";

const REVISION = "R".repeat(43);

/** Two rows with both categories and both origins, so a ready notebook renders its list. */
const ROWS: readonly MemoryItemV1[] = [
  {
    handle: `${"A".repeat(42)}A`,
    title: "The greenhouse",
    content: "She keeps the seedlings by the south window.",
    category: "interaction",
    status: "active",
    origin: "companion",
    pinned: false,
  },
  {
    handle: `${"B".repeat(42)}A`,
    title: "Call me Ada",
    content: "The player asked to be called Ada.",
    category: "semantic",
    status: "permanent",
    origin: "player",
    pinned: true,
  },
];

const VIEWS: Readonly<Record<string, MemoryView>> = {
  idle: { kind: "idle" },
  loading: { kind: "loading" },
  unavailable: { kind: "unavailable" },
  error: { kind: "error" },
  empty: { kind: "empty", projectionRevision: REVISION, chapters: [] },
  ready: { kind: "ready", projectionRevision: REVISION, chapters: [], rows: ROWS },
};

let show: (name: string) => void = () => {};

function Probe(): ReactElement {
  const [name, setName] = useState("idle");
  useEffect(() => {
    show = setName;
  }, []);
  return (
    <MemoryPanel
      memoryView={VIEWS[name] ?? VIEWS.idle!}
      labels={messages("en")}
      locale="en"
      onRefresh={() => {}}
      mutationAvailable={false}
      onMutate={async () => ({ kind: "saved" })}
    />
  );
}

const probe = {
  /** The states this probe can mount, so a spec iterates them instead of listing them again. */
  views: Object.keys(VIEWS),
  mount(name: string): void {
    if (!(name in VIEWS)) throw new Error(`the probe has no ${name} view`);
    show(name);
  },
};

(window as unknown as { memoryProbe: typeof probe }).memoryProbe = probe;

createRoot(document.getElementById("probe-root")!).render(
  // The shell's own draft store, mounted for the same reason the product mounts it: the panel's
  // authoring form and chapter editor read from it, and without the provider they throw.
  <SurfaceDrafts>
    <Probe />
  </SurfaceDrafts>,
);
