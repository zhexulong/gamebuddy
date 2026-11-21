// The Game surface's installation step, in one place: the panel's own typed state, and the press that
// registers the installation the Host then reports as `prerequisites: met`.
//
// WHY IT IS SHARED. Every driver that opens the game needs this step done before a launch is possible: the
// state drivers refuse with `game_installation_not_registered` otherwise, and a run that starts them without
// driver W (one driver per invocation, which is how a death and an endgame are measured separately) would
// have that refusal instead of a reading. It used to live inside `w-game-launch.cjs`, so the only way a
// lifecycle driver could get a registered installation was a W launch in the same run - measured on
// `frontend--r24`, where x, y and z found an instance W had launched and could not have launched one
// themselves.
//
// The rules below are W's, unchanged and paid for one at a time (the header of each says which run measured
// it); the only thing that moved is which caller reads the answer.
const {
  INSTALLATION_CONTROL,
  INSTALLATION_DISCOVERY_STATES,
  INSTALLATION_PANEL_SELECTOR,
} = require("./installation-panel.cjs");
const { waitForPanelSettled } = require("./common.cjs");

/** The installation panel's own typed state (`StardewInstallationDiscovery.tsx`). */
const readInstallationPanel = () => {
  const surface = document.querySelector('[data-testid="game-surface"]');
  const panel = surface === null ? null : surface.querySelector(".game-installation-panel");
  if (panel === null) return { present: false, surfacePresent: surface !== null, candidates: [] };
  const candidates = [...panel.querySelectorAll(".installation-candidate")].map((row) => {
    const button = row.querySelector("button");
    return {
      text: (row.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
      confirm:
        button === null
          ? null
          : {
              name: (button.getAttribute("aria-label") ?? button.textContent ?? "").replace(/\s+/g, " ").trim(),
              disabled: button.disabled === true,
            },
    };
  });
  return {
    present: true,
    surfacePresent: true,
    dataState: panel.getAttribute("data-state"),
    statusText: (panel.querySelector(".installation-state")?.textContent ?? "").trim(),
    candidates,
  };
};

/**
 * Register the installation the panel offers, or name why it could not be.
 *
 * `kind` is `already_registered` (the Host already reports `prerequisites: met`), `registered` (the press
 * took), `not_measured` (a prerequisite this machine or this panel owes, with a name) or `refused` (the
 * product answered the confirm route with a refusal, which the caller classifies through its own one rule).
 * `waitForState` is the caller's own bounded poll, so this module adds no second spelling of it.
 */
async function registerInstallation({ page, say, record, problems, waitForState, budgets, state }) {
  if (state?.ok === true && state.prerequisites === "met") {
    say("the installation was already registered for this run root");
    record("installation", { prerequisites: "met" });
    return { kind: "already_registered" };
  }
  /*
   * THE PANEL'S OWN RE-SCAN IS PART OF REGISTERING. A surface that meets the panel in a finished search
   * with no offer - `cancelled`, `expired`, `no-candidates`, `error`, `source-unavailable` - shows no
   * candidate and no scan of its own (`StardewInstallationDiscovery.tsx` only scans when it mounts with no
   * seeded answer), so waiting the budget out printed `no_installation_discovered`, which claimed this
   * machine has no Stardew Valley. Measured 2026-11-19: driver T drives the panel's 取消 to prove that
   * control, the Game surface re-mounts into `cancelled`, and W spent 90 s over "搜索已取消。" - a machine
   * with a registered-and-ready installation. The product publishes 重新查找 as the way out of every one of
   * those states, so the driver presses it, bounded by the same budget, and says which state it left.
   */
  let panel = await page.evaluate(readInstallationPanel);
  const panelBegan = Date.now();
  const remaining = () => budgets.discoveryMs - (Date.now() - panelBegan);
  const terminal = new Set(["no-candidates", "source-unavailable", "error", "cancelled", "expired"]);
  let rescans = 0;
  while (panel.present === true && remaining() > 0) {
    /*
     * THE PANEL'S OWN STATEMENT THAT IT HAS STOPPED WORKING, never a fixed tick.
     *
     * This loop used to continue on `!terminal.has(dataState)` with a blind 1000 ms sleep and stop at `panel
     * .candidates.length > 0` - and a candidate row is drawn WHILE a scan is outstanding (`showsCandidates` is
     * true for `retrying`, `confirming` and `cancelled`), so "a candidate exists" was never "the panel has
     * settled". `frontend--r13` read the first candidate in `retrying`, found its 确认 disabled (`scannerDisabled`
     * is `pending !== "none"`), reported `no_installation_discovered: the first candidate offered no enabled
     * confirm control` with `confirm requests: 0`, and x/y/z named the missing registration behind it - on a
     * machine that held a registered-and-ready installation.
     */
    const settledWait = await waitForPanelSettled(page, {
      name: "installation",
      panel: INSTALLATION_PANEL_SELECTOR,
      settledStates: INSTALLATION_DISCOVERY_STATES.settled,
      timeoutMs: Math.max(0, remaining()),
    }).catch((error) => ({ failure: String(error?.message ?? error).slice(0, 600) }));
    panel = await page.evaluate(readInstallationPanel);
    if (settledWait.failure !== undefined)
      return {
        kind: "not_measured",
        reason: "installation_panel_never_settled",
        detail: `${settledWait.failure}; the panel reads data-state=${JSON.stringify(panel.dataState)} with ${String(panel.candidates.length)} candidate row(s) after ${String(rescans)} re-scan press(es)`,
      };
    say(
      `the panel settled in data-state=${JSON.stringify(settledWait.state)} after ${String(settledWait.waitedMs)}ms (every state read while waiting: ${JSON.stringify(settledWait.observed)}), holding ${String(panel.candidates.length)} candidate row(s)`,
    );
    if (panel.candidates.length > 0) break;
    if (!terminal.has(panel.dataState)) break;
    const findAgain = page
      .locator(INSTALLATION_PANEL_SELECTOR)
      .getByRole("button", { name: new RegExp(`${INSTALLATION_CONTROL.findAgain.zh}|${INSTALLATION_CONTROL.findAgain.en}`, "u") })
      .first();
    if ((await findAgain.count()) === 0 || !(await findAgain.isEnabled().catch(() => false))) break;
    rescans += 1;
    say(
      `the panel sits in data-state=${JSON.stringify(panel.dataState)} (${JSON.stringify(panel.statusText)}); driving its own 重新查找, press ${rescans}`,
    );
    await findAgain.click();
    panel = await page.evaluate(readInstallationPanel);
  }
  record("installation panel", panel);
  if (panel.present !== true)
    return {
      kind: "not_measured",
      reason: "no_installation_panel",
      detail: "the Game surface painted no installation panel, so no registration control exists to drive",
    };
  if (panel.candidates.length === 0)
    return {
      kind: "not_measured",
      reason: "no_installation_discovered",
      detail: `the panel reached data-state=${JSON.stringify(panel.dataState)} with no candidate within ${String(budgets.discoveryMs)}ms after ${String(rescans)} re-scan press(es): ${JSON.stringify(panel.statusText)}`,
    };
  const first = panel.candidates[0];
  if (first.confirm === null || first.confirm.disabled)
    return {
      kind: "not_measured",
      reason: "no_installation_discovered",
      detail: `the first candidate offered no enabled confirm control: ${JSON.stringify(first)}`,
    };
  say(`confirming the first candidate: ${JSON.stringify(first.text)}`);
  /*
   * A press is not an admission. The page draws the confirm from `pending === "none"` and ignores a press
   * while a scan is outstanding, so a press the page did not take leaves no request and no answer - the
   * shape W met on 2026-11-19, where the facts carried no answer on the confirm route at all. The driver
   * reads the panel back and presses once more while it still offers an enabled confirm, and records what
   * the panel then says, so the next reader has the state instead of only "never met".
   */
  const pressConfirm = async () => {
    await page.locator(".game-installation-panel .installation-candidate button").first().click();
    return await waitForState((reading) => reading.ok === true && reading.prerequisites === "met", budgets.registrationMs);
  };
  let registration = await pressConfirm();
  if (!registration.settled) {
    const after = await page.evaluate(readInstallationPanel);
    record("installation panel after the press", after);
    const confirmable = after.present === true && after.candidates.length > 0 && after.candidates[0].confirm?.disabled === false;
    say(
      `the confirm produced no prerequisites=met within ${String(budgets.registrationMs)}ms; the panel now reads data-state=${JSON.stringify(after.dataState)}, confirm disabled=${String(after.candidates[0]?.confirm?.disabled ?? null)}`,
    );
    if (confirmable) registration = await pressConfirm();
  }
  record("registration", registration);
  if (registration.settled) return { kind: "registered" };
  const problem = problems?.get("game/installation/discovery/confirm") ?? null;
  if (problem !== null) return { kind: "refused", code: problem.code ?? null, cause: problem.cause ?? null };
  const after = await page.evaluate(readInstallationPanel);
  return {
    kind: "not_measured",
    reason: "installation_registration_refused",
    detail: `the Host never published prerequisites: met within ${String(budgets.registrationMs)}ms per press (last prerequisites=${String(registration.state?.prerequisites)}); the panel reads data-state=${JSON.stringify(after.dataState)}, status=${JSON.stringify(after.statusText)}, confirm=${JSON.stringify(after.candidates[0]?.confirm ?? null)}`,
  };
}

module.exports = { readInstallationPanel, registerInstallation };
