/**
 * The installation panel's own vocabulary, in one copy for the two drivers that drive it.
 *
 * `t-installation-discovery` reads the sentence each state must produce and presses every control;
 * `w-game-launch` registers the installation before it launches anything. They used to spell the panel's
 * control names separately; the labels are `gameInstallationChooseFolder` / `gameInstallationFindAgain` /
 * `gameInstallationConfirm` / `gameResumeCancel` in `i18n.ts`, and one copy of them is what keeps a press
 * on the product's own control rather than on a guess.
 */
const INSTALLATION_CONTROL = Object.freeze({
  chooseFolder: Object.freeze({ zh: "选择游戏文件夹", en: "Choose game folder" }),
  findAgain: Object.freeze({ zh: "重新查找", en: "Find again" }),
  confirm: Object.freeze({ zh: "确认", en: "Confirm" }),
  cancel: Object.freeze({ zh: "取消", en: "Cancel" }),
});

/**
 * The panel's typed state, split into the members it publishes while it is WORKING and the ones that are a
 * settled answer.
 *
 * The population is `InstallationDiscoveryState` (`dialogue-web/src/game-presentation.ts:149`), which the panel
 * renders as its `data-state` (`StardewInstallationDiscovery.tsx:304`), and the split is read off the component's
 * own setters: `loading` is what `read()` sets before it awaits a scan, `confirming` and `retrying` are what
 * `action("confirm")` and `action("retry")` set before they await the Host. Every other member is a state the
 * panel reaches when nothing of its own is outstanding - the scan's answer (`installationDiscoveryState`), a
 * failure (`installationDiscoveryFailureState`), a selection answer (`installationSelectionState`), the
 * registration (`confirmed`), or the player's own 取消 (`cancelled`).
 *
 * `all` is the union in its own declaration order, because the skip report's population is "every state this
 * machine's run could have produced" and a hand-written subset of that list silently stops covering a state the
 * product adds. `wait-for-panel.test.mjs` holds both halves against the union parsed from the product, so a state
 * added there fails by name here instead of quietly leaving the drivers' set behind.
 */
const INSTALLATION_DISCOVERY_STATES = Object.freeze({
  all: Object.freeze([
    "not_configured",
    "loading",
    "candidates",
    "confirming",
    "retrying",
    "cancelled",
    "source-unavailable",
    "no-candidates",
    "install-cannot-load-mods",
    "result-unavailable",
    "mod-loader-missing",
    "not-stardew-installation",
    "reparse-point",
    "selection-unavailable",
    "expired",
    "confirmed",
    "error",
  ]),
  working: Object.freeze(["loading", "confirming", "retrying"]),
  settled: Object.freeze([
    "not_configured",
    "candidates",
    "cancelled",
    "source-unavailable",
    "no-candidates",
    "install-cannot-load-mods",
    "result-unavailable",
    "mod-loader-missing",
    "not-stardew-installation",
    "reparse-point",
    "selection-unavailable",
    "expired",
    "confirmed",
    "error",
  ]),
});

/**
 * The states 取消 can settle ON, for a caller that waits for the press rather than for the panel to rest.
 *
 * A cancel retires the scan it interrupts, so the panel states its own answer (`cancelled`); a cancel the Host
 * refuses reaches the panel as `installationDiscoveryFailureState(code)`, which is one of the three failures
 * below. The panel leaves `data-state` untouched while the request is outstanding - the press shows on its
 * controls instead - so waiting for "any settled state" would read the state the press started from.
 */
const INSTALLATION_CANCEL_STATES = Object.freeze(["cancelled", "source-unavailable", "result-unavailable", "error"]);

/** The panel's root, as both drivers select it inside the Game surface. */
const INSTALLATION_PANEL_SELECTOR = ".game-installation-panel";

module.exports = {
  INSTALLATION_CONTROL,
  INSTALLATION_DISCOVERY_STATES,
  INSTALLATION_CANCEL_STATES,
  INSTALLATION_PANEL_SELECTOR,
};
