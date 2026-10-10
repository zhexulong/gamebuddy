import type { Locale } from "../i18n";

/**
 * The character domain's one vocabulary.
 *
 * The names here are the functional side's own names, not invented synonyms:
 * a character card contributes a `persona`, a `scenario`, `dialogue_examples`,
 * `lorebook` entries and an `opening`; the Host publishes exactly the stable
 * kinds `persona | scenario | dialogue_examples | lorebook_constant` plus
 * volatile `lorebook_entry`. There is deliberately no "greeting" kind on the
 * functional side - the first message a chat opens with is the opening
 * (`first_mes` / `alternate_greetings`), so the surface says "Opening".
 *
 * The strings live in this file (not `i18n.ts`, which a visual lane owns) and
 * are selected by the mount's own locale.
 */
export type CharacterLabels = Readonly<{
  unavailable: string;
  loading: string;
  saving: string;
  saved: string;
  saveFailed: string;
  discard: string;

  importTitle: string;
  importHint: string;
  importFileLabel: string;
  importChooseFile: string;
  importPasteLabel: string;
  importPasteHint: string;
  importSubmit: string;
  importBusy: string;
  importCreated: string;
  importCreatedDetail: string;
  importKept: string;
  importPreserved: string;
  importNotUsed: string;
  importAllUsed: string;
  importLongField: string;
  importFailed: string;
  importFailedPng: string;
  importFailedText: string;
  importFailedTooLarge: string;
  historyTitle: string;
  historyHint: string;
  historyEmpty: string;
  historyFailed: string;

  companionsTitle: string;
  companionsEmpty: string;
  companionCurrent: string;
  newCompanionTitle: string;
  newCompanionHint: string;
  newCompanionCreate: string;

  personaTitle: string;
  personaHint: string;
  personaName: string;
  personaDescription: string;
  personaAbsent: string;
  personaPresent: string;
  personaSave: string;

  scenarioTitle: string;
  scenarioHint: string;
  scenarioName: string;
  scenarioDescription: string;
  scenarioAbsent: string;
  scenarioSave: string;

  openingTitle: string;
  openingHint: string;
  openingLabel: string;
  openingVariantText: string;
  openingAdd: string;
  openingAbsent: string;
  openingSave: string;

  worldBookTitle: string;
  worldBookHint: string;
  worldBookAttach: string;
  worldBookDetach: string;
  worldBookEmpty: string;
  worldBookPending: string;
  worldBookUnavailable: string;
  worldBookFailed: string;

  /** The decoder's own disposition classes, in player words. */
  dispositionAccepted: string;
  dispositionPreserved: string;
  dispositionDropped: string;
  dispositionRejected: string;
}>;

const en: CharacterLabels = Object.freeze({
  unavailable: "Character management is unavailable in this profile.",
  loading: "Loading…",
  saving: "Saving…",
  saved: "Saved.",
  saveFailed: "Could not save. The content changed elsewhere; reload and retry.",
  discard: "Discard",

  importTitle: "Import a character card",
  importHint:
    "Choose a character card file (.json or .png). You can also paste the card text below. The file is read in your browser and stays on this machine.",
  importFileLabel: "Character card file",
  importChooseFile: "Choose card file",
  importPasteLabel: "Paste card text",
  importPasteHint: "SillyTavern V2/V3 JSON.",
  importSubmit: "Import card",
  importBusy: "Importing…",
  importCreated: "Imported {{name}}.",
  importCreatedDetail: "It is now a companion you can chat with.",
  importKept: "Kept {{count}} card fields.",
  importPreserved: "Kept {{count}} fields unchanged.",
  importNotUsed: "Could not use: {{fields}}.",
  importAllUsed: "Every card field was usable.",
  importLongField: "This description is long ({{chars}} chars); it may raise per-turn token use.",
  importFailed: "The card could not be imported.",
  importFailedPng: "That PNG does not contain a character card.",
  importFailedText: "That file is not readable character card text.",
  importFailedTooLarge: "That file is too large to import (limit 2 MB).",
  historyTitle: "Imported cards",
  historyHint: "Every imported card and what it kept or dropped.",
  historyEmpty: "No cards imported yet.",
  historyFailed: "The import history could not be read.",

  companionsTitle: "Companions",
  companionsEmpty: "No companions yet.",
  companionCurrent: "current",
  newCompanionTitle: "New companion",
  newCompanionHint: "A display name only; GameBuddy mints every identity.",
  newCompanionCreate: "Create companion",

  personaTitle: "Persona",
  personaHint: "How your companion sees you.",
  personaName: "Your display name",
  personaDescription: "Persona description",
  personaAbsent: "No persona saved yet.",
  personaPresent: "Saved",
  personaSave: "Save persona",

  scenarioTitle: "Scenario",
  scenarioHint: "The setting your companion assumes.",
  scenarioName: "Scenario name",
  scenarioDescription: "Scenario",
  scenarioAbsent: "No scenario saved yet.",
  scenarioSave: "Save scenario",

  openingTitle: "Opening",
  openingHint: "The first message this character can open a chat with. You choose one when a chat starts.",
  openingLabel: "Opening label",
  openingVariantText: "Opening text",
  openingAdd: "Add opening",
  openingAbsent: "No opening saved yet.",
  openingSave: "Save opening",

  worldBookTitle: "World book",
  worldBookHint: "The lorebook this character's chat reads from.",
  worldBookAttach: "Attach",
  worldBookDetach: "Detach",
  worldBookEmpty: "No world books are available yet.",
  worldBookPending: "Saved. It fully applies on the next turn.",
  worldBookUnavailable: "The world book is temporarily unavailable.",
  worldBookFailed: "The world book could not be updated.",

  dispositionAccepted: "used",
  dispositionPreserved: "kept unchanged",
  dispositionDropped: "not used",
  dispositionRejected: "rejected",
});

const zh: CharacterLabels = Object.freeze({
  unavailable: "当前配置不支持角色管理。",
  loading: "加载中…",
  saving: "保存中…",
  saved: "已保存。",
  saveFailed: "无法保存。内容已在其他位置更改；请重新加载后再试。",
  discard: "丢弃",

  importTitle: "导入角色卡",
  importHint:
    "选择角色卡文件（.json 或 .png）。也可以在下方粘贴角色卡文本。文件在你的浏览器中读取，不会离开本机。",
  importFileLabel: "角色卡文件",
  importChooseFile: "选择角色卡文件",
  importPasteLabel: "粘贴角色卡文本",
  importPasteHint: "SillyTavern V2/V3 JSON。",
  importSubmit: "导入角色卡",
  importBusy: "正在导入…",
  importCreated: "已导入 {{name}}。",
  importCreatedDetail: "它现在是一个可以聊天的伙伴。",
  importKept: "已保留 {{count}} 个卡片字段。",
  importPreserved: "有 {{count}} 个字段原样保留。",
  importNotUsed: "无法使用：{{fields}}。",
  importAllUsed: "卡片的所有字段均可使用。",
  importLongField: "该描述较长（{{chars}} 字符），可能会增加每轮 Token 消耗。",
  importFailed: "无法导入该角色卡。",
  importFailedPng: "该 PNG 不包含角色卡数据。",
  importFailedText: "该文件不是可读取的角色卡文本。",
  importFailedTooLarge: "该文件过大，无法导入（上限 2 MB）。",
  historyTitle: "已导入的角色卡",
  historyHint: "每次导入的角色卡，以及保留或丢弃的内容。",
  historyEmpty: "暂无已导入的角色卡。",
  historyFailed: "无法读取导入历史。",

  companionsTitle: "伙伴",
  companionsEmpty: "还没有伙伴。",
  companionCurrent: "当前",
  newCompanionTitle: "新建伙伴",
  newCompanionHint: "只需填写显示名称；所有身份由 GameBuddy 铸造。",
  newCompanionCreate: "创建伙伴",

  personaTitle: "用户设定 (Persona)",
  personaHint: "你希望伙伴如何认识你。",
  personaName: "你的显示名称",
  personaDescription: "用户设定描述",
  personaAbsent: "还没有保存用户设定。",
  personaPresent: "已设置",
  personaSave: "保存用户设定",

  scenarioTitle: "场景",
  scenarioHint: "伙伴所假设的情境。",
  scenarioName: "场景名称",
  scenarioDescription: "场景文本",
  scenarioAbsent: "还没有保存场景。",
  scenarioSave: "保存场景",

  openingTitle: "开场白",
  openingHint: "该角色用于开始对话的第一句话；开始新对话时你可以选择其中一个。",
  openingLabel: "开场白标签",
  openingVariantText: "开场白文本",
  openingAdd: "添加开场白",
  openingAbsent: "还没有保存开场白。",
  openingSave: "保存开场白",

  worldBookTitle: "世界书",
  worldBookHint: "该角色的对话所读取的世界书。",
  worldBookAttach: "关联",
  worldBookDetach: "解除关联",
  worldBookEmpty: "暂时没有可用的世界书。",
  worldBookPending: "已保存，将在下一回合完全生效。",
  worldBookUnavailable: "世界书暂时不可用。",
  worldBookFailed: "无法更新世界书。",

  dispositionAccepted: "已使用",
  dispositionPreserved: "原样保留",
  dispositionDropped: "未使用",
  dispositionRejected: "已拒绝",
});

export function characterLabels(locale: Locale): CharacterLabels {
  return locale === "zh-CN" ? zh : en;
}
