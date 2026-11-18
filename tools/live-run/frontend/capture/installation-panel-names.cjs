/**
 * The installation panel's own accessible names for its controls, in both locales.
 *
 * Two drivers drive this panel: `t-installation-discovery` reads the sentence each state must produce and
 * presses every control, and `w-game-launch` registers the installation before it launches anything. They
 * used to spell the names separately; the panel's labels are `gameInstallationChooseFolder` /
 * `gameInstallationFindAgain` / `gameInstallationConfirm` / `gameResumeCancel` in `i18n.ts`, and one copy of
 * them is what keeps a press on the product's own control rather than on a guess.
 */
const INSTALLATION_CONTROL = Object.freeze({
  chooseFolder: Object.freeze({ zh: "选择游戏文件夹", en: "Choose game folder" }),
  findAgain: Object.freeze({ zh: "重新查找", en: "Find again" }),
  confirm: Object.freeze({ zh: "确认", en: "Confirm" }),
  cancel: Object.freeze({ zh: "取消", en: "Cancel" }),
});

module.exports = { INSTALLATION_CONTROL };
