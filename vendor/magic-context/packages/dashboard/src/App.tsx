import { createResource, createSignal, ErrorBoundary, onCleanup, onMount, Show } from "solid-js";
import CacheDiagnostics from "./components/CacheDiagnostics/CacheDiagnostics";
import ConfigEditor from "./components/ConfigEditor/ConfigEditor";
import Sidebar from "./components/Layout/Sidebar";
import StatusBar from "./components/Layout/StatusBar";
import LogViewer from "./components/LogViewer/LogViewer";
import ProjectDetail from "./components/Projects/ProjectDetail";
import ProjectsGrid from "./components/Projects/ProjectsGrid";
import UserMemories from "./components/UserMemories/UserMemories";
import WorkspacesPanel from "./components/WorkspacesPanel/WorkspacesPanel";
import { getDbHealth, getModelCatalogs, getOpencodeInstallState } from "./lib/api";
import { initServeToken, listen } from "./lib/platform";
import type { ModelCatalogs, NavSection, OpencodeInstallState, ProjectCard } from "./lib/types";
import { checkForUpdate, installAndRelaunch, runUpdater } from "./lib/updater";

const MODEL_CATALOGS_CACHE_KEY = "magic-context.model-catalogs";
const UPDATE_POLL_INTERVAL = 10 * 60 * 1000; // 10 minutes

function loadCachedModelCatalogs(): ModelCatalogs {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MODEL_CATALOGS_CACHE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return { opencode: [], pi: [] };
    const catalogs = parsed as Partial<ModelCatalogs>;
    return {
      opencode: Array.isArray(catalogs.opencode) ? catalogs.opencode : [],
      pi: Array.isArray(catalogs.pi) ? catalogs.pi : [],
    };
  } catch {
    return { opencode: [], pi: [] };
  }
}

export default function App() {
  initServeToken();

  const [activeSection, setActiveSection] = createSignal<NavSection>("projects");
  // Projects drill-down: null = card grid, set = that project's detail view.
  const [selectedProject, setSelectedProject] = createSignal<ProjectCard | null>(null);
  const navigate = (section: NavSection) => {
    // Leaving and re-entering Projects always returns to the grid.
    if (section === "projects") setSelectedProject(null);
    setActiveSection(section);
  };
  const [health] = createResource(getDbHealth);
  const [modelCatalogs, setModelCatalogs] = createSignal<ModelCatalogs>(loadCachedModelCatalogs());
  const [opencodeInstallState, setOpencodeInstallState] =
    createSignal<OpencodeInstallState>("none");
  const [updateVersion, setUpdateVersion] = createSignal<string | null>(null);
  const [updateInstalling, setUpdateInstalling] = createSignal(false);
  const [updateDismissed, setUpdateDismissed] = createSignal(false);

  // Background model refresh
  onMount(() => {
    getOpencodeInstallState()
      .then(setOpencodeInstallState)
      .catch(() => {
        setOpencodeInstallState("none");
      });

    getModelCatalogs()
      .then((fresh) => {
        setModelCatalogs(fresh);
        try {
          localStorage.setItem(MODEL_CATALOGS_CACHE_KEY, JSON.stringify(fresh));
        } catch {}
      })
      .catch(() => {
        /* keep cached */
      });
  });

  // Background update polling
  let updateInterval: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    const poll = () => {
      if (updateVersion()) return; // already found
      checkForUpdate().then((version) => {
        if (version) setUpdateVersion(version);
      });
    };
    // Check immediately, then every 10 minutes
    poll();
    updateInterval = setInterval(poll, UPDATE_POLL_INTERVAL);
  });
  onCleanup(() => {
    if (updateInterval) clearInterval(updateInterval);
  });

  // Listen for "Check for Updates" tray menu event
  let unlistenUpdate: (() => void) | undefined;
  onMount(() => {
    listen("check-for-updates", () => {
      runUpdater({ alertOnFail: true });
    }).then((unlisten) => {
      unlistenUpdate = unlisten;
    });
  });
  onCleanup(() => {
    unlistenUpdate?.();
  });

  const handleInstall = async () => {
    setUpdateInstalling(true);
    await installAndRelaunch();
    // If relaunch fails, reset state
    setUpdateInstalling(false);
  };

  return (
    <div class="app-shell">
      <Sidebar active={activeSection()} onNavigate={navigate} />

      <main class="content">
        {/* Update toast */}
        <Show when={updateVersion() && !updateDismissed()}>
          <div class="update-toast">
            <div class="update-toast-content">
              <span class="update-toast-icon">⬆</span>
              <div class="update-toast-text">
                <strong>Update available</strong>
                <span>v{updateVersion()} is ready to install</span>
              </div>
            </div>
            <div class="update-toast-actions">
              <button
                type="button"
                class="btn primary sm"
                disabled={updateInstalling()}
                onClick={handleInstall}
              >
                {updateInstalling() ? "Installing..." : "Install & Restart"}
              </button>
              <button type="button" class="btn sm" onClick={() => setUpdateDismissed(true)}>
                Later
              </button>
            </div>
          </div>
        </Show>

        <ErrorBoundary
          fallback={(err, reset) => (
            <div class="error-boundary">
              <h2>Something went wrong</h2>
              <p>{err?.message || "An unexpected error occurred"}</p>
              <button type="button" class="btn primary" onClick={reset}>
                Try Again
              </button>
            </div>
          )}
        >
          <Show when={activeSection() === "projects"}>
            <Show
              when={selectedProject()}
              fallback={<ProjectsGrid onSelect={setSelectedProject} />}
            >
              {(project) => (
                <ProjectDetail project={project()} onBack={() => setSelectedProject(null)} />
              )}
            </Show>
          </Show>
          <Show when={activeSection() === "cache"}>
            <CacheDiagnostics />
          </Show>
          <Show when={activeSection() === "workspaces"}>
            <WorkspacesPanel />
          </Show>
          <Show when={activeSection() === "user-memories"}>
            <UserMemories />
          </Show>
          <Show when={activeSection() === "config"}>
            <ConfigEditor
              modelCatalogs={modelCatalogs()}
              opencodeInstallState={opencodeInstallState()}
            />
          </Show>
          <Show when={activeSection() === "logs"}>
            <LogViewer />
          </Show>
        </ErrorBoundary>
      </main>

      <StatusBar health={health()} />
    </div>
  );
}
