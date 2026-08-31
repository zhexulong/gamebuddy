import { ask, checkTauriUpdate, isTauri, notify, relaunch, type TauriUpdate } from "./platform";

let cachedUpdate: TauriUpdate | null = null;

/**
 * Check if an update is available. Returns the version string if found, null otherwise.
 * Used by the background polling in App.tsx for the toast notification.
 */
export async function checkForUpdate(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const update = await checkTauriUpdate();
    if (update) {
      cachedUpdate = update;
      return update.version;
    }
  } catch {
    // Silent failure for background checks
  }
  return null;
}

/**
 * Download and install the cached update, then relaunch.
 * Called when user clicks "Install & Restart" in the toast.
 */
export async function installAndRelaunch(): Promise<void> {
  if (!isTauri()) {
    await notify(
      "Serve mode cannot install updates. Update via your package manager or re-download Magic Context Dashboard.",
      {
        title: "Update Magic Context Dashboard",
      },
    );
    return;
  }
  if (!cachedUpdate) return;
  try {
    await cachedUpdate.download();
    await cachedUpdate.install();
    await relaunch();
  } catch {
    // If install fails, user stays on current version
  }
}

/**
 * Run a full interactive update check with dialogs.
 * Called from "Check for Updates..." tray menu item.
 * Following OpenCode's pattern: check, download, ask, install, relaunch.
 */
export async function runUpdater({ alertOnFail }: { alertOnFail: boolean }) {
  if (!isTauri()) {
    if (alertOnFail) {
      await notify(
        "Serve mode cannot install updates. Update via your package manager or re-download Magic Context Dashboard.",
        {
          title: "Update Magic Context Dashboard",
        },
      );
    }
    return;
  }

  let update: TauriUpdate | null | undefined;
  try {
    update = await checkTauriUpdate();
  } catch {
    if (alertOnFail) {
      await notify("Failed to check for updates", { title: "Update Check Failed" });
    }
    return;
  }

  if (!update) {
    if (alertOnFail) {
      await notify("You are already using the latest version of Magic Context Dashboard", {
        title: "No Update Available",
      });
    }
    return;
  }

  try {
    await update.download();
  } catch {
    if (alertOnFail) {
      await notify("Failed to download update", { title: "Update Failed" });
    }
    return;
  }

  const shouldUpdate = await ask(
    `Magic Context Dashboard ${update.version} has been downloaded. Would you like to install and restart?`,
    { title: "Update Downloaded" },
  );
  if (!shouldUpdate) return;

  try {
    await update.install();
  } catch {
    await notify("Failed to install update", { title: "Update Failed" });
    return;
  }

  await relaunch();
}
